/**
 * Automatic encrypted snapshot publication and retrieval.
 *
 * The writer holds a derived backup key (kept in OS custody for routine
 * updates — the recovery root never participates in day-to-day writes) and
 * publishes revisioned EncryptedRecoverySnapshot envelopes through the vault
 * CAS path. On conflict it fetches the committed snapshot, decrypts the
 * concurrent configuration and merges before retrying once — an idempotent
 * retry reuses the exact same ciphertext; a genuinely divergent write is
 * reconciled, never blindly overwritten.
 *
 * Freshness is enforced locally: a durable high-water mark (highest seen
 * generation, then revision) rejects stale snapshots so a backup rollback can
 * never reduce revocation state or resurrect retired trust references.
 */
import {
  PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
  parseEncryptedRecoverySnapshot
} from "@meshrix/contracts/private-relay";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import {
  openRecoverySnapshot,
  sealRecoverySnapshot,
  type RecoveryMaterial
} from "./recovery-crypto.ts";
import {
  mergeRecoveryBundles,
  parseEntryRecoveryBundle,
  type EntryRecoveryBundle
} from "./bundle.ts";
import { sha256Hex } from "../keys.ts";
import { vaultSnapshotDigest } from "../transcripts.ts";
import type { VaultProtectedSnapshot } from "../transcripts.ts";
import type {
  RecoveryVaultClient,
  VaultSigningMaterial,
  VaultSnapshotView
} from "./vault-client.ts";

export const ENTRY_SNAPSHOT_FORMAT_VERSION = 1;

/** Exact encrypted operation retained until its result is durable. No plaintext or keys. */
export interface PendingSnapshotWrite {
  readonly vaultId: string;
  readonly writerKeyId: string;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly inputDigest: string;
  readonly snapshot: Record<string, unknown>;
}

/** Durable high-water + last-committed bookkeeping. */
export interface SnapshotJournal {
  readonly pendingWrite?: PendingSnapshotWrite | null;
  readonly lastCommitted: {
    readonly revision: number;
    readonly generation: number;
    readonly digest: string;
  } | null;
  readonly highestSeen: {
    readonly revision: number;
    readonly generation: number;
  } | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
}

export interface SnapshotJournalPort {
  load(): SnapshotJournal | null;
  save(journal: SnapshotJournal): void | Promise<void>;
}

export class InMemorySnapshotJournal implements SnapshotJournalPort {
  #journal: SnapshotJournal | null = null;
  load(): SnapshotJournal | null {
    return this.#journal;
  }
  save(journal: SnapshotJournal): void {
    this.#journal = journal;
  }
}

export type PublishOutcome =
  | { readonly outcome: "committed"; readonly revision: number; readonly digest: string }
  | { readonly outcome: "conflict_unresolved"; readonly currentRevision: number }
  | { readonly outcome: "conflict_undecryptable"; readonly currentRevision: number }
  | { readonly outcome: "superseded"; readonly generation: number }
  | { readonly outcome: "refused"; readonly retryable?: boolean }
  | { readonly outcome: "invalid_response" };

export type FetchOutcome =
  | { readonly outcome: "snapshot"; readonly bundle: EntryRecoveryBundle; readonly revision: number; readonly generation: number; readonly publicVerifier: VaultSnapshotView["publicVerifier"] }
  | { readonly outcome: "stale"; readonly revision: number; readonly generation: number }
  | { readonly outcome: "refused"; readonly refusal: string; readonly retryable: boolean }
  | { readonly outcome: "decrypt_failed" }
  | { readonly outcome: "authority_mismatch" }
  | { readonly outcome: "invalid_response" };

function snapshotEnvelope(input: {
  readonly bundle: EntryRecoveryBundle;
  readonly backupKey: Uint8Array;
  readonly vaultId: string;
  readonly generation: number;
  readonly revision: number;
  readonly publicVerifier: { keyId: string; algorithm: string; publicKey: string };
}): Record<string, unknown> {
  const aead = sealRecoverySnapshot({
    plaintext: new TextEncoder().encode(canonicalJson(input.bundle)),
    backupKey: input.backupKey,
    vaultId: input.vaultId,
    formatVersion: ENTRY_SNAPSHOT_FORMAT_VERSION,
    generation: input.generation,
    revision: input.revision
  });
  return {
    schemaVersion: PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION,
    kind: "encrypted-recovery-snapshot",
    vaultId: input.vaultId,
    formatVersion: ENTRY_SNAPSHOT_FORMAT_VERSION,
    generation: input.generation,
    revision: input.revision,
    snapshot: { ...aead },
    publicVerifier: { ...input.publicVerifier }
  };
}

export class SnapshotSynchronizer {
  readonly #vault: RecoveryVaultClient;
  readonly #journal: SnapshotJournalPort;
  readonly #now: () => number;

  constructor(options: {
    vault: RecoveryVaultClient;
    journal?: SnapshotJournalPort;
    now?: () => number;
  }) {
    this.#vault = options.vault;
    this.#journal = options.journal ?? new InMemorySnapshotJournal();
    this.#now = options.now ?? (() => Date.now());
  }

  #loadJournal(): SnapshotJournal {
    return this.#journal.load() ?? {
      lastCommitted: null,
      highestSeen: null,
      lastSuccessAt: null,
      lastError: null
    };
  }

  async #saveJournal(patch: Partial<SnapshotJournal>): Promise<void> {
    await this.#journal.save({ ...this.#loadJournal(), ...patch });
  }

  /** Current committed revision (0 when nothing committed yet). */
  committedRevision(): number {
    return this.#loadJournal().lastCommitted?.revision ?? 0;
  }

  /**
   * Publish one revisioned snapshot of the current bundle. A single
   * idempotent writer path: conflict → fetch → decrypt the concurrent
   * configuration → merge → one reconcile write. Outcomes stay typed and
   * honest; a retry of the same attempt reuses the same ciphertext.
   */
  async publish(input: {
    readonly vaultId: string;
    readonly bundle: EntryRecoveryBundle;
    readonly material: RecoveryMaterial;
    /** Existing remote base already fetched and decrypted with retained local
     * material. The next CAS write merges it and starts from its exact
     * revision, preventing an equal cached revision from replacing ciphertext. */
    readonly baseSnapshot?: Pick<Extract<FetchOutcome, { outcome: "snapshot" }>, "bundle" | "revision" | "generation">;
    /** Retained local materials used if a concurrent CAS writer changed the
     * committed head after baseSnapshot was fetched. */
    readonly decryptWith?: readonly RecoveryMaterial[];
    /**
     * The current recovery-authority generation this snapshot claims —
     * supplied by the caller from the connection's authority record. A stale
     * cached value is refused by the vault, never silently promoted.
     */
    readonly generation: number;
  }): Promise<PublishOutcome> {
    const journal = this.#loadJournal();
    const generation = Math.max(input.generation, input.baseSnapshot?.generation ?? 0, journal.highestSeen?.generation ?? 0, 1);
    const pending = journal.pendingWrite;
    const retained = pending && pending.vaultId === input.vaultId
      && pending.writerKeyId === input.material.writer.keyId && pending.generation === generation
      ? pending : null;
    const expected = retained?.expectedRevision ?? input.baseSnapshot?.revision ?? journal.lastCommitted?.revision ?? 0;
    // The effective generation is the caller's authority view raised by any
    // higher generation already observed; it can only move forward.
    const bundle = input.baseSnapshot
      ? mergeRecoveryBundles(input.bundle, input.baseSnapshot.bundle, { now: this.#now })
      : input.bundle;

    // Journal/last-attempt bookkeeping keys the same canonical
    // full-protected-snapshot digest the vault verifies. Envelopes produced
    // by snapshotEnvelope always satisfy the wire schema; a foreign record
    // falls back to hashing its canonical JSON so bookkeeping stays unique
    // without inventing a second protected-snapshot digest.
    const digestOf = (snapshot: Record<string, unknown>): string => {
      const parsed = parseEncryptedRecoverySnapshot(snapshot);
      return parsed
        ? vaultSnapshotDigest(parsed as VaultProtectedSnapshot)
        : `sha256:${sha256Hex(canonicalJson(snapshot))}`;
    };

    const inputDigest = sha256Hex(canonicalJson({ ...input.bundle, createdAt: undefined }));
    const snapshot = retained
      ? retained.snapshot
      : snapshotEnvelope({
          bundle,
          backupKey: input.material.backupKey,
          vaultId: input.vaultId,
          generation,
          revision: expected + 1,
          publicVerifier: {
            keyId: input.material.signing.keyId,
            algorithm: "Ed25519",
            publicKey: input.material.signing.publicKey
          }
        });
    await this.#saveJournal({ pendingWrite: retained ?? {
      vaultId: input.vaultId, writerKeyId: input.material.writer.keyId,
      generation, expectedRevision: expected, inputDigest, snapshot
    } });

    const attempt = await this.#vault.writeSnapshot({
      vaultId: input.vaultId,
      expectedRevision: expected,
      snapshot,
      writerKey: input.material.writer
    });

    if (attempt.outcome === "committed") {
      await this.#saveJournal({
        pendingWrite: null,
        lastCommitted: { revision: attempt.committedRevision, generation, digest: digestOf(snapshot) },
        highestSeen: { revision: attempt.committedRevision, generation },
        lastSuccessAt: new Date(this.#now()).toISOString(),
        lastError: null
      });
      // Finish a retained operation first; a changed configuration then gets
      // its own revision. This is finite, explicit work, never background retry.
      if (retained && retained.inputDigest !== inputDigest) {
        const envelope = parseEncryptedRecoverySnapshot(snapshot)!;
        const retainedBundle = parseEntryRecoveryBundle(JSON.parse(new TextDecoder().decode(openRecoverySnapshot({
          envelope: envelope.snapshot, backupKey: input.material.backupKey,
          vaultId: input.vaultId, formatVersion: envelope.formatVersion,
          generation: envelope.generation, revision: envelope.revision
        }))));
        if (!retainedBundle) return { outcome: "invalid_response" };
        return this.publish({ ...input,
          bundle: mergeRecoveryBundles(bundle, retainedBundle, { now: this.#now }),
          baseSnapshot: undefined });
      }
      return { outcome: "committed", revision: attempt.committedRevision, digest: digestOf(snapshot) };
    }
    if (attempt.outcome === "refused") {
      if (attempt.retryable) {
        await this.#saveJournal({ lastError: "vault_write_capacity" });
        return { outcome: "refused", retryable: true };
      }
      // A refused write may mean this writer's generation was superseded —
      // probe the committed snapshot once to report that honestly instead of
      // a bare refusal (e.g. after rotation, the old generation is refused).
      const probe = await this.fetchSnapshot({
        vaultId: input.vaultId,
        material: input.material,
        decryptWith: input.decryptWith,
        checkVerifier: false
      });
      if (probe.outcome === "snapshot" && probe.generation > generation) {
        return { outcome: "superseded", generation: probe.generation };
      }
      await this.#saveJournal({ lastError: "vault_write_refused" });
      return { outcome: "refused" };
    }
    if (attempt.outcome === "invalid_response") {
      await this.#saveJournal({ lastError: "vault_write_invalid_response" });
      return { outcome: "invalid_response" };
    }

    // CAS conflict: reconcile once. Fetch the committed snapshot; if it is
    // our own ciphertext the write already landed (idempotent retransmission);
    // a foreign snapshot must be decryptable under our backup key to merge.
    const remote = await this.fetchSnapshot({
      vaultId: input.vaultId,
      material: input.material,
      decryptWith: input.decryptWith,
      checkVerifier: false
    });
    if (remote.outcome === "refused") {
      await this.#saveJournal({ lastError: `vault_fetch_refused:${remote.refusal}` });
      return { outcome: "conflict_unresolved", currentRevision: attempt.currentRevision };
    }
    if (remote.outcome !== "snapshot" && remote.outcome !== "stale") {
      return { outcome: "conflict_undecryptable", currentRevision: attempt.currentRevision };
    }
    if (remote.generation > generation) {
      // A newer recovery generation already owns the vault — this writer is
      // superseded; surface it instead of rolling anything back.
      return { outcome: "superseded", generation: remote.generation };
    }
    const merged = remote.outcome === "snapshot"
      ? mergeRecoveryBundles(bundle, remote.bundle, { now: this.#now })
      : bundle;
    const reconciled = snapshotEnvelope({
      bundle: merged,
      backupKey: input.material.backupKey,
      vaultId: input.vaultId,
      generation,
      revision: attempt.currentRevision + 1,
      publicVerifier: {
        keyId: input.material.signing.keyId,
        algorithm: "Ed25519",
        publicKey: input.material.signing.publicKey
      }
    });
    await this.#saveJournal({ pendingWrite: {
      vaultId: input.vaultId, writerKeyId: input.material.writer.keyId,
      generation, expectedRevision: attempt.currentRevision, inputDigest,
      snapshot: reconciled
    } });
    const retry = await this.#vault.writeSnapshot({
      vaultId: input.vaultId,
      expectedRevision: attempt.currentRevision,
      snapshot: reconciled,
      writerKey: input.material.writer
    });
    if (retry.outcome === "committed") {
      await this.#saveJournal({
        pendingWrite: null,
        lastCommitted: { revision: retry.committedRevision, generation, digest: digestOf(reconciled) },
        highestSeen: { revision: retry.committedRevision, generation },
        lastSuccessAt: new Date(this.#now()).toISOString(),
        lastError: null
      });
      return { outcome: "committed", revision: retry.committedRevision, digest: digestOf(reconciled) };
    }
    await this.#saveJournal({ lastError: retry.outcome === "refused" && retry.retryable
      ? "vault_write_capacity" : `vault_write_${retry.outcome}` });
    return retry.outcome === "conflict"
      ? { outcome: "conflict_unresolved", currentRevision: retry.currentRevision }
      : { outcome: "refused", ...(retry.outcome === "refused" && retry.retryable ? { retryable: true } : {}) };
  }

  /**
   * Fetch and locally decrypt the committed snapshot. The returned bundle is
   * configuration only — trust references inside it remain inactive until the
   * current endpoint validates them.
   */
  async fetchSnapshot(input: {
    readonly vaultId: string;
    /** Material used to decrypt the stored envelope and check its public verifier. */
    readonly material: RecoveryMaterial;
    /** Optional current authority key used to authenticate fetch after writer
     * registration changed the vault verifier while ciphertext is still under
     * a retained older local key. */
    readonly fetchKey?: VaultSigningMaterial;
    /** Additional retained local materials tried against the fetched
     * snapshot's own verifier/ciphertext without repeating the network read. */
    readonly decryptWith?: readonly RecoveryMaterial[];
    /** Assert the vault verifier matches the derived recovery signing key. */
    readonly checkVerifier?: boolean;
  }): Promise<FetchOutcome> {
    const fetched = await this.#vault.fetchSnapshot({
      vaultId: input.vaultId,
      recoveryKey: input.fetchKey ?? input.material.signing
    });
    if (fetched.outcome === "refused") {
      return { outcome: "refused", refusal: fetched.refusal, retryable: fetched.retryable };
    }
    if (fetched.outcome !== "snapshot") return { outcome: "invalid_response" };
    const view = fetched.snapshot;
    let last: FetchOutcome = { outcome: "invalid_response" };
    const materials = [input.material, ...(input.decryptWith ?? [])];
    const tried = new Set<string>();
    for (const material of materials) {
      if (tried.has(material.signing.keyId)) continue;
      tried.add(material.signing.keyId);
      last = await this.#decryptView({ ...input, material }, view);
      if (last.outcome !== "authority_mismatch" && last.outcome !== "decrypt_failed") return last;
    }
    return last;
  }

  async #decryptView(
    input: { vaultId: string; material: RecoveryMaterial; checkVerifier?: boolean },
    view: VaultSnapshotView
  ): Promise<FetchOutcome> {
    if (input.checkVerifier !== false) {
      const verifier = view.publicVerifier;
      if (
        verifier.algorithm !== "Ed25519"
        || verifier.keyId !== input.material.signing.keyId
        || verifier.publicKey !== input.material.signing.publicKey
      ) {
        return { outcome: "authority_mismatch" };
      }
    }
    const journal = this.#loadJournal();
    const high = journal.highestSeen;
    // Stale means strictly older than what was already seen — re-fetching the
    // committed head itself is never stale.
    if (high && (view.generation < high.generation
      || (view.generation === high.generation && view.revision < high.revision))) {
      return { outcome: "stale", revision: view.revision, generation: view.generation };
    }
    let plaintext: Uint8Array;
    try {
      plaintext = openRecoverySnapshot({
        envelope: view.snapshot,
        backupKey: input.material.backupKey,
        vaultId: view.vaultId,
        formatVersion: ENTRY_SNAPSHOT_FORMAT_VERSION,
        generation: view.generation,
        revision: view.revision
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "snapshot_decrypt_failed") {
        return { outcome: "decrypt_failed" };
      }
      return { outcome: "invalid_response" };
    }
    let bundle: EntryRecoveryBundle | null;
    try {
      bundle = parseEntryRecoveryBundle(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch {
      return { outcome: "invalid_response" };
    }
    if (!bundle) return { outcome: "invalid_response" };
    await this.#saveJournal({ highestSeen: { revision: view.revision, generation: view.generation } });
    return {
      outcome: "snapshot",
      bundle,
      revision: view.revision,
      generation: view.generation,
      publicVerifier: view.publicVerifier
    };
  }
}

export function createSnapshotSynchronizer(options: ConstructorParameters<typeof SnapshotSynchronizer>[0]): SnapshotSynchronizer {
  return new SnapshotSynchronizer(options);
}

// parseEncryptedRecoverySnapshot is re-exported for callers validating a raw
// vault-snapshot view before handing it to openRecoverySnapshot.
export { parseEncryptedRecoverySnapshot };
