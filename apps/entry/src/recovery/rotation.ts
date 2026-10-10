/**
 * Staged per-endpoint recovery-key replacement.
 *
 * One recovery key is active; a replacement is explicitly staged, published
 * to the vault under the next generation, and then acknowledged endpoint by
 * endpoint. The contract pins `globalComplete` to false and forbids claiming
 * `completed` while endpoints remain pending — this model derives its wire
 * view through `createRotationState`/`rotationTransition` so dishonest global
 * claims are structurally impossible.
 *
 * Interruption safety: the incumbent material and the last committed snapshot
 * are never discarded mid-rotation. A crash between staging and
 * acknowledgement leaves a resumable/abortable record; the incumbent key
 * keeps working until every endpoint acknowledges the candidate.
 */
import {
  createRotationBegin,
  createRotationState,
  rotationTransition
} from "@meshrix/contracts/private-relay";
import { entryError } from "../errors.ts";
import { freshNonceToken, randomOpaqueId, signEd25519 } from "../keys.ts";
import { vaultFetchTranscript } from "../transcripts.ts";
import type { RecoveryMaterial } from "./recovery-crypto.ts";
import {
  ENTRY_RECOVERY_FORMAT_VERSION,
  generateRecoveryKey,
  type RecoveryKeyMaterial
} from "./recovery-key.ts";
import { deriveRecoveryMaterial } from "./recovery-crypto.ts";

export type RotationState =
  | "staged"
  | "published"
  | "acknowledging"
  | "completed"
  | "aborted";

export type EndpointAckState =
  | "pending"
  | "staged"
  | "acknowledged"
  | "unreachable"
  | "refused";

export interface RotationEndpointStatus {
  readonly endpointRouteId: string;
  readonly state: EndpointAckState;
  readonly detail?: string;
}

/**
 * A built `rotation-begin` wire message bound to one endpoint. Persisted with
 * the rotation record so an in-flight rotation can be re-delivered after a
 * restart — the payload carries only public keys and an administration
 * signature, never secret material.
 */
export interface RotationOutboundMessage {
  readonly endpointRouteId: string;
  readonly message: Record<string, unknown>;
}

export interface RecoveryRotation {
  readonly rotationId: string;
  readonly incumbentKeyId: string;
  readonly incumbentGeneration: number;
  readonly candidateKeyId: string;
  readonly candidatePublicKey: string;
  readonly candidateGeneration: number;
  readonly principalRef: string;
  readonly state: RotationState;
  readonly endpoints: readonly RotationEndpointStatus[];
  /** The per-endpoint `rotation-begin` payloads — replayable for redelivery. */
  readonly outbound: readonly RotationOutboundMessage[];
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface RotationDurablePort {
  load(rotationId: string): RecoveryRotation | null;
  loadAll(): readonly RecoveryRotation[];
  save(rotation: RecoveryRotation): void;
  delete(rotationId: string): void;
}

export class InMemoryRotationStore implements RotationDurablePort {
  #records = new Map<string, RecoveryRotation>();
  load(rotationId: string): RecoveryRotation | null {
    return this.#records.get(rotationId) ?? null;
  }
  loadAll(): readonly RecoveryRotation[] {
    return [...this.#records.values()];
  }
  save(rotation: RecoveryRotation): void {
    this.#records.set(rotation.rotationId, rotation);
  }
  delete(rotationId: string): void {
    this.#records.delete(rotationId);
  }
}

/**
 * Administration proof for `rotation-begin`, in the contract's
 * VaultFetchProof shape ({keyId, nonce, issuedAt, signature}) signed by the
 * incumbent recovery signing key over the vault_fetch transcript for the
 * rotation's vault — proving incumbent possession without exposing it.
 */
function administrationProof(input: {
  material: RecoveryMaterial;
  vaultId: string;
  now: number;
  nonce: string;
}): { keyId: string; nonce: string; issuedAt: string; signature: string } {
  const proof = {
    keyId: input.material.signing.keyId,
    nonce: input.nonce,
    issuedAt: new Date(input.now).toISOString()
  };
  return {
    ...proof,
    signature: signEd25519(input.material.signing.privateKey, vaultFetchTranscript(input.vaultId, proof))
  };
}

export class RecoveryRotationManager {
  readonly #store: RotationDurablePort;
  readonly #now: () => number;
  readonly #nonceFactory: () => string;

  constructor(options: {
    store?: RotationDurablePort;
    now?: () => number;
    nonceFactory?: () => string;
  } = {}) {
    this.#store = options.store ?? new InMemoryRotationStore();
    this.#now = options.now ?? (() => Date.now());
    this.#nonceFactory = options.nonceFactory ?? (() => freshNonceToken("rn.rot"));
  }

  /** The active rotation for a recovery key, if one is in flight. */
  activeRotationFor(keyId: string): RecoveryRotation | null {
    return this.#store.loadAll().find(
      (rotation) => rotation.incumbentKeyId === keyId
        && rotation.state !== "completed"
        && rotation.state !== "aborted"
    ) ?? null;
  }

  get(rotationId: string): RecoveryRotation | null {
    return this.#store.load(rotationId);
  }

  /** Every persisted rotation record, including terminal ones. */
  loadAll(): readonly RecoveryRotation[] {
    return this.#store.loadAll();
  }

  /**
   * Stage a replacement: generates (or accepts) the candidate secret, derives
   * its material, and emits a `rotation-begin` per endpoint. Nothing is
   * published yet — the incumbent remains the only active key.
   */
  begin(input: {
    readonly incumbent: RecoveryMaterial;
    readonly incumbentGeneration: number;
    readonly principalRef: string;
    readonly vaultId: string;
    readonly endpointRouteIds: readonly string[];
    readonly candidateSecret?: Uint8Array;
  }): { rotation: RecoveryRotation; messages: Record<string, unknown>[]; candidate: RecoveryKeyMaterial } {
    if (this.activeRotationFor(input.incumbent.signing.keyId)) {
      throw entryError("rotation_state_invalid", "A rotation for this recovery key is already in flight.");
    }
    const candidate: RecoveryKeyMaterial = input.candidateSecret
      ? Object.freeze({
          secret: input.candidateSecret,
          vaultId: input.vaultId,
          formatVersion: ENTRY_RECOVERY_FORMAT_VERSION
        })
      : generateRecoveryKey({ vaultId: input.vaultId });
    const candidateMaterial = deriveRecoveryMaterial(candidate.secret);
    const nowIso = new Date(this.#now()).toISOString();
    const rotationId = randomOpaqueId("rot.entry", 8);
    const messages = input.endpointRouteIds.map((endpointRouteId) => createRotationBegin({
      rotationId: `${rotationId}:${endpointRouteId}`,
      recoveryKeyId: input.incumbent.signing.keyId,
      principalRef: input.principalRef,
      currentGeneration: input.incumbentGeneration,
      candidateGeneration: input.incumbentGeneration + 1,
      candidatePublicKey: candidateMaterial.signing.publicKey,
      administrationProof: administrationProof({
        material: input.incumbent,
        vaultId: input.vaultId,
        now: this.#now(),
        nonce: this.#nonceFactory()
      })
    }) as Record<string, unknown>);
    const rotation: RecoveryRotation = Object.freeze({
      rotationId,
      incumbentKeyId: input.incumbent.signing.keyId,
      incumbentGeneration: input.incumbentGeneration,
      candidateKeyId: candidateMaterial.signing.keyId,
      candidatePublicKey: candidateMaterial.signing.publicKey,
      candidateGeneration: input.incumbentGeneration + 1,
      principalRef: input.principalRef,
      state: "staged",
      endpoints: Object.freeze(input.endpointRouteIds.map((endpointRouteId) => Object.freeze({
        endpointRouteId,
        state: "pending" as const
      }))),
      outbound: Object.freeze(input.endpointRouteIds.map((endpointRouteId, index) => Object.freeze({
        endpointRouteId,
        message: messages[index]
      }))),
      startedAt: nowIso,
      updatedAt: nowIso
    });
    this.#store.save(rotation);
    return { rotation, messages, candidate };
  }

  #transition(rotation: RecoveryRotation, event: string): RecoveryRotation {
    const next = rotationTransition(rotation.state, event);
    if (!next) {
      throw entryError(
        "rotation_state_invalid",
        `Rotation ${rotation.rotationId} in state ${rotation.state} cannot apply ${event}.`
      );
    }
    const updated = Object.freeze({
      ...rotation,
      state: next as RotationState,
      updatedAt: new Date(this.#now()).toISOString()
    });
    this.#store.save(updated);
    return updated;
  }

  /** Mark the candidate snapshot published to the vault (generation+1). */
  markPublished(rotationId: string): RecoveryRotation {
    const rotation = this.#require(rotationId);
    return this.#transition(rotation, "publish");
  }

  /**
   * Record a per-endpoint outcome. The first acknowledgement moves the
   * rotation to `acknowledging`; completion requires every endpoint
   * acknowledged — offline endpoints keep it pending forever, honestly.
   */
  markEndpoint(rotationId: string, endpointRouteId: string, outcome: "staged" | "acknowledged" | "unreachable" | "refused"): RecoveryRotation {
    let rotation = this.#require(rotationId);
    const index = rotation.endpoints.findIndex((entry) => entry.endpointRouteId === endpointRouteId);
    if (index < 0) {
      throw entryError("rotation_state_invalid", `Endpoint ${endpointRouteId} is not part of rotation ${rotationId}.`);
    }
    if (outcome === "acknowledged" && rotation.state === "published") {
      rotation = this.#transition(rotation, "acknowledge");
    }
    const endpoints = rotation.endpoints.map((entry, i) =>
      i === index ? Object.freeze({ ...entry, state: outcome }) : entry);
    rotation = Object.freeze({ ...rotation, endpoints: Object.freeze(endpoints), updatedAt: new Date(this.#now()).toISOString() });
    // Completion is per-endpoint exhaustive: `complete` is only legal once
    // every endpoint acknowledged — the wire view keeps globalComplete false
    // regardless.
    if (rotation.state === "acknowledging" && endpoints.every((entry) => entry.state === "acknowledged")) {
      const next = rotationTransition(rotation.state, "complete");
      rotation = Object.freeze({
        ...rotation,
        state: (next ?? rotation.state) as RotationState,
        updatedAt: new Date(this.#now()).toISOString()
      });
    }
    this.#store.save(rotation);
    return rotation;
  }

  /**
   * The built `rotation-begin` payloads for endpoints that have not yet
   * acknowledged — the redelivery surface. Re-sending an identical wire
   * message is idempotent on the endpoint (staging the same candidate twice
   * is a no-op), so a retry only replays the failed deliveries and keeps
   * every completed acknowledgement intact.
   */
  pendingOutbound(rotationId: string): readonly RotationOutboundMessage[] {
    const rotation = this.#require(rotationId);
    return rotation.outbound.filter((entry) =>
      rotation.endpoints.find((endpoint) => endpoint.endpointRouteId === entry.endpointRouteId)?.state !== "acknowledged");
  }

  /**
   * Abort a non-terminal rotation. Endpoints keep the incumbent; the
   * candidate material is dropped by the caller (nothing secret persisted).
   */
  abort(rotationId: string): RecoveryRotation {
    return this.#transition(this.#require(rotationId), "abort");
  }

  /** Wire-shaped per-endpoint view; `globalComplete` is pinned false. */
  wireState(rotationId: string): Record<string, unknown> {
    const rotation = this.#require(rotationId);
    return createRotationState({
      rotationId: rotation.rotationId,
      state: rotation.state,
      acknowledged: rotation.endpoints
        .filter((entry) => entry.state === "acknowledged")
        .map((entry) => entry.endpointRouteId),
      pending: rotation.endpoints
        .filter((entry) => entry.state !== "acknowledged")
        .map((entry) => entry.endpointRouteId)
    }) as Record<string, unknown>;
  }

  #require(rotationId: string): RecoveryRotation {
    const rotation = this.#store.load(rotationId);
    if (!rotation) {
      throw entryError("rotation_state_invalid", `Unknown rotation ${rotationId}.`);
    }
    return rotation;
  }
}

export function createRecoveryRotationManager(options: ConstructorParameters<typeof RecoveryRotationManager>[0] = {}): RecoveryRotationManager {
  return new RecoveryRotationManager(options);
}
