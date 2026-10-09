/**
 * Top-level recovery service composing the whole fresh-device flow:
 *
 *   recovery text (the only user-supplied artifact)
 *   → deriveRecoveryMaterial (signing + writer + backup keys)
 *   → vault fetch (recovery-key proof) → decrypt bundle
 *   → EntryRecoverySession (fresh device key in custody, endpoint challenge,
 *     typed proof) → fresh admission requiring mutual-TLS rebind.
 *
 * This composition is what makes recovery possible after every prior entry
 * client is lost: nothing but the user-held text is needed on the fresh
 * profile — no cookie, login, old device key or cached credential is
 * consulted.
 */
import { entryError } from "../errors.ts";
import type { CustodyAdapter } from "../identity/custody.ts";
import type { DeviceIdentity } from "../identity/device-identity.ts";
import { assertBundleRecoverable, type BundleConnection, type EntryRecoveryBundle } from "./bundle.ts";
import { deriveRecoveryMaterial } from "./recovery-crypto.ts";
import { parseRecoveryText, type RecoveryKeyMaterial } from "./recovery-key.ts";
import {
  EntryRecoverySession,
  type RecoveryEndpointPort
} from "./recovery-session.ts";
import type { SnapshotSynchronizer } from "./snapshot-sync.ts";

export interface RecoveryServiceOptions {
  readonly synchronizer: SnapshotSynchronizer;
  readonly endpoint: RecoveryEndpointPort;
  readonly custody: CustodyAdapter;
  readonly now?: () => number;
}

export type FreshRecoveryOutcome =
  | {
      readonly outcome: "enrolled";
      readonly device: DeviceIdentity;
      readonly connection: BundleConnection;
      readonly bundle: EntryRecoveryBundle;
      readonly admissionGeneration: number;
      readonly requiresMutualTlsRebind: true;
      readonly generation: number;
      readonly principalRef: string;
    }
  | { readonly outcome: "refused"; readonly refusal: string }
  | { readonly outcome: "snapshot_missing" }
  | { readonly outcome: "snapshot_unusable"; readonly reason: string };

export class EntryRecoveryService {
  readonly #synchronizer: SnapshotSynchronizer;
  readonly #session: EntryRecoverySession;

  constructor(options: RecoveryServiceOptions) {
    this.#synchronizer = options.synchronizer;
    this.#session = new EntryRecoverySession({
      endpoint: options.endpoint,
      now: options.now
    });
  }

  /**
   * Recover a fresh profile from the user-held recovery text alone.
   * `routeId` selects the connection inside the decrypted bundle; when the
   * bundle holds exactly one connection it may be omitted.
   */
  async recoverFreshProfile(input: {
    readonly recoveryText: string;
    readonly custody: CustodyAdapter;
    readonly routeId?: string;
    readonly deviceId?: string;
  }): Promise<FreshRecoveryOutcome> {
    const key: RecoveryKeyMaterial = parseRecoveryText(input.recoveryText);
    if (!key.vaultId) {
      throw entryError(
        "recovery_locator_missing",
        "Recovery text carries no vault locator; a fresh profile cannot find the snapshot."
      );
    }
    const material = deriveRecoveryMaterial(key.secret);
    const fetched = await this.#synchronizer.fetchSnapshot({
      vaultId: key.vaultId,
      material
    });
    switch (fetched.outcome) {
      case "refused":
        if (fetched.refusal === "not_found") return { outcome: "snapshot_missing" };
        return { outcome: "snapshot_unusable", reason: `vault refused: ${fetched.refusal}` };
      case "decrypt_failed":
        return { outcome: "snapshot_unusable", reason: "decrypt_failed" };
      case "authority_mismatch":
        return { outcome: "snapshot_unusable", reason: "authority_mismatch" };
      case "stale":
      case "invalid_response":
        return { outcome: "snapshot_unusable", reason: fetched.outcome };
      case "snapshot":
        break;
    }
    const bundle = fetched.bundle;
    // Defense in depth: a decryptable bundle is still validated against the
    // forbidden-key surface before anything reads a field from it.
    assertBundleRecoverable(bundle);
    const connection = input.routeId
      ? bundle.connections.find((candidate) => candidate.routeId === input.routeId)
      : bundle.connections.length === 1
        ? bundle.connections[0]
        : null;
    if (!connection) {
      throw entryError(
        "recovery_state_invalid",
        input.routeId
          ? `No recovered connection matches endpoint ${input.routeId}.`
          : "The recovered bundle holds multiple connections; select one by routeId."
      );
    }
    const enrolled = await this.#session.recover({
      material,
      bundle,
      connection,
      custody: input.custody,
      deviceId: input.deviceId
    });
    if (enrolled.outcome === "refused") {
      return { outcome: "refused", refusal: enrolled.refusal };
    }
    return {
      outcome: "enrolled",
      device: enrolled.device,
      connection,
      bundle,
      admissionGeneration: enrolled.admission.admissionGeneration,
      requiresMutualTlsRebind: true,
      generation: enrolled.generation,
      principalRef: enrolled.principalRef
    };
  }
}

export function createEntryRecoveryService(options: RecoveryServiceOptions): EntryRecoveryService {
  return new EntryRecoveryService(options);
}
