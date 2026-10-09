/**
 * Recovery-vault proof verification.
 *
 * The vault verifies purpose-bound public-key proofs over canonical
 * transcripts built only from wire-visible fields. Signature bytes and
 * nonces are used for verification then discarded — they are never logged
 * or written to durable state beyond the bounded single-use nonce digests.
 *
 * Transcript formats (UTF-8, "|"-joined, fixed field order):
 * - vault_fetch: "meshrix.private-relay.vault|vault_fetch|<vaultId>|<keyId>|<nonce>|<issuedAt>"
 * - vault_write: "meshrix.private-relay.vault|vault_write|<vaultId>|<writerKeyId>|<nonce>|<expectedRevision>|<snapshotDigest>"
 *
 * snapshotDigest is sha256 over the UTF-8 bytes of the snapshot ciphertext's
 * canonical base64url string ("sha256:<hex>"), binding the write auth to the
 * exact opaque envelope without decoding or interpreting it.
 */

import { base64UrlToBytes, bytesToBase64Url, sha256Hex, utf8Bytes } from "./ids.ts";

export const VAULT_TRANSCRIPT_DOMAIN = "meshrix.private-relay.vault";

export interface VaultPublicKeyRef {
  keyId: string;
  algorithm: "Ed25519" | "ECDSA-P256";
  /** base64url raw key material (Ed25519 32B / ECDSA-P256 uncompressed point). */
  publicKey: string;
}

export function vaultFetchTranscript(
  vaultId: string,
  proof: { keyId: string; nonce: string; issuedAt: string },
): Uint8Array {
  return utf8Bytes([
    VAULT_TRANSCRIPT_DOMAIN,
    "vault_fetch",
    vaultId,
    proof.keyId,
    proof.nonce,
    proof.issuedAt,
  ].join("|"));
}

export function vaultWriteTranscript(
  vaultId: string,
  auth: { writerKeyId: string; nonce: string; snapshotDigest: string },
  expectedRevision: number,
): Uint8Array {
  return utf8Bytes([
    VAULT_TRANSCRIPT_DOMAIN,
    "vault_write",
    vaultId,
    auth.writerKeyId,
    auth.nonce,
    String(expectedRevision),
    auth.snapshotDigest,
  ].join("|"));
}

/** sha256 over the canonical base64url ciphertext string. */
export async function snapshotCiphertextDigest(ciphertextBase64Url: string): Promise<string> {
  return `sha256:${await sha256Hex(utf8Bytes(ciphertextBase64Url))}`;
}

export async function importVaultPublicKey(key: VaultPublicKeyRef): Promise<CryptoKey | null> {
  const raw = base64UrlToBytes(key.publicKey);
  if (!raw) return null;
  try {
    if (key.algorithm === "Ed25519") {
      if (raw.byteLength !== 32) return null;
      return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    }
    if (key.algorithm === "ECDSA-P256") {
      if (raw.byteLength !== 65) return null;
      return await crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyVaultSignature(
  key: VaultPublicKeyRef,
  signatureBase64Url: string,
  transcript: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importVaultPublicKey(key);
  const signature = base64UrlToBytes(signatureBase64Url);
  if (!cryptoKey || !signature) return false;
  try {
    if (key.algorithm === "Ed25519") {
      return await crypto.subtle.verify("Ed25519", cryptoKey, signature as BufferSource, transcript as BufferSource);
    }
    // ECDSA-P256 over SHA-256 with IEEE P1363 (fixed-length r||s) signatures.
    if (signature.byteLength !== 64) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      signature as BufferSource,
      transcript as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Export a generated public key into the vault key reference shape. */
export async function exportVaultPublicKey(keyId: string, publicKey: CryptoKey): Promise<VaultPublicKeyRef | null> {
  try {
    const raw = await crypto.subtle.exportKey("raw", publicKey) as ArrayBuffer;
    const algorithm = publicKey.algorithm.name === "Ed25519" ? "Ed25519" : "ECDSA-P256";
    return { keyId, algorithm, publicKey: bytesToBase64Url(raw) };
  } catch {
    return null;
  }
}
