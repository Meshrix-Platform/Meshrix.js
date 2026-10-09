import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  createRecoveryChallenge,
  createRecoveryResult,
  createRotationState,
  parseRecoveryProof,
  parseRecoveryRequest,
  recoveryChannelAdmitsOnlyRecovery
} from "@meshrix/contracts/private-relay";
import type { EndpointIdentityStore } from "./identity-store.ts";

/**
 * Endpoint-side recovery authority service.
 *
 * Implements the recover_device flow: an endpoint-owned, purpose-bound,
 * single-use challenge answered by a fresh-device root-possession proof.
 * Recovery never relies on an old device cookie or certificate, never imports
 * semantic grants from a backup, and preserves all current revocations.
 * Proof secrets are never logged.
 */

export interface RecoverySigner {
  /** Sign the canonical transcript with the endpoint's current recovery-signing key. */
  sign(transcript: unknown): string;
  /** Verify a recovery proof signature under the enrolled recovery authority key. */
  verify(input: { publicKey: string; signature: string; transcript: unknown }): boolean;
}

export interface RecoveryClock {
  now(): number;
}

export interface IssuedRecoveryChallenge {
  readonly challengeId: string;
  readonly endpointRouteId: string;
  readonly principalRef: string;
  readonly generation: number;
  readonly nonce: string;
  readonly freshDevicePublicKey: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  consumed: boolean;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 1_024;

export class RecoveryAuthorityService {
  readonly #identity: EndpointIdentityStore;
  readonly #signer: RecoverySigner;
  readonly #clock: RecoveryClock;
  readonly #challenges = new Map<string, IssuedRecoveryChallenge>();
  readonly #rotations = new Map<string, { rotationId: string; recoveryKeyId: string; state: string; acknowledged: Set<string>; pending: Set<string> }>();

  constructor(options: {
    identity: EndpointIdentityStore;
    signer: RecoverySigner;
    clock?: RecoveryClock;
  }) {
    this.#identity = options.identity;
    this.#signer = options.signer;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  #sweep(now: number): void {
    if (this.#challenges.size <= MAX_CHALLENGES) {
      for (const [id, challenge] of this.#challenges) {
        if (challenge.expiresAt <= now) this.#challenges.delete(id);
      }
      return;
    }
    // Hard bound: when the cap is reached, evict oldest regardless of expiry.
    const entries = [...this.#challenges.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [id] of entries.slice(0, this.#challenges.size - MAX_CHALLENGES + 1)) {
      this.#challenges.delete(id);
    }
  }

  /** Handle a wire-level recovery-request; returns the challenge message. */
  beginRecovery(request: unknown): ReturnType<typeof createRecoveryChallenge> | null {
    const parsed = parseRecoveryRequest(request);
    if (!parsed) return null;
    const now = this.#clock.now();
    this.#sweep(now);
    const authority = [...this.#identity.recoveryAuthorities()]
      .find((entry) => entry.state === "active" || entry.state === "rotating");
    if (!authority) return null;
    const challengeId = `rch.${now.toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
    const nonce = `rn.${challengeId}.${Math.random().toString(36).slice(2, 14)}`;
    const challenge: IssuedRecoveryChallenge = {
      challengeId,
      endpointRouteId: String(parsed.endpointRouteId),
      principalRef: authority.principalRef,
      generation: authority.generation,
      nonce,
      freshDevicePublicKey: String(parsed.freshDevicePublicKey),
      issuedAt: now,
      expiresAt: now + DEFAULT_CHALLENGE_TTL_MS,
      consumed: false
    };
    this.#challenges.set(challengeId, challenge);
    return createRecoveryChallenge({
      challengeId: challenge.challengeId,
      endpointRouteId: challenge.endpointRouteId,
      principalRef: challenge.principalRef,
      generation: challenge.generation,
      nonce: challenge.nonce,
      freshDevicePublicKey: challenge.freshDevicePublicKey,
      issuedAt: new Date(challenge.issuedAt).toISOString(),
      expiresAt: new Date(challenge.expiresAt).toISOString()
    });
  }

  /**
   * Complete recovery: verify the fresh-device proof against the live
   * challenge and current recovery authority, then mint a device admission.
   */
  completeRecovery(proof: unknown): ReturnType<typeof createRecoveryResult> | null {
    const parsed = parseRecoveryProof(proof);
    if (!parsed) return null;
    const now = this.#clock.now();
    const challenge = this.#challenges.get(String(parsed.challengeId));
    if (!challenge) {
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "challenge_expired" });
    }
    if (challenge.consumed) {
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "challenge_consumed" });
    }
    if (challenge.expiresAt <= now) {
      this.#challenges.delete(challenge.challengeId);
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "challenge_expired" });
    }
    if (challenge.freshDevicePublicKey !== parsed.freshDevicePublicKey) {
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "key_possession_mismatch" });
    }

    const authority = [...this.#identity.recoveryAuthorities()]
      .find((entry) => entry.state === "active" || entry.state === "rotating");
    if (!authority) {
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "authority_revoked" });
    }
    if (authority.state === "revoked" || authority.generation > Number(parsed.generation)) {
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "stale_generation" });
    }

    const transcript = canonicalJson({
      challengeId: parsed.challengeId,
      endpointRouteId: parsed.endpointRouteId,
      principalRef: parsed.principalRef,
      generation: parsed.generation,
      freshDeviceId: parsed.freshDeviceId,
      freshDevicePublicKey: parsed.freshDevicePublicKey,
      purpose: "recover_device"
    });
    const verified = this.#signer.verify({
      publicKey: String(parsed.freshDevicePublicKey),
      signature: String(parsed.signature),
      transcript
    });
    if (!verified) {
      return createRecoveryResult({ challengeId: parsed.challengeId, outcome: "refused", refusal: "key_possession_mismatch" });
    }

    challenge.consumed = true;
    this.#challenges.delete(challenge.challengeId);

    const device = this.#identity.enroll({
      deviceId: String(parsed.freshDeviceId),
      routeId: String(parsed.endpointRouteId),
      tenantId: "recovery",
      trustBinding: {
        schemaVersion: "v0.0.1:private-relay:recovery-1",
        kind: "endpoint-trust-binding",
        pairedIdentityKey: parsed.freshDevicePublicKey,
        pairedIdentityFingerprint: `fp.recovered.${parsed.freshDeviceId}`,
        mode: "personal",
        role: "entry",
        trustGeneration: authority.generation,
        endpointPrincipalRef: parsed.principalRef,
        capabilityGrantRef: "none",
        boundRecoveryKeyId: authority.recoveryKeyId
      }
    });
    return createRecoveryResult({
      challengeId: parsed.challengeId,
      outcome: "enrolled",
      deviceAdmission: {
        deviceId: device.deviceId,
        admissionGeneration: device.admissionGeneration,
        requiresMutualTlsRebind: true
      }
    });
  }

  /** Whether a message kind is legal on the recovery-only channel. */
  admitsKind(kind: unknown): boolean {
    return recoveryChannelAdmitsOnlyRecovery(kind, "recover_device");
  }

  rotationState(rotationId: string): ReturnType<typeof createRotationState> | null {
    const rotation = this.#rotations.get(rotationId);
    if (!rotation) return null;
    return createRotationState({
      rotationId: rotation.rotationId,
      state: rotation.state,
      acknowledged: [...rotation.acknowledged],
      pending: [...rotation.pending]
    });
  }
}

export function createRecoveryAuthorityService(options: ConstructorParameters<typeof RecoveryAuthorityService>[0]): RecoveryAuthorityService {
  return new RecoveryAuthorityService(options);
}
