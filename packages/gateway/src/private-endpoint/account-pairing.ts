import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { peerIdForRouteDevice } from "@meshrix/contracts/private-relay";
import {
  isAccountStepUpPermitId,
  isPairingPeerIdentity,
  type AccountActionTarget,
  type AccountAuthorityBinding,
  type AccountDeviceCurrentBindingResponse,
  type AccountPendingPairing,
  type AccountStepUpInspectionResult,
  type AccountStepUpPurpose,
  type PairingPeerIdentity
} from "@meshrix/contracts/account";
import { EndpointIdentityStore, type EndpointDeviceRecord } from "./identity-store.ts";

const ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_ACTIVE_PAIRINGS = 128;

export interface EndpointAccountPairingAuthority {
  currentBinding(accountId: string, peerDeviceId: string): Promise<AccountAuthorityBinding | null>;
  currentDeviceAuthorization?(peerDeviceId: string): Promise<AccountDeviceCurrentBindingResponse | null>;
  inspectPendingPairing(input: { readonly bootstrapId: string }): Promise<AccountPendingPairing | null>;
  publishPairingTarget(input: { readonly bootstrapId: string; readonly target: AccountActionTarget }): Promise<AccountPendingPairing | null>;
  inspectStepUpPermit(input: {
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: AccountStepUpPurpose;
    readonly target: AccountActionTarget;
    readonly bootstrapId?: string;
  }): Promise<AccountStepUpInspectionResult>;
  consumeStepUpPermit(input: {
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: AccountStepUpPurpose;
    readonly target: AccountActionTarget;
    readonly bootstrapId?: string;
    readonly operationId: string;
  }): Promise<{ readonly consumed: boolean; readonly replayed?: boolean }>;
  completePairing(input: {
    readonly account: AccountAuthorityBinding;
    readonly bootstrapId: string;
    readonly operationId: string;
    readonly target: AccountActionTarget;
  }): Promise<{ readonly completed: boolean; readonly relayAdmissionActive: boolean }>;
}

export interface EndpointPairingInviteContext {
  readonly tenantId: string;
  readonly routeId: string;
  readonly endpointDeviceId: string;
  readonly endpointPinRef: string;
  readonly endpointSpkiPin: string;
  readonly endpointPrincipalRef: string;
  readonly relayService: string;
  readonly vaultId: string;
  readonly mode: "personal" | "enterprise";
  readonly recoveryAuthority: { readonly keyId: string; readonly generation: number } | null;
}

export interface EndpointPairingProofPort {
  inspect(input: { readonly bootstrapId: string }): Promise<unknown>;
  publishTarget(input: { readonly bootstrapId: string; readonly target: AccountActionTarget }): Promise<unknown>;
  inspectPermit(input: {
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: AccountStepUpPurpose;
    readonly target: AccountActionTarget;
    readonly bootstrapId?: string;
  }): Promise<AccountStepUpInspectionResult>;
  consumePermit(input: {
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: AccountStepUpPurpose;
    readonly target: AccountActionTarget;
    readonly bootstrapId?: string;
    readonly operationId: string;
  }): Promise<{ readonly consumed: boolean; readonly replayed?: boolean }>;
  complete(input: {
    readonly account: AccountAuthorityBinding;
    readonly bootstrapId: string;
    readonly operationId: string;
    readonly target: AccountActionTarget;
  }): Promise<{ readonly completed: boolean; readonly relayAdmissionActive: boolean }>;
}

export interface EndpointPairingApplicationOptions {
  readonly identity: EndpointIdentityStore;
  readonly authority: EndpointAccountPairingAuthority;
  /** Proof factory signs requests with the endpoint's registered account key. */
  readonly proof: EndpointPairingProofPort;
  readonly invite: EndpointPairingInviteContext;
  readonly availableScopes: readonly string[];
  readonly endpointPeerIdentity?: PairingPeerIdentity | null;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly idFactory?: (prefix: string) => string;
}

export interface ActivePairingBootstrap {
  readonly bootstrapId: string;
  readonly entrySessionId: string;
  readonly account: AccountAuthorityBinding;
  readonly entryDeviceId: string;
  readonly entryDevicePublicKey: string;
  readonly peerSpki: string;
  readonly target: AccountActionTarget | null;
  readonly expiresAt: string;
}

export type PairingBeginResult =
  | { readonly outcome: "challenge"; readonly challengeId: string; readonly nonce: string; readonly expiresAt: string; readonly account: AccountAuthorityBinding; readonly target: AccountActionTarget }
  | { readonly outcome: "refused"; readonly refusal: string };

export type PairingCompleteResult =
  | { readonly outcome: "enrolled"; readonly capabilityGrantRef: string; readonly admissionGeneration: number; readonly revocationRevision: number; readonly endpointPeerIdentity: PairingPeerIdentity | null }
  | { readonly outcome: "refused"; readonly refusal: string };

interface PairingChallenge {
  readonly bootstrapId: string;
  readonly entrySessionId: string;
  readonly inviteId: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly account: AccountAuthorityBinding;
  readonly target: AccountActionTarget;
  readonly expiresAt: string;
}

interface PairingCompleteRequest {
  readonly bootstrapId: string;
  readonly entrySessionId: string;
  readonly inviteId: string;
  readonly pairingToken: string;
  readonly challengeId: string;
  readonly deviceId: string;
  readonly devicePublicKey: string;
  readonly entryPeerIdentity: PairingPeerIdentity | null;
  readonly signature: string;
  readonly account: AccountAuthorityBinding;
  readonly permitId: string;
  readonly purpose: "pair_device";
  readonly target: AccountActionTarget;
  readonly operationId: string;
}

/**
 * Endpoint-owned pairing policy. Relay hints only locate account-owned pending
 * state; the authority read, invite bearer, device signature and fresh account
 * permit are all verified before an identity-store write. The caller still
 * owns transport/TLS framing and must bind each method call to the peer session
 * returned by inspectBootstrap().
 */
export class EndpointAccountPairingApplication {
  readonly #identity: EndpointIdentityStore;
  readonly #authority: EndpointAccountPairingAuthority;
  readonly #proof: EndpointPairingProofPort;
  readonly #invite: EndpointPairingInviteContext;
  readonly #availableScopes: readonly string[];
  readonly #endpointPeerIdentity: PairingPeerIdentity | null;
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  readonly #idFactory: (prefix: string) => string;
  readonly #active = new Map<string, ActivePairingBootstrap>();
  readonly #challenges = new Map<string, PairingChallenge>();
  readonly #inFlight = new Map<string, { readonly operationId: string; readonly permitId: string; readonly target: AccountActionTarget; readonly entryPeerIdentity: PairingPeerIdentity | null; readonly promise: Promise<PairingCompleteResult> }>();

  constructor(options: EndpointPairingApplicationOptions) {
    this.#identity = options.identity;
    this.#authority = options.authority;
    this.#proof = options.proof;
    this.#invite = options.invite;
    this.#availableScopes = Object.freeze([...new Set(options.availableScopes)].sort());
    this.#endpointPeerIdentity = options.endpointPeerIdentity ?? null;
    if (!validPeerIdentity(this.#endpointPeerIdentity, routePeerId(this.#invite.tenantId, this.#invite.routeId, this.#invite.endpointDeviceId))) {
      throw accountPairingError("peer_identity_invalid");
    }
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#idFactory = options.idFactory ?? ((prefix) => `${prefix}.${randomBytes(18).toString("base64url")}`);
    for (const operation of options.identity.pairingOperations()) {
      if (operation.state !== "revoked" && Date.parse(operation.expiresAt) > this.#now()) {
        this.#challenges.set(operation.bootstrapId, Object.freeze({
          bootstrapId: operation.bootstrapId,
          entrySessionId: operation.entrySessionId,
          inviteId: operation.inviteId,
          challengeId: operation.challengeId,
          nonce: operation.nonce,
          account: operation.account,
          target: operation.target,
          expiresAt: operation.expiresAt
        }));
      }
    }
  }

  async inspectBootstrap(input: { readonly bootstrapId: string; readonly entrySessionId: string }): Promise<ActivePairingBootstrap | null> {
    if (!isOpaque(input.bootstrapId) || !isOpaque(input.entrySessionId)) return null;
    const cached = this.#active.get(input.bootstrapId);
    if (cached?.entrySessionId === input.entrySessionId && Date.parse(cached.expiresAt) > this.#now()) {
      const current = await this.#authority.currentBinding(cached.account.accountId, cached.entryDeviceId);
      if (sameBinding(current, cached.account)) return cached;
      this.#active.delete(input.bootstrapId);
      this.#challenges.delete(input.bootstrapId);
      return null;
    }

    // A replacement session invalidates every provisional challenge for the
    // old session before the new peer pin can become active.
    for (const [bootstrapId, active] of this.#active) {
      if (bootstrapId === input.bootstrapId && active.entrySessionId !== input.entrySessionId) {
        this.#active.delete(bootstrapId);
        this.#challenges.delete(bootstrapId);
      }
    }
    const pending = await this.#proof.inspect({ bootstrapId: input.bootstrapId });
    if (!isPendingPairing(pending)) return null;
    if (pending.bootstrapId !== input.bootstrapId
      || pending.tenantId !== this.#invite.tenantId
      || pending.routeId !== this.#invite.routeId
      || pending.endpointDeviceId !== this.#invite.endpointDeviceId
      || pending.endpointPinRef !== this.#invite.endpointPinRef
      || Date.parse(pending.expiresAt) <= this.#now()
      || !rawEd25519Pin(pending.entryDevicePublicKey)) return null;
    const current = await this.#authority.currentBinding(pending.account.accountId, pending.entryDeviceId);
    if (!sameBinding(current, pending.account)) return null;

    const next: ActivePairingBootstrap = Object.freeze({
      bootstrapId: pending.bootstrapId,
      entrySessionId: input.entrySessionId,
      account: Object.freeze({ ...pending.account }),
      entryDeviceId: pending.entryDeviceId,
      entryDevicePublicKey: pending.entryDevicePublicKey,
      peerSpki: rawEd25519Pin(pending.entryDevicePublicKey)!,
      target: pending.target,
      expiresAt: pending.expiresAt
    });
    const saved = this.#identity.pairingOperation(input.bootstrapId);
    if (saved && (saved.state === "revoked" || saved.entrySessionId !== input.entrySessionId
      || saved.account.accountId !== pending.account.accountId || saved.account.authEpoch !== pending.account.authEpoch)) return null;
    const challenge = this.#challenges.get(input.bootstrapId);
    if (challenge) {
      if (challenge.entrySessionId !== input.entrySessionId || challenge.target.deviceId !== pending.entryDeviceId
        || challenge.target.devicePublicKey !== pending.entryDevicePublicKey) return null;
      this.#active.set(input.bootstrapId, Object.freeze({ ...next, target: challenge.target }));
    } else {
      this.#active.set(input.bootstrapId, next);
    }
    if (this.#active.size > MAX_ACTIVE_PAIRINGS) {
      const first = this.#active.keys().next().value as string | undefined;
      if (first) {
        this.#active.delete(first);
        this.#challenges.delete(first);
      }
    }
    return next;
  }

  /** Current-authority check for account-bound control paths such as operation
   * status recovery. A locally stored device record alone cannot authorize a
   * request after account recovery or grant revocation. */
  async currentDeviceIsAuthorized(device: EndpointDeviceRecord, scope?: string): Promise<boolean> {
    const authorized = await this.authorizeProtectedEffect(device, scope);
    return authorized !== null;
  }

  /** One current-authority read for a protected effect. Returns the live
   * scope set only when the device, epoch, and exact grant still match. */
  async authorizeProtectedEffect(device: EndpointDeviceRecord, scope?: string): Promise<{ readonly authorizedScopes: readonly string[] } | null> {
    const binding = device.accountBinding;
    if (!binding || device.revoked || !this.#authority.currentDeviceAuthorization) return null;
    try {
      const response = await this.#authority.currentDeviceAuthorization(device.deviceId);
      if (!accountDeviceAuthorizationMatches({ response, binding, device, scope })) return null;
      return Object.freeze({ authorizedScopes: Object.freeze([...response!.authorizedScopes]) });
    } catch {
      return null;
    }
  }

  async issueInvite(input: { readonly vaultId?: string } = {}): Promise<{ readonly invite: Readonly<Record<string, unknown>>; readonly pairingToken: string }> {
    // In a managed profile the vault id comes from account ownership claim.
    // Accepting a caller override here could silently enroll a device against
    // an unrelated pre-account recovery vault.
    if (input.vaultId !== undefined && input.vaultId !== this.#invite.vaultId) {
      throw accountPairingError("pairing_vault_mismatch");
    }
    const token = this.#tokenFactory();
    if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) throw accountPairingError("pairing_token_invalid");
    const now = this.#now();
    const inviteId = this.#idFactory("invite");
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 24 * 60 * 60_000).toISOString();
    const activeRecovery = this.#identity.recoveryAuthorities().find((authority) => authority.state === "active");
    const recoveryAuthority = activeRecovery
      ? Object.freeze({ keyId: activeRecovery.recoveryKeyId, generation: activeRecovery.generation })
      : null;
    const invite = Object.freeze({
      schemaVersion: "v0.0.1:entry:pairing-invite-2",
      kind: "entry-pairing-invite",
      inviteId,
      endpointRouteId: this.#invite.routeId,
      tenantId: this.#invite.tenantId,
      mode: this.#invite.mode,
      endpointDeviceId: this.#invite.endpointDeviceId,
      endpointPrincipalRef: this.#invite.endpointPrincipalRef,
      endpointSpkiPin: this.#invite.endpointSpkiPin,
      endpointPinRef: this.#invite.endpointPinRef,
      relayService: this.#invite.relayService,
      vaultId: this.#invite.vaultId,
      recoveryAuthority,
      issuedAt,
      expiresAt,
      pairingToken: token
    });
    if (!isOpaque(invite.vaultId)) throw accountPairingError("pairing_vault_unconfigured");
    this.#identity.saveInvitation(Object.freeze({
      inviteId,
      tokenDigest: digest(token),
      tenantId: this.#invite.tenantId,
      routeId: this.#invite.routeId,
      endpointDeviceId: this.#invite.endpointDeviceId,
      endpointPinRef: this.#invite.endpointPinRef,
      mode: this.#invite.mode,
      issuedAt,
      expiresAt,
      consumedByOperationId: null
    }));
    return Object.freeze({ invite, pairingToken: token });
  }

  async beginPairing(input: {
    readonly bootstrapId: string;
    readonly entrySessionId: string;
    readonly inviteId: string;
    readonly pairingToken: string;
    readonly deviceId: string;
    readonly devicePublicKey: string;
  }): Promise<PairingBeginResult> {
    const active = this.#active.get(input.bootstrapId);
    const invitation = this.#identity.invitation(input.inviteId);
    if (!active || active.entrySessionId !== input.entrySessionId || !invitation
      || invitation.tenantId !== this.#invite.tenantId || invitation.routeId !== this.#invite.routeId
      || invitation.endpointDeviceId !== this.#invite.endpointDeviceId
      || Date.parse(invitation.expiresAt) <= this.#now()
      || !sameSecret(invitation.tokenDigest, digest(input.pairingToken))
      || (invitation.consumedByOperationId !== null)) {
      return refused("pairing_invite_refused");
    }
    if (active.entryDeviceId !== input.deviceId || active.entryDevicePublicKey !== input.devicePublicKey) {
      return refused("pairing_device_mismatch");
    }
    const old = this.#challenges.get(input.bootstrapId);
    if (old) {
      if (old.entrySessionId !== input.entrySessionId || old.inviteId !== input.inviteId
        || old.target.deviceId !== input.deviceId || old.target.devicePublicKey !== input.devicePublicKey) return refused("pairing_target_mismatch");
      const published = await this.#proof.publishTarget({ bootstrapId: input.bootstrapId, target: old.target });
      if (!isPendingPairing(published) || !sameTarget(published.target, old.target)
        || !sameBinding(published.account, old.account)) return refused("pairing_target_refused");
      return challengeResult(old);
    }
    const current = await this.#authority.currentBinding(active.account.accountId, active.entryDeviceId);
    if (!sameBinding(current, active.account)) return refused("account_stale");
    if (this.#availableScopes.length === 0) return refused("pairing_no_scopes");
    const target: AccountActionTarget = Object.freeze({
      tenantId: this.#invite.tenantId,
      routeId: this.#invite.routeId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      grantRef: this.#idFactory("grant"),
      scopes: this.#availableScopes
    });
    const challenge: PairingChallenge = Object.freeze({
      bootstrapId: input.bootstrapId,
      entrySessionId: input.entrySessionId,
      inviteId: input.inviteId,
      challengeId: this.#idFactory("challenge"),
      nonce: this.#idFactory("nonce"),
      account: active.account,
      target,
      expiresAt: new Date(Math.min(Date.parse(active.expiresAt), this.#now() + 5 * 60_000)).toISOString()
    });
    this.#identity.savePairingOperation(Object.freeze({
      bootstrapId: input.bootstrapId,
      entrySessionId: input.entrySessionId,
      inviteId: input.inviteId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      account: challenge.account,
      target: challenge.target,
      expiresAt: challenge.expiresAt,
      endpointPeerIdentity: this.#endpointPeerIdentity,
      state: "challenged"
    }));
    this.#challenges.set(input.bootstrapId, challenge);
    this.#active.set(input.bootstrapId, Object.freeze({ ...active, target }));
    const published = await this.#proof.publishTarget({ bootstrapId: input.bootstrapId, target });
    if (!isPendingPairing(published) || !sameTarget(published.target, target)
      || !sameBinding(published.account, active.account)) return refused("pairing_target_refused");
    return challengeResult(challenge);
  }

  async completePairing(input: {
    readonly bootstrapId: string;
    readonly entrySessionId: string;
    readonly inviteId: string;
    readonly pairingToken: string;
    readonly challengeId: string;
    readonly deviceId: string;
    readonly devicePublicKey: string;
    readonly entryPeerIdentity: PairingPeerIdentity | null;
    readonly signature: string;
    readonly account: AccountAuthorityBinding;
    readonly permitId: string;
    readonly purpose: "pair_device";
    readonly target: AccountActionTarget;
    readonly operationId: string;
  }): Promise<PairingCompleteResult> {
    const existingFlight = this.#inFlight.get(input.bootstrapId);
    if (existingFlight) {
      if (existingFlight.operationId !== input.operationId || existingFlight.permitId !== input.permitId
        || !sameTarget(existingFlight.target, input.target)
        || JSON.stringify(existingFlight.entryPeerIdentity) !== JSON.stringify(input.entryPeerIdentity)) return Promise.resolve(refused("pairing_operation_conflict"));
      return existingFlight.promise;
    }
    const task = this.#completePairing(input).finally(() => this.#inFlight.delete(input.bootstrapId));
    this.#inFlight.set(input.bootstrapId, {
      operationId: input.operationId,
      permitId: input.permitId,
      target: input.target,
      entryPeerIdentity: input.entryPeerIdentity,
      promise: task
    });
    return task;
  }

  async #completePairing(input: PairingCompleteRequest): Promise<PairingCompleteResult> {
    const saved = this.#identity.pairingOperation(input.bootstrapId);
    const active = this.#active.get(input.bootstrapId);
    const challenge = this.#challenges.get(input.bootstrapId) ?? (saved ? Object.freeze({
      bootstrapId: saved.bootstrapId,
      entrySessionId: saved.entrySessionId,
      inviteId: saved.inviteId,
      challengeId: saved.challengeId,
      nonce: saved.nonce,
      account: saved.account,
      target: saved.target,
      expiresAt: saved.expiresAt
    }) : undefined);
    const invitation = this.#identity.invitation(input.inviteId);
    const replayedEnrollment = saved?.state === "enrolled"
      && saved.operationId === input.operationId
      && saved.permitId === input.permitId
      && saved.inviteId === input.inviteId
      && saved.challengeId === input.challengeId;
    if ((!replayedEnrollment && (!active || active.entrySessionId !== input.entrySessionId)) || !challenge
      || (!replayedEnrollment && challenge.entrySessionId !== input.entrySessionId) || challenge.challengeId !== input.challengeId
      || challenge.inviteId !== input.inviteId || (!replayedEnrollment && Date.parse(challenge.expiresAt) <= this.#now())
      || !invitation || (!replayedEnrollment && Date.parse(invitation.expiresAt) <= this.#now())
      || !sameSecret(invitation.tokenDigest, digest(input.pairingToken))
      || (invitation.consumedByOperationId !== null && invitation.consumedByOperationId !== input.operationId)
      || challenge.target.deviceId !== input.deviceId || challenge.target.devicePublicKey !== input.devicePublicKey
      || !validPeerIdentity(input.entryPeerIdentity, routePeerId(challenge.target.tenantId, challenge.target.routeId, input.deviceId))
      || (input.entryPeerIdentity === null) !== (this.#endpointPeerIdentity === null)
      || input.purpose !== "pair_device" || !sameBinding(challenge.account, input.account)
      || !sameTarget(challenge.target, input.target)
      || !isOpaque(input.operationId) || !isAccountStepUpPermitId(input.permitId)
      || (saved?.entryPeerIdentity !== undefined
        && JSON.stringify(saved.entryPeerIdentity ?? null) !== JSON.stringify(input.entryPeerIdentity))
      || (saved?.endpointPeerIdentity !== undefined
        && JSON.stringify(saved.endpointPeerIdentity ?? null) !== JSON.stringify(this.#endpointPeerIdentity))
      || !verifyPairingDeviceProof({ ...input, endpointRouteId: challenge.target.routeId })) return refused("pairing_proof_refused");

    const current = await this.#authority.currentBinding(input.account.accountId, input.deviceId);
    if (!sameBinding(current, input.account)) return refused("account_stale");
    if (replayedEnrollment) {
      const completed = await this.#proof.complete({
        account: input.account,
        bootstrapId: input.bootstrapId,
        operationId: input.operationId,
        target: challenge.target
      });
      if (!completed.completed || !completed.relayAdmissionActive) return refused("pairing_promotion_pending");
      const enrolled = this.#identity.device(input.deviceId);
      if (!enrolled || enrolled.revoked || enrolled.accountBinding?.accountId !== input.account.accountId
        || enrolled.accountBinding.authEpoch !== input.account.authEpoch) return refused("pairing_enrollment_missing");
      return Object.freeze({ outcome: "enrolled", capabilityGrantRef: challenge.target.grantRef,
        admissionGeneration: enrolled.admissionGeneration, revocationRevision: this.#identity.revocationRevision(enrolled.tenantId),
        endpointPeerIdentity: saved.endpointPeerIdentity ?? this.#endpointPeerIdentity });
    }
    // Consume is the authority's idempotent effect boundary. An inspect-then-
    // consume sequence would strand a retry if the process died after durable
    // consumption but before the local enrollment snapshot was saved.
    const consumed = await this.#proof.consumePermit({
      account: input.account,
      permitId: input.permitId,
      purpose: "pair_device",
      target: challenge.target,
      bootstrapId: input.bootstrapId,
      operationId: input.operationId
    });
    if (!consumed.consumed) return refused("pairing_permit_refused");

    this.#identity.savePairingOperation(Object.freeze({
      bootstrapId: input.bootstrapId,
      entrySessionId: input.entrySessionId,
      inviteId: input.inviteId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      account: challenge.account,
      target: challenge.target,
      expiresAt: challenge.expiresAt,
      operationId: input.operationId,
      permitId: input.permitId,
      entryPeerIdentity: input.entryPeerIdentity,
      endpointPeerIdentity: this.#endpointPeerIdentity,
      state: "authorized"
    }));
    this.#identity.enrollAccountDevice({ account: input.account, target: challenge.target, mode: this.#invite.mode, entryPeerIdentity: input.entryPeerIdentity });
    this.#identity.saveInvitation(Object.freeze({ ...invitation, consumedByOperationId: input.operationId }));
    this.#identity.savePairingOperation(Object.freeze({
      bootstrapId: input.bootstrapId,
      entrySessionId: input.entrySessionId,
      inviteId: input.inviteId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      account: challenge.account,
      target: challenge.target,
      expiresAt: challenge.expiresAt,
      operationId: input.operationId,
      permitId: input.permitId,
      entryPeerIdentity: input.entryPeerIdentity,
      endpointPeerIdentity: this.#endpointPeerIdentity,
      state: "enrolled",
      capabilityGrantRef: challenge.target.grantRef
    }));
    const completed = await this.#proof.complete({
      account: input.account,
      bootstrapId: input.bootstrapId,
      operationId: input.operationId,
      target: challenge.target
    });
    if (!completed.completed || !completed.relayAdmissionActive) return refused("pairing_promotion_pending");
    const enrolled = this.#identity.device(input.deviceId);
    if (!enrolled || enrolled.revoked || enrolled.accountBinding?.accountId !== input.account.accountId
      || enrolled.accountBinding.authEpoch !== input.account.authEpoch) return refused("pairing_enrollment_missing");
    this.#challenges.delete(input.bootstrapId);
    this.#active.delete(input.bootstrapId);
    return Object.freeze({
      outcome: "enrolled",
      capabilityGrantRef: challenge.target.grantRef,
      admissionGeneration: enrolled.admissionGeneration,
      revocationRevision: this.#identity.revocationRevision(enrolled.tenantId),
      endpointPeerIdentity: this.#endpointPeerIdentity
    });
  }

  async grantCatalog(input: { readonly device: EndpointDeviceRecord }): Promise<{ readonly outcome: "grant_catalog"; readonly account: AccountAuthorityBinding; readonly endpointDeviceId: string; readonly availableScopes: readonly string[] } | { readonly outcome: "refused"; readonly refusal: string }> {
    const binding = input.device.accountBinding;
    if (!binding || input.device.revoked) return refused("account_binding_missing");
    const current = await this.#authority.currentBinding(binding.accountId, input.device.deviceId);
    if (!sameBinding(current, binding)) return refused("account_stale");
    return Object.freeze({ outcome: "grant_catalog", account: binding, endpointDeviceId: input.device.deviceId, availableScopes: this.#availableScopes });
  }

  async grantTarget(input: { readonly device: EndpointDeviceRecord; readonly scopes: readonly string[] }): Promise<{ readonly outcome: "grant_target"; readonly account: AccountAuthorityBinding; readonly operationId: string; readonly expiresAt: string; readonly target: AccountActionTarget } | { readonly outcome: "refused"; readonly refusal: string }> {
    const binding = input.device.accountBinding;
    if (!binding || input.device.revoked || !Array.isArray(input.scopes) || input.scopes.length === 0
      || input.scopes.some((scope) => !this.#availableScopes.includes(scope))
      || new Set(input.scopes).size !== input.scopes.length) return refused("grant_target_invalid");
    const current = await this.#authority.currentBinding(binding.accountId, input.device.deviceId);
    if (!sameBinding(current, binding)) return refused("account_stale");
    const target: AccountActionTarget = Object.freeze({
      tenantId: input.device.tenantId,
      routeId: input.device.routeId,
      deviceId: input.device.deviceId,
      devicePublicKey: input.device.pairedIdentityKey,
      grantRef: this.#idFactory("grant"),
      scopes: Object.freeze([...input.scopes].sort())
    });
    const operationId = this.#idFactory("grant.op");
    const expiresAt = new Date(this.#now() + 5 * 60_000).toISOString();
    this.#identity.saveGrantOperation(Object.freeze({
      operationId,
      account: binding,
      deviceId: input.device.deviceId,
      target,
      expiresAt,
      state: "issued"
    }));
    return Object.freeze({
      outcome: "grant_target",
      account: binding,
      operationId,
      expiresAt,
      target
    });
  }

  async grantAccess(input: {
    readonly device: EndpointDeviceRecord;
    readonly account: AccountAuthorityBinding;
    readonly operationId: string;
    readonly permitId: string;
    readonly purpose: "grant_access";
    readonly target: AccountActionTarget;
    readonly signature: string;
  }): Promise<{ readonly outcome: "granted"; readonly capabilityGrantRef: string; readonly authorizedScopes: readonly string[] } | { readonly outcome: "refused"; readonly refusal: string }> {
    const device = input.device;
    if (!device.accountBinding || device.revoked || input.purpose !== "grant_access"
      || input.target.vaultWriterRotation
      || !sameBinding(device.accountBinding, input.account)
      || input.target.tenantId !== device.tenantId || input.target.routeId !== device.routeId
      || input.target.deviceId !== device.deviceId || input.target.devicePublicKey !== device.pairedIdentityKey
      || input.target.scopes.length === 0 || input.target.scopes.some((scope) => !this.#availableScopes.includes(scope))
      || !isOpaque(input.operationId) || !isAccountStepUpPermitId(input.permitId)
      || !verifyGrantAccessDeviceProof({
        account: input.account,
        operationId: input.operationId,
        purpose: input.purpose,
        target: input.target,
        signature: input.signature
      })) return refused("grant_target_mismatch");
    const grantOperation = this.#identity.grantOperation(input.operationId);
    if (!grantOperation || grantOperation.state === "revoked" || grantOperation.deviceId !== device.deviceId
      || !sameBinding(grantOperation.account, input.account) || !sameTarget(grantOperation.target, input.target)
      || Date.parse(grantOperation.expiresAt) <= this.#now()) return refused("grant_target_expired");
    const current = await this.#authority.currentBinding(input.account.accountId, device.deviceId);
    if (!sameBinding(current, input.account)) return refused("account_stale");
    // The consume operation is keyed by operationId and exact target at the
    // authority. It also makes a retry safe after a crash between permit
    // consumption and persisting the local grant record.
    const consumed = await this.#proof.consumePermit({
      account: input.account,
      permitId: input.permitId,
      purpose: "grant_access",
      target: input.target,
      operationId: input.operationId
    });
    if (!consumed.consumed) return refused("grant_permit_refused");
    this.#identity.saveGrantOperation(Object.freeze({ ...grantOperation, state: "authorized" }));
    const enrolled = this.#identity.enrollAccountDevice({ account: input.account, target: input.target, mode: device.mode });
    return Object.freeze({ outcome: "granted", capabilityGrantRef: input.target.grantRef, authorizedScopes: enrolled.accountScopes ?? [] });
  }
}

/** Validate current server authority against the exact durable local device
 * grant records. The active scope set may be additive across several exact
 * grant refs, but it cannot contain an unknown scope or target grant. */
export function accountDeviceAuthorizationMatches(input: {
  readonly response: AccountDeviceCurrentBindingResponse | null;
  readonly binding: AccountAuthorityBinding;
  readonly device: EndpointDeviceRecord;
  readonly scope?: string;
}): boolean {
  const { response, binding, device, scope } = input;
  const target = response?.target;
  if (!response || response.account.accountId !== binding.accountId || response.account.authEpoch !== binding.authEpoch
    || !target || target.tenantId !== device.tenantId || target.routeId !== device.routeId
    || target.deviceId !== device.deviceId || target.devicePublicKey !== device.pairedIdentityKey
    || response.authorizedScopes.some((entry) => typeof entry !== "string")
    || new Set(response.authorizedScopes).size !== response.authorizedScopes.length
    || new Set(target.scopes).size !== target.scopes.length) return false;
  const exactGrant = (device.accountGrants ?? []).find((grant) => grant.grantRef === target.grantRef);
  if (!exactGrant || canonicalJson([...exactGrant.scopes].sort()) !== canonicalJson([...target.scopes].sort())) return false;
  const enrolledScopes = new Set((device.accountGrants ?? []).flatMap((grant) => grant.scopes));
  const authorizedScopes = new Set(response.authorizedScopes);
  if (target.scopes.some((entry) => !authorizedScopes.has(entry))
    || response.authorizedScopes.some((entry) => !enrolledScopes.has(entry))) return false;
  return scope === undefined || authorizedScopes.has(scope);
}

function challengeResult(challenge: PairingChallenge): PairingBeginResult {
  return Object.freeze({ outcome: "challenge", challengeId: challenge.challengeId, nonce: challenge.nonce, expiresAt: challenge.expiresAt, account: challenge.account, target: challenge.target });
}

function refused(refusal: string): { readonly outcome: "refused"; readonly refusal: string } {
  return Object.freeze({ outcome: "refused", refusal });
}

function sameBinding(left: AccountAuthorityBinding | null | undefined, right: AccountAuthorityBinding | null | undefined): boolean {
  return Boolean(left && right && left.accountId === right.accountId && left.authEpoch === right.authEpoch);
}

function sameTarget(left: AccountActionTarget | null | undefined, right: AccountActionTarget | null | undefined): boolean {
  return Boolean(left && right && canonicalJson(left) === canonicalJson(right));
}

function isPendingPairing(value: unknown): value is AccountPendingPairing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as AccountPendingPairing;
  return typeof pending.bootstrapId === "string" && typeof pending.account?.accountId === "string"
    && Number.isSafeInteger(pending.account.authEpoch) && pending.account.authEpoch > 0
    && typeof pending.tenantId === "string" && typeof pending.routeId === "string"
    && typeof pending.entryDeviceId === "string" && typeof pending.entryDevicePublicKey === "string"
    && typeof pending.endpointDeviceId === "string" && typeof pending.endpointPinRef === "string"
    && typeof pending.expiresAt === "string" && (pending.target === null || typeof pending.target === "object");
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,126}$/u.test(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "base64url");
  const b = Buffer.from(right, "base64url");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function rawEd25519Pin(publicKey: string): string | null {
  const raw = Buffer.from(publicKey, "base64url");
  if (raw.byteLength !== 32 || raw.toString("base64url") !== publicKey) return null;
  return createHash("sha256").update(Buffer.concat([ED25519_SPKI_DER_PREFIX, raw])).digest("base64url");
}

function verifyPairingDeviceProof(input: {
  readonly endpointRouteId: string;
  readonly challengeId: string;
  readonly inviteId: string;
  readonly deviceId: string;
  readonly devicePublicKey: string;
  readonly entryPeerIdentity: PairingPeerIdentity | null;
  readonly signature: string;
}): boolean {
  try {
    const raw = Buffer.from(input.devicePublicKey, "base64url");
    if (raw.byteLength !== 32 || raw.toString("base64url") !== input.devicePublicKey) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]), format: "der", type: "spki" });
    const transcript = canonicalJson({
      challengeId: input.challengeId,
      inviteId: input.inviteId,
      endpointRouteId: input.endpointRouteId,
      deviceId: input.deviceId,
      devicePublicKey: input.devicePublicKey,
      entryPeerIdentity: input.entryPeerIdentity,
      purpose: "pair_device"
    });
    return cryptoVerify(null, Buffer.from(transcript, "utf8"), key, Buffer.from(input.signature, "base64url"));
  } catch {
    return false;
  }
}

function routePeerId(tenantId: string, routeId: string, deviceId: string): string {
  return peerIdForRouteDevice({ tenantId, routeId, deviceId }) ?? "";
}

function validPeerIdentity(value: PairingPeerIdentity | null, expectedPeerId: string): boolean {
  if (value === null) return true;
  if (!isPairingPeerIdentity(value, expectedPeerId)) return false;
  const raw = Buffer.from(value.identityKey, "base64url");
  return raw.byteLength === 33 && raw.toString("base64url") === value.identityKey;
}

function verifyGrantAccessDeviceProof(input: {
  readonly account: AccountAuthorityBinding;
  readonly operationId: string;
  readonly purpose: "grant_access";
  readonly target: AccountActionTarget;
  readonly signature: string;
}): boolean {
  try {
    const raw = Buffer.from(input.target.devicePublicKey, "base64url");
    if (raw.byteLength !== 32 || raw.toString("base64url") !== input.target.devicePublicKey) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]), format: "der", type: "spki" });
    const transcript = canonicalJson({
      account: input.account,
      operationId: input.operationId,
      purpose: input.purpose,
      target: input.target
    });
    return cryptoVerify(null, Buffer.from(transcript, "utf8"), key, Buffer.from(input.signature, "base64url"));
  } catch {
    return false;
  }
}

function accountPairingError(code: string): Error & { code: string } {
  return Object.assign(new Error("Account-managed pairing could not be completed."), { code });
}
