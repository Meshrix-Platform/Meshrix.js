/**
 * RecoveryVaultDO — bounded opaque recovery-snapshot storage.
 *
 * One Durable Object instance per vaultId stores the committed
 * EncryptedRecoverySnapshot (ciphertext envelope + public verifier + opaque
 * metadata), a single bounded staged-replacement slot, the registered writer
 * keys, the recovery fetch verifier, and bounded single-use proof-nonce
 * digests.
 *
 * It never holds plaintext, recovery secrets, decrypt keys or semantic
 * authority: a snapshot proves nothing about endpoint authority and is never
 * accepted as such. Proof signatures and nonces are used for verification
 * then discarded — only their bounded digests persist for replay defense.
 */

import { DurableObject } from "cloudflare:workers";

import type { PrivateRelayEnv } from "./env.ts";
import { RELAY_RUNTIME_LIMITS, integerEnv } from "./env.ts";
import { jsonResponse, readBoundedJson } from "./http.ts";
import { sha256Hex } from "./ids.ts";
import { RelayCounters } from "./metrics.ts";
import {
  createVaultFetchRefused,
  createVaultSnapshot,
  createVaultWriteResult,
  parsePrivateRelayRecoveryMessage,
  parseVaultFetch,
  parseVaultWrite,
} from "../../../packages/contracts/src/private-relay/index.ts";
import {
  snapshotCiphertextDigest,
  vaultFetchTranscript,
  vaultWriteTranscript,
  verifyVaultSignature,
} from "./vault-crypto.ts";
import type { VaultPublicKeyRef } from "./vault-crypto.ts";

const META_KEY = "meta";
const CURRENT_KEY = "current";
const STAGED_KEY = "staged";
const NONCES_KEY = "nonces";

interface VaultMeta {
  vaultId: string;
  provisioned: boolean;
  generation: number;
  recoveryVerifier: VaultPublicKeyRef | null;
  writers: VaultPublicKeyRef[];
  provisionedAt: string | null;
}

interface VaultCurrent {
  revision: number;
  generation: number;
  snapshot: {
    algorithm: string;
    nonce: string;
    ciphertext: string;
    byteLength: number;
  };
  publicVerifier: VaultPublicKeyRef;
  digest: string;
  writtenAt: string;
}

interface NonceStore {
  entries: { d: string; exp: number }[];
}

export class RecoveryVaultDO extends DurableObject<PrivateRelayEnv> {
  private meta: VaultMeta | null = null;
  private counters = new RelayCounters();
  private fetchWindowStart = 0;
  private fetchWindowCount = 0;

  constructor(ctx: DurableObjectState, env: PrivateRelayEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.counters.count("storageReads", 2);
      const [meta, counters] = await Promise.all([
        ctx.storage.get<VaultMeta>(META_KEY),
        ctx.storage.get("counters"),
      ]);
      if (meta) this.meta = meta;
      if (counters) this.counters = new RelayCounters(counters as Record<string, number>);
    });
  }

  private async flushCounters(): Promise<void> {
    this.counters.count("storageWrites");
    await this.counters.flush((key, value) => this.ctx.storage.put(key, value));
  }

  async fetch(request: Request): Promise<Response> {
    this.counters.count("httpRequests");
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/internal/provision") {
        return await this.handleProvision(request);
      }
      if (request.method === "GET" && url.pathname === "/internal/counters") {
        return jsonResponse({ counters: this.counters.snapshot() });
      }
      if (request.method === "GET" && url.pathname === "/internal/state") {
        this.counters.count("storageReads");
        const current = await this.ctx.storage.get<VaultCurrent>(CURRENT_KEY);
        return jsonResponse({
          provisioned: this.meta?.provisioned ?? false,
          generation: this.meta?.generation ?? 0,
          current: current ? {
            revision: current.revision,
            generation: current.generation,
            digest: current.digest,
            byteLength: current.snapshot.byteLength,
          } : null,
        });
      }
      if (request.method === "POST" && url.pathname === "/vault") {
        return await this.handleVaultMessage(request);
      }
      return jsonResponse({ error: "not_found" }, 404);
    } finally {
      await this.flushCounters();
    }
  }

  /**
   * Register the writer key set and recovery fetch verifier. Runs once per
   * vault via the admin provisioning route; later writers must already be in
   * the registered set — the vault never accepts self-declared authority.
   */
  private async handleProvision(request: Request): Promise<Response> {
    const body = await readBoundedJson(request, 32_768) as Record<string, unknown> | null;
    if (!body) return jsonResponse({ error: "invalid_body" }, 400);
    if (this.meta?.provisioned) {
      return jsonResponse({ error: "already_provisioned" }, 409);
    }
    const verifier = normalizeKeyRef(body.recoveryVerifier);
    const writers = Array.isArray(body.writers) ? body.writers.map(normalizeKeyRef) : [];
    const generation = typeof body.generation === "number" && Number.isSafeInteger(body.generation) && body.generation >= 1
      ? body.generation
      : 1;
    if (!verifier || writers.length === 0 || writers.some((w) => !w)) {
      return jsonResponse({ error: "invalid_body" }, 400);
    }
    if (writers.length > RELAY_RUNTIME_LIMITS.maxWritersPerVault) {
      return jsonResponse({ error: "capacity_exceeded" }, 429);
    }
    this.meta = {
      vaultId: (this.ctx.id.name ?? "").replace(/^vault:/, "") || "vault.unknown",
      provisioned: true,
      generation,
      recoveryVerifier: verifier,
      writers: writers as VaultPublicKeyRef[],
      provisionedAt: new Date().toISOString(),
    };
    this.counters.count("storageWrites");
    await this.ctx.storage.put(META_KEY, this.meta);
    return jsonResponse({ provisioned: true, vaultId: this.meta.vaultId, generation });
  }

  /** Recovery-wire entry point: only vault-fetch and vault-write are served. */
  private async handleVaultMessage(request: Request): Promise<Response> {
    const maxBytes = integerEnv(
      this.env.RELAY_MAX_VAULT_MESSAGE_BYTES,
      RELAY_RUNTIME_LIMITS.defaultMaxVaultMessageBytes,
      4_096,
      2 * 1024 * 1024,
    );
    const body = await readBoundedJson(request, maxBytes);
    if (body === null) return jsonResponse({ error: "payload_too_large_or_invalid" }, 413);
    const parsed = parsePrivateRelayRecoveryMessage(body);
    const rawKind = (body as Record<string, unknown> | null)?.kind;
    if (!parsed) {
      // A syntactically valid kind with a wrong/missing purpose is refused as
      // purpose_denied; everything else is an invalid wire message.
      if (rawKind === "vault-fetch" || rawKind === "vault-write") {
        const vaultId = typeof (body as Record<string, unknown>).vaultId === "string"
          ? (body as Record<string, unknown>).vaultId as string
          : "vault.unknown";
        return jsonResponse(createVaultFetchRefused({ vaultId, refusal: "purpose_denied", retryable: false }), 403);
      }
      return jsonResponse({ error: "unsupported_kind" }, 400);
    }
    // parsePrivateRelayRecoveryMessage already ran the kind parser — reuse
    // its result instead of validating the same body a second time.
    const kind = (parsed as { kind: string }).kind;
    if (kind === "vault-fetch") {
      return await this.handleVaultFetch(parsed as ReturnType<typeof parseVaultFetch> & object);
    }
    if (kind === "vault-write") {
      return await this.handleVaultWrite(parsed as ReturnType<typeof parseVaultWrite> & object);
    }
    return jsonResponse({ error: "unsupported_kind" }, 400);
  }

  // ------------------------------------------------------------------
  // vault-fetch
  // ------------------------------------------------------------------

  private async handleVaultFetch(fetch: ReturnType<typeof parseVaultFetch> & object): Promise<Response> {
    this.counters.count("vaultFetches");
    const refuse = (refusal: string, retryable: boolean, status = 403): Response => {
      this.counters.count("vaultFetchRefusals");
      return jsonResponse(createVaultFetchRefused({ vaultId: fetch.vaultId, refusal, retryable }), status);
    };
    if (!this.meta?.provisioned) return refuse("not_found", false, 404);
    if (!this.fetchRateAllowed()) return refuse("rate_limited", true, 429);

    this.counters.count("storageReads");
    const current = await this.ctx.storage.get<VaultCurrent>(CURRENT_KEY);
    if (!current) return refuse("not_found", false, 404);

    const verifier = this.meta.recoveryVerifier!;
    const proof = fetch.fetchProof;
    if (proof.keyId !== verifier.keyId) return refuse("proof_invalid", false);
    const issuedAt = Date.parse(proof.issuedAt);
    const now = Date.now();
    if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > RELAY_RUNTIME_LIMITS.proofValidityWindowMs) {
      return refuse("proof_invalid", false);
    }
    // Verify the proof before burning its nonce: an invalid signature must
    // not consume a single-use slot or produce a durable write.
    const valid = await verifyVaultSignature(verifier, proof.signature, vaultFetchTranscript(fetch.vaultId, proof));
    if (!valid) return refuse("proof_invalid", false);
    if (!(await this.consumeNonce("vault_fetch", proof.keyId, proof.nonce, issuedAt))) {
      return refuse("proof_invalid", false);
    }

    this.counters.count("vaultReads");
    return jsonResponse(createVaultSnapshot({
      vaultId: fetch.vaultId,
      revision: current.revision,
      generation: current.generation,
      snapshot: current.snapshot,
      publicVerifier: current.publicVerifier,
    }));
  }

  // ------------------------------------------------------------------
  // vault-write (CAS + idempotent reconcile)
  // ------------------------------------------------------------------

  private async handleVaultWrite(write: ReturnType<typeof parseVaultWrite> & object): Promise<Response> {
    const refuse = (status = 403): Response => {
      this.counters.count("vaultWritesRefused");
      return jsonResponse(createVaultWriteResult({
        vaultId: write.vaultId,
        outcome: "refused",
        currentRevision: 0,
        committedRevision: 0,
      }), status);
    };
    if (!this.meta?.provisioned) return refuse(403);
    const writer = this.meta.writers.find((candidate) => candidate.keyId === write.writeAuth.writerKeyId);
    if (!writer) return refuse(); // unregistered writer key — no write escalation

    this.counters.count("storageReads");
    const current = await this.ctx.storage.get<VaultCurrent>(CURRENT_KEY);
    const currentRevision = current?.revision ?? 0;
    const conflict = (): Response => {
      this.counters.count("vaultWritesConflicting");
      return jsonResponse(createVaultWriteResult({
        vaultId: write.vaultId,
        outcome: "conflict",
        currentRevision,
        committedRevision: 0,
      }), 409);
    };
    const committed = (revision: number): Response => {
      this.counters.count("vaultWritesCommitted");
      return jsonResponse(createVaultWriteResult({
        vaultId: write.vaultId,
        outcome: "committed",
        currentRevision: revision,
        committedRevision: revision,
      }));
    };

    const snapshot = write.snapshot;
    if (snapshot.vaultId !== write.vaultId) return refuse();
    if (snapshot.generation < (current?.generation ?? this.meta.generation)) return refuse();
    if (snapshot.revision !== write.expectedRevision + 1) return refuse();
    const computedDigest = await snapshotCiphertextDigest(snapshot.snapshot.ciphertext);
    if (computedDigest !== write.writeAuth.snapshotDigest) return refuse();

    if (write.expectedRevision !== currentRevision) {
      // Idempotent reconcile: a retried write of the already-committed
      // snapshot reports committed instead of a false conflict.
      if (current && current.digest === computedDigest && write.expectedRevision === currentRevision - 1) {
        return committed(currentRevision);
      }
      return conflict();
    }

    // A leftover staged record belongs to a write that never finished its
    // commit, so it must not wedge the vault: readers only ever see
    // CURRENT_KEY, and the commit transaction below atomically clears any
    // abandoned stage whether its digest matched or diverged.

    const valid = await verifyVaultSignature(
      writer,
      write.writeAuth.signature,
      vaultWriteTranscript(write.vaultId, write.writeAuth, write.expectedRevision),
    );
    if (!valid) return refuse();
    if (!(await this.consumeNonce("vault_write", writer.keyId, write.writeAuth.nonce, Date.now()))) {
      return refuse();
    }

    // Stage then commit atomically: the last committed decryptable snapshot
    // is retained until the staged replacement validates and commits.
    // The wire parser bounds every field; narrow the validated shapes here.
    const envelope = snapshot.snapshot as VaultCurrent["snapshot"];
    const publicVerifier = snapshot.publicVerifier as VaultPublicKeyRef;
    const next: VaultCurrent = {
      revision: snapshot.revision,
      generation: snapshot.generation,
      snapshot: envelope,
      publicVerifier,
      digest: computedDigest,
      writtenAt: new Date().toISOString(),
    };
    this.counters.count("storageWrites");
    this.counters.count("storageDeletes");
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(CURRENT_KEY, next);
      await txn.delete(STAGED_KEY);
    });
    if (snapshot.generation > this.meta.generation) {
      this.meta.generation = snapshot.generation;
      this.counters.count("storageWrites");
      await this.ctx.storage.put(META_KEY, this.meta);
    }
    return committed(next.revision);
  }

  // ------------------------------------------------------------------
  // Proof support
  // ------------------------------------------------------------------

  /**
   * Bounded single-use nonce registry. Only digests persist — never the
   * nonce or signature material itself.
   */
  private async consumeNonce(purpose: string, keyId: string, nonce: string, issuedAtMs: number): Promise<boolean> {
    const digest = await sha256Hex(`${purpose}|${keyId}|${nonce}`);
    this.counters.count("storageReads");
    const store = (await this.ctx.storage.get<NonceStore>(NONCES_KEY)) ?? { entries: [] };
    const now = Date.now();
    const expiryFloor = Math.max(now - RELAY_RUNTIME_LIMITS.proofValidityWindowMs, issuedAtMs);
    const before = store.entries.length;
    const replayed = store.entries.some((entry) => entry.d === digest);
    store.entries = store.entries.filter((entry) => entry.exp > expiryFloor);
    if (replayed) {
      // Replay: write back only when pruning actually changed the store —
      // a refused replay must not cost a durable write.
      if (store.entries.length !== before) {
        this.counters.count("storageWrites");
        await this.ctx.storage.put(NONCES_KEY, store);
      }
      return false;
    }
    store.entries.push({ d: digest, exp: issuedAtMs + RELAY_RUNTIME_LIMITS.proofValidityWindowMs });
    if (store.entries.length > RELAY_RUNTIME_LIMITS.maxProofNoncesPerVault) {
      store.entries = store.entries.slice(store.entries.length - RELAY_RUNTIME_LIMITS.maxProofNoncesPerVault);
    }
    this.counters.count("storageWrites");
    await this.ctx.storage.put(NONCES_KEY, store);
    return true;
  }

  private fetchRateAllowed(): boolean {
    const now = Date.now();
    if (now - this.fetchWindowStart > RELAY_RUNTIME_LIMITS.vaultFetchWindowMs) {
      this.fetchWindowStart = now;
      this.fetchWindowCount = 0;
    }
    this.fetchWindowCount += 1;
    return this.fetchWindowCount <= RELAY_RUNTIME_LIMITS.vaultFetchMaxPerWindow;
  }
}

function normalizeKeyRef(value: unknown): VaultPublicKeyRef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.keyId !== "string" || !record.keyId) return null;
  if (record.algorithm !== "Ed25519" && record.algorithm !== "ECDSA-P256") return null;
  if (typeof record.publicKey !== "string" || !record.publicKey) return null;
  return { keyId: record.keyId, algorithm: record.algorithm, publicKey: record.publicKey };
}
