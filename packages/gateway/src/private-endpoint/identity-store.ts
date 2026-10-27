import { createHash, createPublicKey } from "node:crypto";
import { isAccountStepUpPermitId, isPairingPeerIdentity, type AccountActionTarget, type AccountAuthorityBinding, type PairingPeerIdentity } from "@meshrix/contracts/account";
import type { AuthenticatedContext } from "@meshrix/contracts/gateway";
import {
  PRIVATE_RELAY_MODES,
  PRIVATE_RELAY_ROLES,
  parseEndpointTrustBinding,
  peerIdForRouteDevice
} from "@meshrix/contracts/private-relay";

/**
 * Endpoint-side trust and device admission state.
 *
 * This store is the endpoint identity owner: paired devices, their trust
 * bindings, the per-route revocation countersign and the recovery authority
 * records. Trust always derives from the pinned paired key and current
 * generation — never from a product name, a relay-selected identifier, or a
 * recovered snapshot's stale contents.
 */
export interface EndpointDeviceRecord {
  readonly deviceId: string;
  readonly routeId: string;
  readonly tenantId: string;
  readonly role: string;
  readonly mode: string;
  readonly pairedIdentityKey: string;
  readonly pairedIdentityFingerprint: string;
  readonly principalRef: string;
  readonly capabilityGrantRef: string;
  readonly boundRecoveryKeyId: string | null;
  readonly trustGeneration: number;
  readonly admissionGeneration: number;
  readonly revoked: boolean;
  /** Present only after account authority approves this device. */
  readonly accountBinding?: AccountAuthorityBinding;
  readonly accountScopes?: readonly string[];
  readonly accountGrants?: readonly { readonly grantRef: string; readonly scopes: readonly string[] }[];
  /** Signal public identity received in the signed, invite-pinned pairing. */
  readonly entryPeerIdentity?: PairingPeerIdentity | null;
}

export interface RecoveryAuthorityRecord {
  readonly recoveryKeyId: string;
  readonly principalRef: string;
  readonly publicKey: string;
  readonly generation: number;
  readonly state: "active" | "rotating" | "revoked" | "superseded";
  readonly accountBinding?: AccountAuthorityBinding;
}

export interface EndpointInvitationRecord {
  readonly inviteId: string;
  /** Hash of the one-time pairing bearer; the bearer itself is never persisted. */
  readonly tokenDigest: string;
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPinRef: string;
  readonly mode: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedByOperationId: string | null;
}

export interface EndpointPairingOperationRecord {
  readonly bootstrapId: string;
  readonly entrySessionId: string;
  readonly inviteId: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly account: AccountAuthorityBinding;
  readonly target: AccountActionTarget;
  readonly expiresAt: string;
  readonly operationId?: string;
  readonly permitId?: string;
  readonly state: "challenged" | "authorized" | "enrolled" | "revoked";
  readonly capabilityGrantRef?: string;
  readonly entryPeerIdentity?: PairingPeerIdentity | null;
  readonly endpointPeerIdentity?: PairingPeerIdentity | null;
}

export interface EndpointGrantOperationRecord {
  readonly operationId: string;
  readonly account: AccountAuthorityBinding;
  readonly deviceId: string;
  readonly target: AccountActionTarget;
  readonly expiresAt: string;
  readonly state: "issued" | "authorized" | "revoked";
}

export interface EndpointIdentityDurablePort {
  loadDevices?(): readonly EndpointDeviceRecord[];
  loadRecoveryAuthorities?(): readonly RecoveryAuthorityRecord[];
  loadInvitations?(): readonly EndpointInvitationRecord[];
  loadPairingOperations?(): readonly EndpointPairingOperationRecord[];
  loadGrantOperations?(): readonly EndpointGrantOperationRecord[];
  saveDevice?(record: EndpointDeviceRecord): void;
  saveRecoveryAuthority?(record: RecoveryAuthorityRecord): void;
  loadRevocationRevision?(tenantId: string): number | undefined;
  loadRevocationRevisions?(): Readonly<Record<string, number>>;
  saveRevocationRevision?(tenantId: string, revision: number): void;
  saveState?(state: {
    readonly devices: readonly EndpointDeviceRecord[];
    readonly recoveryAuthorities: readonly RecoveryAuthorityRecord[];
    readonly invitations: readonly EndpointInvitationRecord[];
    readonly pairingOperations: readonly EndpointPairingOperationRecord[];
    readonly grantOperations: readonly EndpointGrantOperationRecord[];
    readonly revocationRevisions: Readonly<Record<string, number>>;
  }): void;
  saveInvitation?(record: EndpointInvitationRecord): void;
  savePairingOperation?(record: EndpointPairingOperationRecord): void;
}

export interface EndpointAdmissionDecision {
  readonly admitted: boolean;
  readonly refusal?: "ambiguous_identity" | "cross_tenant" | "mode_mismatch" | "role_mismatch" | "stale_generation" | "stale_revocation_revision" | "revoked" | "unknown_device";
  readonly device?: EndpointDeviceRecord;
}

export class EndpointIdentityStore {
  readonly #devices = new Map<string, EndpointDeviceRecord>();
  readonly #byFingerprint = new Map<string, string>();
  readonly #recoveryAuthorities = new Map<string, RecoveryAuthorityRecord>();
  readonly #invitations = new Map<string, EndpointInvitationRecord>();
  readonly #pairingOperations = new Map<string, EndpointPairingOperationRecord>();
  readonly #grantOperations = new Map<string, EndpointGrantOperationRecord>();
  readonly #revocationRevisions = new Map<string, number>();
  readonly #durable?: EndpointIdentityDurablePort;

  constructor(durable?: EndpointIdentityDurablePort) {
    this.#durable = durable;
    for (const device of durable?.loadDevices?.() ?? []) {
      this.#devices.set(device.deviceId, device);
      this.#byFingerprint.set(device.pairedIdentityFingerprint, device.deviceId);
    }
    for (const authority of durable?.loadRecoveryAuthorities?.() ?? []) {
      this.#recoveryAuthorities.set(authority.recoveryKeyId, authority);
    }
    for (const invite of durable?.loadInvitations?.() ?? []) this.#invitations.set(invite.inviteId, invite);
    for (const operation of durable?.loadPairingOperations?.() ?? []) this.#pairingOperations.set(operation.bootstrapId, operation);
    for (const operation of durable?.loadGrantOperations?.() ?? []) this.#grantOperations.set(operation.operationId, operation);
    for (const [tenantId, revision] of Object.entries(durable?.loadRevocationRevisions?.() ?? {})) {
      if (Number.isSafeInteger(revision) && revision >= 0) this.#revocationRevisions.set(tenantId, revision);
    }
  }

  #persist(): void {
    if (this.#durable?.saveState) {
      this.#durable.saveState({
        devices: [...this.#devices.values()],
        recoveryAuthorities: [...this.#recoveryAuthorities.values()],
        invitations: [...this.#invitations.values()],
        pairingOperations: [...this.#pairingOperations.values()],
        grantOperations: [...this.#grantOperations.values()],
        revocationRevisions: Object.freeze(Object.fromEntries(this.#revocationRevisions))
      });
      return;
    }
    for (const record of this.#devices.values()) this.#durable?.saveDevice?.(record);
    for (const record of this.#recoveryAuthorities.values()) this.#durable?.saveRecoveryAuthority?.(record);
    for (const record of this.#invitations.values()) this.#durable?.saveInvitation?.(record);
    for (const record of this.#pairingOperations.values()) this.#durable?.savePairingOperation?.(record);
    for (const [tenantId, revision] of this.#revocationRevisions) this.#durable?.saveRevocationRevision?.(tenantId, revision);
  }

  revocationRevision(tenantId: string): number {
    return this.#revocationRevisions.get(tenantId)
      ?? this.#durable?.loadRevocationRevision?.(tenantId)
      ?? 0;
  }

  device(deviceId: string): EndpointDeviceRecord | undefined {
    return this.#devices.get(deviceId);
  }

  deviceByFingerprint(fingerprint: string): EndpointDeviceRecord | undefined {
    const deviceId = this.#byFingerprint.get(fingerprint);
    return deviceId ? this.#devices.get(deviceId) : undefined;
  }

  devices(): readonly EndpointDeviceRecord[] {
    return [...this.#devices.values()];
  }

  /** Account-managed grants are usable only when the locally stored device is
   * still bound to the exact live account epoch and the requested route/scope
   * is one of its durable grant records. An account id supplied by a caller is
   * never enough to establish this relationship. */
  accountGrantAllows(input: {
    readonly deviceId: string;
    readonly account: AccountAuthorityBinding;
    readonly tenantId: string;
    readonly routeId: string;
    readonly scope: string;
  }): boolean {
    const device = this.#devices.get(input.deviceId);
    if (!device || device.revoked || device.tenantId !== input.tenantId || device.routeId !== input.routeId
      || device.accountBinding?.accountId !== input.account.accountId
      || device.accountBinding.authEpoch !== input.account.authEpoch) return false;
    return (device.accountGrants ?? []).some((grant) => grant.scopes.includes(input.scope));
  }

  accountDevices(accountId: string): readonly EndpointDeviceRecord[] {
    return Object.freeze([...this.#devices.values()].filter((device) => device.accountBinding?.accountId === accountId));
  }

  invitation(inviteId: string): EndpointInvitationRecord | undefined {
    return this.#invitations.get(inviteId);
  }

  invitations(): readonly EndpointInvitationRecord[] {
    return Object.freeze([...this.#invitations.values()]);
  }

  saveInvitation(record: EndpointInvitationRecord): void {
    const existing = this.#invitations.get(record.inviteId);
    if (existing?.consumedByOperationId
      && record.consumedByOperationId !== existing.consumedByOperationId) {
      throw Object.assign(new Error("A consumed pairing invitation cannot be restored or reassigned."), { code: "pairing_invite_consumed" });
    }
    this.#invitations.set(record.inviteId, Object.freeze({ ...record }));
    this.#persist();
  }

  pairingOperation(bootstrapId: string): EndpointPairingOperationRecord | undefined {
    return this.#pairingOperations.get(bootstrapId);
  }

  pairingOperations(): readonly EndpointPairingOperationRecord[] {
    return Object.freeze([...this.#pairingOperations.values()]);
  }

  grantOperation(operationId: string): EndpointGrantOperationRecord | undefined {
    return this.#grantOperations.get(operationId);
  }

  saveGrantOperation(record: EndpointGrantOperationRecord): void {
    const existing = this.#grantOperations.get(record.operationId);
    const order = { issued: 0, authorized: 1, revoked: 2 } as const;
    if (existing && (existing.deviceId !== record.deviceId
      || existing.account.accountId !== record.account.accountId
      || existing.account.authEpoch !== record.account.authEpoch
      || JSON.stringify(existing.target) !== JSON.stringify(record.target)
      || order[record.state] < order[existing.state]
      || existing.state === "revoked" && record.state !== "revoked")) {
      throw Object.assign(new Error("A grant operation cannot change its account, target, or authorization state."), { code: "grant_operation_conflict" });
    }
    this.#grantOperations.set(record.operationId, Object.freeze({ ...record }));
    this.#persist();
  }

  savePairingOperation(record: EndpointPairingOperationRecord): void {
    if (record.permitId !== undefined && !isAccountStepUpPermitId(record.permitId)) {
      throw Object.assign(new Error("A pairing operation permit does not match the account authority format."), { code: "pairing_operation_invalid" });
    }
    const existing = this.#pairingOperations.get(record.bootstrapId);
    const stateOrder = { challenged: 0, authorized: 1, enrolled: 2, revoked: 3 } as const;
    if (existing && (existing.entrySessionId !== record.entrySessionId || existing.inviteId !== record.inviteId
      || existing.target.grantRef !== record.target.grantRef
      || (existing.entryPeerIdentity !== undefined
        && JSON.stringify(existing.entryPeerIdentity ?? null) !== JSON.stringify(record.entryPeerIdentity ?? null))
      || JSON.stringify(existing.endpointPeerIdentity ?? null) !== JSON.stringify(record.endpointPeerIdentity ?? null)
      || (existing.operationId && record.operationId && existing.operationId !== record.operationId)
      || stateOrder[record.state] < stateOrder[existing.state]
      || existing.state === "revoked" && record.state !== "revoked")) {
      throw Object.assign(new Error("A pairing operation cannot change its session, invite, target, or operation identity."), { code: "pairing_operation_conflict" });
    }
    this.#pairingOperations.set(record.bootstrapId, Object.freeze({ ...record }));
    this.#persist();
  }

  /**
   * Enroll a fresh device under a validated EndpointTrustBinding. Enrollment is
   * monotonic: a re-enrollment must advance the admission generation and never
   * silently resurrects a revoked device.
   */
  enroll(input: {
    readonly deviceId: string;
    readonly routeId: string;
    readonly tenantId: string;
    readonly trustBinding: unknown;
  }): EndpointDeviceRecord {
    const binding = parseEndpointTrustBinding(input.trustBinding);
    if (!binding) {
      throw Object.assign(new Error("Endpoint trust binding does not satisfy the wire contract."), { code: "trust_binding_invalid" });
    }
    const existing = this.#devices.get(input.deviceId);
    if (existing?.revoked) {
      throw Object.assign(new Error("A revoked device cannot be re-enrolled without a fresh trust generation."), { code: "device_revoked" });
    }
    const currentRevision = this.revocationRevision(input.tenantId);
    const record: EndpointDeviceRecord = Object.freeze({
      deviceId: input.deviceId,
      routeId: input.routeId,
      tenantId: input.tenantId,
      role: String(binding.role),
      mode: String(binding.mode),
      pairedIdentityKey: String(binding.pairedIdentityKey),
      pairedIdentityFingerprint: String(binding.pairedIdentityFingerprint),
      principalRef: String(binding.endpointPrincipalRef),
      capabilityGrantRef: String(binding.capabilityGrantRef),
      boundRecoveryKeyId: binding.boundRecoveryKeyId === null ? null : String(binding.boundRecoveryKeyId),
      trustGeneration: binding.trustGeneration as number,
      admissionGeneration: (existing?.admissionGeneration ?? 0) + 1,
      revoked: false,
      // Account bindings and grants belong to the enrolled key identity; they
      // survive re-enrollment only while the paired key itself is unchanged.
      ...(existing?.accountBinding && existing.pairedIdentityKey === String(binding.pairedIdentityKey) ? {
        accountBinding: existing.accountBinding,
        ...(existing.accountScopes ? { accountScopes: existing.accountScopes } : {}),
        ...(existing.accountGrants ? { accountGrants: existing.accountGrants } : {})
      } : {})
    });
    const collision = this.#byFingerprint.get(record.pairedIdentityFingerprint);
    if (collision && collision !== record.deviceId) {
      throw Object.assign(new Error("The paired identity fingerprint already belongs to another device."), { code: "ambiguous_identity" });
    }
    this.#devices.set(record.deviceId, record);
    this.#byFingerprint.set(record.pairedIdentityFingerprint, record.deviceId);
    this.#revocationRevisions.set(input.tenantId, currentRevision);
    this.#persist();
    return record;
  }

  /** Bind the receiving endpoint's locally-held account authority key result
   * to its already-enrolled local identity. The account binding itself is
   * supplied only after the signed current-authority lookup succeeds. */
  bindAccountEndpoint(input: { readonly deviceId: string; readonly account: AccountAuthorityBinding }): EndpointDeviceRecord {
    const existing = this.#devices.get(input.deviceId);
    if (!existing || existing.role !== "endpoint" || existing.revoked
      || !input.account.accountId || !Number.isSafeInteger(input.account.authEpoch) || input.account.authEpoch < 1) {
      throw Object.assign(new Error("Managed endpoint account binding is unavailable."), { code: "account_endpoint_binding_invalid" });
    }
    if (existing.accountBinding && (existing.accountBinding.accountId !== input.account.accountId
      || existing.accountBinding.authEpoch > input.account.authEpoch)) {
      throw Object.assign(new Error("Endpoint account binding cannot change owner or move backward."), { code: "account_endpoint_binding_conflict" });
    }
    if (existing.accountBinding?.authEpoch !== input.account.authEpoch) {
      // A newer epoch is a recovery/revocation boundary. Existing Entry trust
      // is fenced first and must be paired again with a fresh factor permit.
      this.revokeAccountEpoch(input.account.accountId, input.account.authEpoch);
    }
    const current = this.#devices.get(input.deviceId)!;
    const bound = Object.freeze({ ...current, accountBinding: Object.freeze({ ...input.account }) });
    this.#devices.set(input.deviceId, bound);
    this.#persist();
    return bound;
  }

  /** Re-enable only the receiving endpoint after the authority has completed a
   * fresh, exact-target endpoint claim for the current account epoch. Entry
   * grants remain revoked and must be individually paired again. */
  activateAccountEndpointClaim(input: {
    readonly deviceId: string;
    readonly account: AccountAuthorityBinding;
    readonly admissionGeneration: number;
    readonly revocationRevision: number;
  }): EndpointDeviceRecord {
    const existing = this.#devices.get(input.deviceId);
    if (!existing || existing.role !== "endpoint"
      || !input.account.accountId || !Number.isSafeInteger(input.account.authEpoch) || input.account.authEpoch < 1
      || !Number.isSafeInteger(input.admissionGeneration) || input.admissionGeneration < 1
      || !Number.isSafeInteger(input.revocationRevision) || input.revocationRevision < 0
      || existing.accountBinding && (existing.accountBinding.accountId !== input.account.accountId
        || existing.accountBinding.authEpoch > input.account.authEpoch)) {
      throw Object.assign(new Error("A verified current endpoint claim is required."), { code: "account_endpoint_claim_invalid" });
    }
    const changedEpoch = existing.accountBinding?.authEpoch !== input.account.authEpoch;
    if (changedEpoch) {
      // A fresh endpoint claim can happen while this endpoint has been offline
      // since account recovery. Reconstruct the same local revocation fence
      // before restoring the endpoint credential; otherwise stale Entry and
      // recovery records could look live in memory even though the authority
      // already rejects them.
      this.revokeAccountEpoch(input.account.accountId, input.account.authEpoch);
    }
    const current = this.#devices.get(input.deviceId)!;
    const activated: EndpointDeviceRecord = Object.freeze({
      ...current,
      accountBinding: Object.freeze({ ...input.account }),
      accountScopes: Object.freeze([]),
      accountGrants: Object.freeze([]),
      admissionGeneration: input.admissionGeneration,
      trustGeneration: current.trustGeneration + (changedEpoch || current.revoked ? 1 : 0),
      revoked: false
    });
    this.#devices.set(input.deviceId, activated);
    this.#revocationRevisions.set(current.tenantId, Math.max(this.revocationRevision(current.tenantId), input.revocationRevision));
    this.#persist();
    return activated;
  }

  /** Persist an account-authorized Entry identity and its exact scopes. The
   * caller must verify a fresh one-use permit and the device key proof first. */
  enrollAccountDevice(input: {
    readonly account: AccountAuthorityBinding;
    readonly target: AccountActionTarget;
    readonly mode: string;
    readonly entryPeerIdentity?: PairingPeerIdentity | null;
  }): EndpointDeviceRecord {
    const { account, target } = input;
    if (!account.accountId || !Number.isSafeInteger(account.authEpoch) || account.authEpoch < 1
      || !target.tenantId || !target.routeId || !target.deviceId || !target.grantRef
      || typeof target.devicePublicKey !== "string" || !Array.isArray(target.scopes)
      || target.scopes.length === 0
      || target.scopes.some((scope) => typeof scope !== "string" || !scope.trim())
      || new Set(target.scopes).size !== target.scopes.length) {
      throw Object.assign(new Error("Account device grant is incomplete."), { code: "account_device_binding_invalid" });
    }
    const raw = Buffer.from(target.devicePublicKey, "base64url");
    if (raw.byteLength !== 32 || raw.toString("base64url") !== target.devicePublicKey) {
      throw Object.assign(new Error("Account device public key must be a canonical raw Ed25519 key."), { code: "account_device_key_invalid" });
    }
    if (input.entryPeerIdentity !== undefined
      && !validPairingPeerIdentity(input.entryPeerIdentity, expectedPeerId(target.tenantId, target.routeId, target.deviceId))) {
      throw Object.assign(new Error("Paired Signal identity must bind the exact account route and device."), { code: "account_peer_identity_invalid" });
    }
    const spki = Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]);
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    } catch {
      throw Object.assign(new Error("Account device public key is not usable."), { code: "account_device_key_invalid" });
    }
    const fingerprint = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("base64url");
    const existing = this.#devices.get(target.deviceId);
    if (existing && (existing.tenantId !== target.tenantId || existing.routeId !== target.routeId
      || existing.pairedIdentityKey !== target.devicePublicKey
      || (existing.accountBinding && existing.accountBinding.accountId !== account.accountId))) {
      throw Object.assign(new Error("Account device identity is already bound to another route or key."), { code: "account_device_conflict" });
    }
    const priorGrants = existing?.accountBinding?.authEpoch === account.authEpoch ? existing.accountGrants ?? [] : [];
    const priorGrant = priorGrants.find((grant) => grant.grantRef === target.grantRef);
    if (priorGrant) {
      if (JSON.stringify([...new Set(priorGrant.scopes)].sort()) !== JSON.stringify([...new Set(target.scopes)].sort())) {
        throw Object.assign(new Error("A grant reference cannot be reused for a different scope set."), { code: "account_target_mismatch" });
      }
      if (input.entryPeerIdentity !== undefined
        && JSON.stringify(existing?.entryPeerIdentity ?? null) !== JSON.stringify(input.entryPeerIdentity)) {
        throw Object.assign(new Error("A paired device grant cannot change its pinned Signal identity."), { code: "account_peer_identity_conflict" });
      }
      return existing!;
    }
    const accountGrants = Object.freeze([...priorGrants, Object.freeze({ grantRef: target.grantRef, scopes: Object.freeze([...target.scopes].sort()) })]);
    const scopes = [...new Set(accountGrants.flatMap((grant) => grant.scopes))].sort();
    const record: EndpointDeviceRecord = Object.freeze({
      deviceId: target.deviceId,
      routeId: target.routeId,
      tenantId: target.tenantId,
      role: "entry",
      mode: input.mode,
      pairedIdentityKey: target.devicePublicKey,
      pairedIdentityFingerprint: fingerprint,
      principalRef: existing?.principalRef ?? `account.${createHash("sha256").update(account.accountId).digest("base64url").slice(0, 24)}.${target.deviceId}`,
      capabilityGrantRef: target.grantRef,
      boundRecoveryKeyId: existing?.boundRecoveryKeyId ?? null,
      trustGeneration: existing ? existing.trustGeneration + 1 : 1,
      admissionGeneration: existing ? existing.admissionGeneration + 1 : 1,
      revoked: false,
      accountBinding: Object.freeze({ ...account }),
      accountScopes: Object.freeze(scopes),
      accountGrants,
      entryPeerIdentity: input.entryPeerIdentity === undefined
        ? existing?.entryPeerIdentity ?? null
        : input.entryPeerIdentity ? Object.freeze({ ...input.entryPeerIdentity }) : null
    });
    const collision = this.#byFingerprint.get(fingerprint);
    if (collision && collision !== record.deviceId) {
      throw Object.assign(new Error("The account device key is already assigned to another device."), { code: "ambiguous_identity" });
    }
    this.#devices.set(record.deviceId, record);
    this.#byFingerprint.set(fingerprint, record.deviceId);
    this.#revocationRevisions.set(target.tenantId, this.revocationRevision(target.tenantId));
    this.#persist();
    return record;
  }

  /** Remove persisted grants from earlier account epochs. Current-authority
   * checks remain the effect boundary for endpoints that were offline. */
  revokeAccountEpoch(accountId: string, currentEpoch: number): readonly EndpointDeviceRecord[] {
    const revoked: EndpointDeviceRecord[] = [];
    for (const [deviceId, current] of this.#devices) {
      if (!current.accountBinding || current.accountBinding.accountId !== accountId
        || current.accountBinding.authEpoch >= currentEpoch) continue;
      const hasGrantData = (current.accountScopes?.length ?? 0) > 0 || (current.accountGrants?.length ?? 0) > 0;
      if (current.revoked && !hasGrantData) continue;
      const updated = Object.freeze({ ...current, revoked: true, accountScopes: Object.freeze([]), accountGrants: Object.freeze([]) });
      this.#devices.set(deviceId, updated);
      if (!current.revoked) this.#revocationRevisions.set(current.tenantId, this.revocationRevision(current.tenantId) + 1);
      revoked.push(updated);
    }
    let changed = revoked.length > 0;
    for (const [keyId, authority] of this.#recoveryAuthorities) {
      if (authority.accountBinding?.accountId === accountId && authority.accountBinding.authEpoch < currentEpoch
        && authority.state !== "revoked") {
        this.#recoveryAuthorities.set(keyId, Object.freeze({ ...authority, state: "revoked" }));
        changed = true;
      }
    }
    for (const [bootstrapId, operation] of this.#pairingOperations) {
      if (operation.account.accountId === accountId && operation.account.authEpoch < currentEpoch && operation.state !== "revoked") {
        this.#pairingOperations.set(bootstrapId, Object.freeze({ ...operation, state: "revoked" }));
        changed = true;
      }
    }
    for (const [operationId, operation] of this.#grantOperations) {
      if (operation.account.accountId === accountId && operation.account.authEpoch < currentEpoch && operation.state !== "revoked") {
        this.#grantOperations.set(operationId, Object.freeze({ ...operation, state: "revoked" }));
        changed = true;
      }
    }
    if (changed) this.#persist();
    return Object.freeze(revoked);
  }

  /** Local revocation takes effect immediately; remote propagation happens on the next authenticated contact. */
  revoke(deviceId: string): EndpointDeviceRecord | undefined {
    const current = this.#devices.get(deviceId);
    if (!current || current.revoked) return current;
    const updated: EndpointDeviceRecord = Object.freeze({ ...current, revoked: true });
    this.#devices.set(deviceId, updated);
    const revision = this.revocationRevision(current.tenantId) + 1;
    this.#revocationRevisions.set(current.tenantId, revision);
    this.#persist();
    return updated;
  }

  /**
   * Evaluate a relay admission binding against enrolled state. The decision is
   * exhaustive: ambiguous identity, cross-tenant, wrong role/mode, stale
   * generation and stale revocation countersign each refuse distinctly.
   */
  admit(input: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly routeId: string;
    readonly role: string;
    readonly mode: string;
    readonly admissionGeneration: number;
    readonly revocationRevision: number;
  }): EndpointAdmissionDecision {
    const device = this.#devices.get(input.deviceId);
    if (!device) return Object.freeze({ admitted: false, refusal: "unknown_device" });
    if (device.tenantId !== input.tenantId) return Object.freeze({ admitted: false, refusal: "cross_tenant" });
    if (device.routeId !== input.routeId) return Object.freeze({ admitted: false, refusal: "ambiguous_identity" });
    if (device.role !== input.role || !PRIVATE_RELAY_ROLES.includes(input.role as never)) {
      return Object.freeze({ admitted: false, refusal: "role_mismatch" });
    }
    if (device.mode !== input.mode || !PRIVATE_RELAY_MODES.includes(input.mode as never)) {
      return Object.freeze({ admitted: false, refusal: "mode_mismatch" });
    }
    if (device.revoked) return Object.freeze({ admitted: false, refusal: "revoked" });
    if (input.admissionGeneration < device.admissionGeneration) {
      return Object.freeze({ admitted: false, refusal: "stale_generation" });
    }
    if (input.revocationRevision < this.revocationRevision(device.tenantId)) {
      return Object.freeze({ admitted: false, refusal: "stale_revocation_revision" });
    }
    return Object.freeze({ admitted: true, device });
  }

  recoveryAuthority(recoveryKeyId: string): RecoveryAuthorityRecord | undefined {
    return this.#recoveryAuthorities.get(recoveryKeyId);
  }

  recoveryAuthorities(): readonly RecoveryAuthorityRecord[] {
    return [...this.#recoveryAuthorities.values()];
  }

  enrollRecoveryAuthority(input: {
    readonly recoveryKeyId: string;
    readonly principalRef: string;
    readonly publicKey: string;
    readonly generation: number;
    readonly accountBinding?: AccountAuthorityBinding;
  }): RecoveryAuthorityRecord {
    const existing = this.#recoveryAuthorities.get(input.recoveryKeyId);
    if (existing?.state === "revoked" || existing?.state === "superseded") return existing;
    if (existing && (existing.publicKey !== input.publicKey || existing.generation > input.generation
      || (existing.accountBinding && input.accountBinding
        && (existing.accountBinding.accountId !== input.accountBinding.accountId
          || existing.accountBinding.authEpoch !== input.accountBinding.authEpoch)))) {
      throw Object.assign(new Error("Recovery authority cannot replace or downgrade existing trust."), { code: "recovery_authority_conflict" });
    }
    const record: RecoveryAuthorityRecord = Object.freeze({
      recoveryKeyId: input.recoveryKeyId,
      principalRef: input.principalRef,
      publicKey: input.publicKey,
      generation: input.generation,
      state: existing?.state ?? "active",
      ...((existing?.accountBinding ?? input.accountBinding) ? { accountBinding: existing?.accountBinding ?? input.accountBinding } : {})
    });
    this.#recoveryAuthorities.set(record.recoveryKeyId, record);
    this.#persist();
    return record;
  }

  /** Bind already-configured local recovery authorities when the endpoint is
   * first claimed by an account. This lets a later account epoch revoke their
   * old path without deleting the user's offline recovery material. */
  bindRecoveryAuthoritiesToAccount(account: AccountAuthorityBinding): readonly RecoveryAuthorityRecord[] {
    const updated: RecoveryAuthorityRecord[] = [];
    for (const [keyId, current] of this.#recoveryAuthorities) {
      if (current.accountBinding) {
        if (current.accountBinding.accountId !== account.accountId) {
          throw Object.assign(new Error("Recovery authority belongs to another account."), { code: "recovery_authority_conflict" });
        }
        continue;
      }
      const bound = Object.freeze({ ...current, accountBinding: Object.freeze({ ...account }) });
      this.#recoveryAuthorities.set(keyId, bound);
      updated.push(bound);
    }
    if (updated.length > 0) this.#persist();
    return Object.freeze(updated);
  }

  setRecoveryAuthorityState(recoveryKeyId: string, state: RecoveryAuthorityRecord["state"]): RecoveryAuthorityRecord | undefined {
    const current = this.#recoveryAuthorities.get(recoveryKeyId);
    if (!current) return undefined;
    const updated = Object.freeze({ ...current, state });
    this.#recoveryAuthorities.set(recoveryKeyId, updated);
    this.#persist();
    return updated;
  }

  /**
   * Stage a recovery root rotation: the candidate must advance the generation
   * and the incumbent stays active until per-endpoint acknowledgement
   * completes. A snapshot or replayed state can never lower the generation.
   */
  stageRecoveryRotation(input: {
    readonly recoveryKeyId: string;
    readonly candidateKeyId: string;
    readonly candidatePublicKey: string;
    readonly principalRef: string;
    readonly currentGeneration: number;
    readonly candidateGeneration: number;
  }): { readonly accepted: boolean; readonly refusal?: "stale_generation" | "authority_revoked" } {
    const incumbent = this.#recoveryAuthorities.get(input.recoveryKeyId);
    if (!incumbent || incumbent.state === "revoked") {
      return Object.freeze({ accepted: false, refusal: "authority_revoked" });
    }
    if (input.candidateGeneration <= incumbent.generation || input.currentGeneration < incumbent.generation) {
      return Object.freeze({ accepted: false, refusal: "stale_generation" });
    }
    this.setRecoveryAuthorityState(input.recoveryKeyId, "rotating");
    const candidate: RecoveryAuthorityRecord = Object.freeze({
      recoveryKeyId: input.candidateKeyId,
      principalRef: input.principalRef,
      publicKey: input.candidatePublicKey,
      generation: input.candidateGeneration,
      state: "active",
      ...(incumbent.accountBinding ? { accountBinding: incumbent.accountBinding } : {})
    });
    this.#recoveryAuthorities.set(candidate.recoveryKeyId, candidate);
    this.#persist();
    return Object.freeze({ accepted: true });
  }

  completeRecoveryRotation(recoveryKeyId: string): void {
    const incumbent = this.#recoveryAuthorities.get(recoveryKeyId);
    if (incumbent) {
      const superseded = Object.freeze({ ...incumbent, state: "superseded" as const });
      this.#recoveryAuthorities.set(recoveryKeyId, superseded);
      this.#persist();
    }
  }

  abortRecoveryRotation(recoveryKeyId: string, candidateKeyId: string): void {
    const incumbent = this.#recoveryAuthorities.get(recoveryKeyId);
    if (incumbent) this.setRecoveryAuthorityState(recoveryKeyId, "active");
    this.#recoveryAuthorities.delete(candidateKeyId);
    this.#persist();
  }
}

const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function expectedPeerId(tenantId: string, routeId: string, deviceId: string): string {
  return peerIdForRouteDevice({ tenantId, routeId, deviceId }) ?? "";
}

function validPairingPeerIdentity(value: PairingPeerIdentity | null, peerId: string): boolean {
  if (value === null) return true;
  if (!isPairingPeerIdentity(value, peerId)) return false;
  const raw = Buffer.from(value.identityKey, "base64url");
  return raw.byteLength === 33 && raw.toString("base64url") === value.identityKey;
}

/**
 * Derive the kernel AuthenticatedContext from an admitted device record. The
 * endpoint authority port supplies the actual grant material; the binding only
 * proves *which* principal and grant reference are live.
 */
export interface EndpointAuthorityPort {
  contextFor(input: {
    readonly device: EndpointDeviceRecord;
  }): AuthenticatedContext | Promise<AuthenticatedContext> | undefined;
}

export function createEndpointIdentityStore(durable?: EndpointIdentityDurablePort): EndpointIdentityStore {
  return new EndpointIdentityStore(durable);
}
