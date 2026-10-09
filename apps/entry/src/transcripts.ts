/**
 * Canonical proof transcripts for the private-relay recovery wire.
 *
 * The vault transcript byte shapes are fixed by the recovery-vault
 * implementation (workers/private-relay/src/vault-crypto.ts) — UTF-8,
 * "|"-joined, fixed field order — and duplicated here because the installed
 * entry is a separate runtime that must not import worker internals:
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

/** sha256 over the UTF-8 bytes of the canonical base64url ciphertext string. */
export function snapshotCiphertextDigest(ciphertextBase64Url: string): string {
  return `sha256:${createHash("sha256").update(utf8Bytes(ciphertextBase64Url)).digest("hex")}`;
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
