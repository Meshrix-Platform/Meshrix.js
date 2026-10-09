import type {
  AuthenticatedContext
} from "@meshrix/contracts/gateway";
import {
  PRIVATE_RELAY_MODES,
  PRIVATE_RELAY_ROLES,
  parseEndpointTrustBinding
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
}

export interface RecoveryAuthorityRecord {
  readonly recoveryKeyId: string;
  readonly principalRef: string;
  readonly publicKey: string;
  readonly generation: number;
  readonly state: "active" | "rotating" | "revoked" | "superseded";
}

export interface EndpointIdentityDurablePort {
  loadDevices?(): readonly EndpointDeviceRecord[];
  loadRecoveryAuthorities?(): readonly RecoveryAuthorityRecord[];
  saveDevice?(record: EndpointDeviceRecord): void;
  saveRecoveryAuthority?(record: RecoveryAuthorityRecord): void;
  loadRevocationRevision?(tenantId: string): number | undefined;
  saveRevocationRevision?(tenantId: string, revision: number): void;
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
      revoked: false
    });
    const collision = this.#byFingerprint.get(record.pairedIdentityFingerprint);
    if (collision && collision !== record.deviceId) {
      throw Object.assign(new Error("The paired identity fingerprint already belongs to another device."), { code: "ambiguous_identity" });
    }
    this.#devices.set(record.deviceId, record);
    this.#byFingerprint.set(record.pairedIdentityFingerprint, record.deviceId);
    this.#revocationRevisions.set(input.tenantId, currentRevision);
    this.#durable?.saveDevice?.(record);
    return record;
  }

  /** Local revocation takes effect immediately; remote propagation happens on the next authenticated contact. */
  revoke(deviceId: string): EndpointDeviceRecord | undefined {
    const current = this.#devices.get(deviceId);
    if (!current || current.revoked) return current;
    const updated: EndpointDeviceRecord = Object.freeze({ ...current, revoked: true });
    this.#devices.set(deviceId, updated);
    const revision = this.revocationRevision(current.tenantId) + 1;
    this.#revocationRevisions.set(current.tenantId, revision);
    this.#durable?.saveDevice?.(updated);
    this.#durable?.saveRevocationRevision?.(current.tenantId, revision);
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
  }): RecoveryAuthorityRecord {
    const existing = this.#recoveryAuthorities.get(input.recoveryKeyId);
    const record: RecoveryAuthorityRecord = Object.freeze({
      recoveryKeyId: input.recoveryKeyId,
      principalRef: input.principalRef,
      publicKey: input.publicKey,
      generation: input.generation,
      state: existing?.state === "rotating" ? "rotating" : "active"
    });
    this.#recoveryAuthorities.set(record.recoveryKeyId, record);
    this.#durable?.saveRecoveryAuthority?.(record);
    return record;
  }

  setRecoveryAuthorityState(recoveryKeyId: string, state: RecoveryAuthorityRecord["state"]): RecoveryAuthorityRecord | undefined {
    const current = this.#recoveryAuthorities.get(recoveryKeyId);
    if (!current) return undefined;
    const updated = Object.freeze({ ...current, state });
    this.#recoveryAuthorities.set(recoveryKeyId, updated);
    this.#durable?.saveRecoveryAuthority?.(updated);
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
      state: "active"
    });
    this.#recoveryAuthorities.set(candidate.recoveryKeyId, candidate);
    this.#durable?.saveRecoveryAuthority?.(candidate);
    return Object.freeze({ accepted: true });
  }

  completeRecoveryRotation(recoveryKeyId: string): void {
    const incumbent = this.#recoveryAuthorities.get(recoveryKeyId);
    if (incumbent) {
      const superseded = Object.freeze({ ...incumbent, state: "superseded" as const });
      this.#recoveryAuthorities.set(recoveryKeyId, superseded);
      this.#durable?.saveRecoveryAuthority?.(superseded);
    }
  }

  abortRecoveryRotation(recoveryKeyId: string, candidateKeyId: string): void {
    const incumbent = this.#recoveryAuthorities.get(recoveryKeyId);
    if (incumbent) this.setRecoveryAuthorityState(recoveryKeyId, "active");
    this.#recoveryAuthorities.delete(candidateKeyId);
  }
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
