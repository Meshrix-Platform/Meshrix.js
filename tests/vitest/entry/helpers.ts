/**
 * Test doubles for the entry suite.
 *
 * `FakeVault` mirrors the recovery-vault semantics (registered recovery
 * verifier + writer set, single-use proof nonces, CAS writes with idempotent
 * reconcile, generation monotonicity) without importing worker internals —
 * it reuses the wire parsers and the app's own transcript/signature helpers,
 * so client bugs in transcript construction cannot hide.
 *
 * `FakeRecoveryEndpoint` wraps the real gateway `RecoveryAuthorityService` +
 * `EndpointIdentityStore` so challenge issuance/consumption and admission are
 * the actual endpoint behavior, not a reimplementation.
 */
import {
  createVaultFetchRefused,
  createVaultSnapshot,
  createVaultWriteResult,
  parsePrivateRelayRecoveryMessage,
  parseVaultFetch,
  parseVaultWrite
} from "@meshrix/contracts/private-relay";
import {
  verifyEd25519,
  sha256Hex,
  vaultFetchTranscript,
  vaultSnapshotDigest,
  vaultWriteTranscript
} from "@meshrix/entry";
import type { VaultProtectedSnapshot } from "@meshrix/entry";
import type { VaultTransport, VaultTransportResponse } from "@meshrix/entry";

export interface VaultKeyRef {
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly publicKey: string;
}

interface VaultCurrentRecord {
  revision: number;
  generation: number;
  snapshot: { algorithm: string; nonce: string; ciphertext: string; byteLength: number };
  publicVerifier: VaultKeyRef;
  digest: string;
}

export class FakeVault implements VaultTransport {
  readonly vaultId: string;
  recoveryVerifier: VaultKeyRef;
  writers: VaultKeyRef[];
  generation: number;
  current: VaultCurrentRecord | null = null;
  readonly seenNonces = new Set<string>();
  /** Test hook: swallow responses after executing the mutation. */
  dropNextWriteResponse = false;
  fetchCount = 0;
  writeCount = 0;

  constructor(input: { vaultId: string; verifier: VaultKeyRef; writers: VaultKeyRef[]; generation?: number }) {
    this.vaultId = input.vaultId;
    this.recoveryVerifier = input.verifier;
    this.writers = [...input.writers];
    this.generation = input.generation ?? 1;
  }

  /** Nonce bookkeeping: sha256(purpose|keyId|nonce), single use. */
  #consumeNonce(purpose: string, keyId: string, nonce: string): boolean {
    const digest = sha256Hex(`${purpose}|${keyId}|${nonce}`);
    if (this.seenNonces.has(digest)) return false;
    this.seenNonces.add(digest);
    return true;
  }

  async post(input: { vaultId: string; message: Record<string, unknown> }): Promise<VaultTransportResponse> {
    if (input.vaultId !== this.vaultId) {
      return { status: 404, body: { error: "not_found" } };
    }
    const parsed = parsePrivateRelayRecoveryMessage(input.message);
    if (!parsed || input.message.vaultId !== this.vaultId) {
      return { status: 400, body: { error: "unsupported_kind" } };
    }
    if (parsed.kind === "vault-fetch") {
      return this.#handleFetch(parseVaultFetch(input.message)!);
    }
    if (parsed.kind === "vault-write") {
      return this.#handleWrite(parseVaultWrite(input.message)!);
    }
    return { status: 400, body: { error: "unsupported_kind" } };
  }

  #handleFetch(fetch: NonNullable<ReturnType<typeof parseVaultFetch>>): VaultTransportResponse {
    this.fetchCount += 1;
    const refuse = (refusal: string, retryable = false, status = 403): VaultTransportResponse => ({
      status,
      body: createVaultFetchRefused({ vaultId: this.vaultId, refusal, retryable })
    });
    if (!this.current) return refuse("not_found", false, 404);
    const proof = fetch.fetchProof;
    if (proof.keyId !== this.recoveryVerifier.keyId) return refuse("proof_invalid");
    const issued = Date.parse(String(proof.issuedAt));
    if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > 10 * 60_000) {
      return refuse("proof_invalid");
    }
    const valid = verifyEd25519({
      publicKey: this.recoveryVerifier.publicKey,
      signature: String(proof.signature),
      transcript: vaultFetchTranscript(this.vaultId, {
        keyId: String(proof.keyId),
        nonce: String(proof.nonce),
        issuedAt: String(proof.issuedAt)
      })
    });
    if (!valid) return refuse("proof_invalid");
    if (!this.#consumeNonce("vault_fetch", String(proof.keyId), String(proof.nonce))) {
      return refuse("proof_invalid");
    }
    return {
      status: 200,
      body: createVaultSnapshot({
        vaultId: this.vaultId,
        revision: this.current.revision,
        generation: this.current.generation,
        snapshot: this.current.snapshot,
        publicVerifier: this.current.publicVerifier
      })
    };
  }

  #handleWrite(write: NonNullable<ReturnType<typeof parseVaultWrite>>): VaultTransportResponse {
    this.writeCount += 1;
    const refuse = (): VaultTransportResponse => ({
      status: 403,
      body: createVaultWriteResult({ vaultId: this.vaultId, outcome: "refused", currentRevision: 0, committedRevision: 0 })
    });
    const conflict = (): VaultTransportResponse => ({
      status: 409,
      body: createVaultWriteResult({
        vaultId: this.vaultId,
        outcome: "conflict",
        currentRevision: this.current?.revision ?? 0,
        committedRevision: 0
      })
    });
    const committed = (revision: number): VaultTransportResponse => ({
      status: 200,
      body: createVaultWriteResult({
        vaultId: this.vaultId,
        outcome: "committed",
        currentRevision: revision,
        committedRevision: revision
      })
    });
    const writer = this.writers.find((candidate) => candidate.keyId === write.writeAuth.writerKeyId);
    if (!writer) return refuse();
    const currentRevision = this.current?.revision ?? 0;
    const snapshot = write.snapshot;
    if (snapshot.vaultId !== write.vaultId) return refuse();
    if (Number(snapshot.generation) < (this.current?.generation ?? this.generation)) return refuse();
    if (Number(snapshot.revision) !== Number(write.expectedRevision) + 1) return refuse();
    const digest = vaultSnapshotDigest(snapshot as VaultProtectedSnapshot);
    if (digest !== write.writeAuth.snapshotDigest) return refuse();
    if (Number(write.expectedRevision) !== currentRevision) {
      // Idempotent reconcile: retry of the committed write reports committed.
      if (this.current && this.current.digest === digest && Number(write.expectedRevision) === currentRevision - 1) {
        return this.#emit(committed(currentRevision));
      }
      return this.#emit(conflict());
    }
    const valid = verifyEd25519({
      publicKey: writer.publicKey,
      signature: String(write.writeAuth.signature),
      transcript: vaultWriteTranscript(this.vaultId, {
        writerKeyId: String(write.writeAuth.writerKeyId),
        nonce: String(write.writeAuth.nonce),
        snapshotDigest: String(write.writeAuth.snapshotDigest)
      }, Number(write.expectedRevision))
    });
    if (!valid) return refuse();
    if (!this.#consumeNonce("vault_write", writer.keyId, String(write.writeAuth.nonce))) return refuse();
    this.current = {
      revision: Number(snapshot.revision),
      generation: Number(snapshot.generation),
      snapshot: {
        algorithm: String(snapshot.snapshot.algorithm),
        nonce: String(snapshot.snapshot.nonce),
        ciphertext: String(snapshot.snapshot.ciphertext),
        byteLength: Number(snapshot.snapshot.byteLength)
      },
      publicVerifier: {
        keyId: String(snapshot.publicVerifier.keyId),
        algorithm: "Ed25519",
        publicKey: String(snapshot.publicVerifier.publicKey)
      },
      digest
    };
    if (this.current.generation > this.generation) this.generation = this.current.generation;
    return this.#emit(committed(this.current.revision));
  }

  #emit(response: VaultTransportResponse): VaultTransportResponse {
    if (this.dropNextWriteResponse) {
      this.dropNextWriteResponse = false;
      return { status: 0, body: null };
    }
    return response;
  }
}
