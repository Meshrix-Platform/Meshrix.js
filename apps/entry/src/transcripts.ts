/**
 * Canonical proof transcripts for the private-relay recovery wire.
 *
 * The vault transcript byte shapes are fixed by the hosted recovery-vault
 * implementation (maintained in the separate private operations repository) —
 * UTF-8, "|"-joined, fixed field order — and duplicated here because the
 * installed entry is a separate runtime that must not import hosted internals:
 *
 * - vault_fetch: "meshrix.private-relay.vault|vault_fetch|<vaultId>|<keyId>|<nonce>|<issuedAt>"
 * - vault_write: "meshrix.private-relay.vault|vault_write|<vaultId>|<writerKeyId>|<nonce>|<expectedRevision>|<snapshotDigest>"
 *
 * The endpoint recovery proof is signed over the canonical JSON transcript the
 * endpoint recovery service verifies (packages/gateway recovery-flow.ts):
 * canonicalJson({challengeId, endpointRouteId, principalRef, generation,
 * freshDeviceId, freshDevicePublicKey, purpose: "recover_device"}).
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

export const VAULT_TRANSCRIPT_DOMAIN = "meshrix.private-relay.vault";

const encoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function vaultFetchTranscript(
  vaultId: string,
  proof: { keyId: string; nonce: string; issuedAt: string }
): Uint8Array {
  return utf8Bytes([
    VAULT_TRANSCRIPT_DOMAIN,
    "vault_fetch",
    vaultId,
    proof.keyId,
    proof.nonce,
    proof.issuedAt
  ].join("|"));
}

export function vaultWriteTranscript(
  vaultId: string,
  auth: { writerKeyId: string; nonce: string; snapshotDigest: string },
  expectedRevision: number
): Uint8Array {
  return utf8Bytes([
    VAULT_TRANSCRIPT_DOMAIN,
    "vault_write",
    vaultId,
    auth.writerKeyId,
    auth.nonce,
    String(expectedRevision),
    auth.snapshotDigest
  ].join("|"));
}

/**
 * The full protected snapshot surface the write digest signs over — the
 * mirror of `VaultProtectedSnapshot` in the hosted recovery-vault
 * implementation. The contract parser
 * guarantees this shape at runtime; its `byteLength` field types as
 * `unknown`, so cast parsed records to this interface at call sites.
 */
export interface VaultProtectedSnapshot {
  readonly schemaVersion: string;
  readonly kind: string;
  readonly vaultId: string;
  readonly formatVersion: number;
  readonly generation: number;
  readonly revision: number;
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

/**
 * sha256 over the canonical "|"-joined protected-snapshot field list —
 * the mirror of `vaultSnapshotDigest` in the hosted recovery-vault
 * implementation. The digest covers the full
 * signed surface (schemaVersion, kind, vaultId, formatVersion, generation,
 * revision, AEAD algorithm/nonce/byteLength/ciphertext, and the public
 * verifier's keyId/algorithm/publicKey), so a substituted field produces
 * a different digest and the write is refused before any state write.
 * Every covered field is a wire-bounded token or integer — none can
 * contain "|", so the join is unambiguous.
 */
export function vaultSnapshotDigest(snapshot: VaultProtectedSnapshot): string {
  return `sha256:${createHash("sha256").update(utf8Bytes([
    VAULT_TRANSCRIPT_DOMAIN,
    "vault_snapshot",
    snapshot.schemaVersion,
    snapshot.kind,
    snapshot.vaultId,
    String(snapshot.formatVersion),
    String(snapshot.generation),
    String(snapshot.revision),
    snapshot.snapshot.algorithm,
    snapshot.snapshot.nonce,
    String(snapshot.snapshot.byteLength),
    snapshot.snapshot.ciphertext,
    snapshot.publicVerifier.keyId,
    snapshot.publicVerifier.algorithm,
    snapshot.publicVerifier.publicKey
  ].join("|"))).digest("hex")}`;
}

/**
 * Canonical recovery-proof transcript signed by the fresh device during
 * recover_device enrollment. Field order is owned by canonicalJson.
 */
export function recoveryProofTranscript(input: {
  readonly challengeId: string;
  readonly endpointRouteId: string;
  readonly principalRef: string;
  readonly generation: number;
  readonly freshDeviceId: string;
  readonly freshDevicePublicKey: string;
}): string {
  return canonicalJson({
    challengeId: input.challengeId,
    endpointRouteId: input.endpointRouteId,
    principalRef: input.principalRef,
    generation: input.generation,
    freshDeviceId: input.freshDeviceId,
    freshDevicePublicKey: input.freshDevicePublicKey,
    purpose: "recover_device"
  });
}
