/**
 * Recovery vault client for the installed entry.
 *
 * Implements the consumer half of the vault wire contract: a `vault-fetch`
 * carrying a typed `vault_fetch` proof signed by the recovery signing key,
 * and a `vault-write` carrying an `expectedRevision` CAS plus a `vault_write`
 * proof signed by the enrolled writer key. Every request gets a fresh random
 * nonce — nonce uniqueness never depends on a service-supplied revision.
 *
 * The transport is a narrow port so tests drive the client against a neutral
 * vault peer; the default transport is an HTTPS POST to `{base}/vault/{id}`.
 */
import {
  createVaultFetch,
  createVaultWrite,
  parseEncryptedRecoverySnapshot,
  parseVaultFetchRefused,
  parseVaultSnapshot,
  parseVaultWriteResult,
  vaultWriteCommitted
} from "@meshrix/contracts/private-relay";
import { entryError } from "../errors.ts";
import { freshNonceToken, signEd25519 } from "../keys.ts";
import type { KeyObject } from "node:crypto";
import {
  vaultFetchTranscript,
  vaultSnapshotDigest,
  vaultWriteTranscript
} from "../transcripts.ts";
import type { VaultProtectedSnapshot } from "../transcripts.ts";

export interface VaultSigningMaterial {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export interface VaultTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface VaultTransport {
  post(input: {
    readonly vaultId: string;
    readonly message: Record<string, unknown>;
  }): Promise<VaultTransportResponse>;
}

/** HTTPS POST transport: `POST {baseUrl}/vault/{vaultId}` with a JSON body. */
export class FetchVaultTransport implements VaultTransport {
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async post(input: { vaultId: string; message: Record<string, unknown> }): Promise<VaultTransportResponse> {
    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/vault/${encodeURIComponent(input.vaultId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.message)
      });
    } catch (error) {
      throw entryError(
        "vault_transport_error",
        "Vault request could not be completed.",
        { vaultId: input.vaultId }
      );
    }
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  }
}

export type VaultFetchOutcome =
  | { readonly outcome: "snapshot"; readonly snapshot: VaultSnapshotView }
  | { readonly outcome: "refused"; readonly refusal: string; readonly retryable: boolean }
  | { readonly outcome: "invalid_response" };

export interface VaultSnapshotView {
  readonly vaultId: string;
  readonly revision: number;
  readonly generation: number;
  readonly snapshot: {
    readonly algorithm: string;
    readonly nonce: string;
    readonly ciphertext: string;
    readonly byteLength: number;
  };
  readonly publicVerifier: {
    readonly keyId: string;
    readonly algorithm: string;
    readonly publicKey: string;
  };
}

export type VaultWriteOutcome =
  | { readonly outcome: "committed"; readonly committedRevision: number }
  | { readonly outcome: "conflict"; readonly currentRevision: number }
  | { readonly outcome: "refused"; readonly retryable?: boolean }
  | { readonly outcome: "invalid_response" };

export class RecoveryVaultClient {
  readonly #transport: VaultTransport;
  readonly #nonceFactory: () => string;
  readonly #now: () => number;

  constructor(options: {
    transport: VaultTransport;
    nonceFactory?: () => string;
    now?: () => number;
  }) {
    this.#transport = options.transport;
    this.#nonceFactory = options.nonceFactory ?? (() => freshNonceToken("n.entry"));
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Fetch the committed snapshot using only recovery-key possession — no
   * device credential, session or account login is involved.
   */
  async fetchSnapshot(input: {
    readonly vaultId: string;
    readonly recoveryKey: VaultSigningMaterial;
  }): Promise<VaultFetchOutcome> {
    const proof = {
      keyId: input.recoveryKey.keyId,
      nonce: this.#nonceFactory(),
      issuedAt: new Date(this.#now()).toISOString()
    };
    const signature = signEd25519(input.recoveryKey.privateKey, vaultFetchTranscript(input.vaultId, proof));
    const message = createVaultFetch({
      vaultId: input.vaultId,
      fetchProof: { ...proof, signature }
    });
    const response = await this.#transport.post({ vaultId: input.vaultId, message });
    if (response.status === 429 || response.status === 503) {
      return { outcome: "refused", refusal: "rate_limited", retryable: true };
    }
    const snapshot = parseVaultSnapshot(response.body);
    if (snapshot && snapshot.vaultId === input.vaultId) {
      return { outcome: "snapshot", snapshot: snapshot as VaultSnapshotView };
    }
    const refused = parseVaultFetchRefused(response.body);
    if (refused) {
      return { outcome: "refused", refusal: String(refused.refusal), retryable: refused.retryable === true };
    }
    return { outcome: "invalid_response" };
  }

  /**
   * Bounded CAS write. `expectedRevision` is the committed revision this
   * write builds on (0 for the first snapshot); the snapshot's own
   * `revision` must equal `expectedRevision + 1`.
   */
  async writeSnapshot(input: {
    readonly vaultId: string;
    readonly expectedRevision: number;
    readonly snapshot: Record<string, unknown>;
    readonly writerKey: VaultSigningMaterial;
  }): Promise<VaultWriteOutcome> {
    // Sign over the canonical digest of the FULL protected snapshot — the
    // vault refuses the write when any covered field is substituted. A
    // snapshot that cannot satisfy the wire schema is refused upstream
    // before the digest is compared, so sign a fixed sentinel and let the
    // vault return the honest refusal.
    const parsedSnapshot = parseEncryptedRecoverySnapshot(input.snapshot);
    const auth = {
      writerKeyId: input.writerKey.keyId,
      nonce: this.#nonceFactory(),
      snapshotDigest: parsedSnapshot
        ? vaultSnapshotDigest(parsedSnapshot as VaultProtectedSnapshot)
        : `sha256:${"0".repeat(64)}`
    };
    const signature = signEd25519(
      input.writerKey.privateKey,
      vaultWriteTranscript(input.vaultId, auth, input.expectedRevision)
    );
    const message = createVaultWrite({
      vaultId: input.vaultId,
      expectedRevision: input.expectedRevision,
      snapshot: input.snapshot,
      writeAuth: { ...auth, signature }
    });
    const response = await this.#transport.post({ vaultId: input.vaultId, message });
    if (response.status === 429 || response.status === 503) return { outcome: "refused", retryable: true };
    const result = parseVaultWriteResult(response.body);
    if (!result || result.vaultId !== input.vaultId) return { outcome: "invalid_response" };
    if (result.outcome === "committed") {
      // Cross-check through the contract helper: a claimed commit must advance
      // past expectedRevision and equal currentRevision — a replayed or stale
      // response can never fabricate a commit.
      if (!vaultWriteCommitted(message, result)) return { outcome: "invalid_response" };
      return { outcome: "committed", committedRevision: Number(result.committedRevision) };
    }
    if (result.outcome === "conflict") {
      return { outcome: "conflict", currentRevision: Number(result.currentRevision) };
    }
    return { outcome: "refused" };
  }
}

export function createRecoveryVaultClient(options: ConstructorParameters<typeof RecoveryVaultClient>[0]): RecoveryVaultClient {
  return new RecoveryVaultClient(options);
}
