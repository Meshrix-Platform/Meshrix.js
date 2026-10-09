/**
 * Recovery cryptographic profile (per the tree contract):
 *
 * - One locally generated 256-bit recovery secret.
 * - HKDF-SHA-256 (RFC 5869) derives separate material under fixed versioned
 *   purpose labels — recovery signing (endpoint authority proofs + vault
 *   fetch), backup writer (vault write authorization) and backup encryption
 *   (AES-256-GCM snapshot sealing).
 * - AES-256-GCM (NIST SP 800-38D) seals the typed snapshot plaintext. The
 *   envelope `nonce` is a fresh random per-encryption token and the GCM IV
 *   travels inside the ciphertext blob; format/vault/generation/revision are
 *   authenticated as AAD. A service-supplied revision is never used as a
 *   nonce source.
 * - Ed25519 (RFC 8032) signs the typed proof transcripts.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { entryError } from "../errors.ts";
import { ed25519FromSeed, hkdfLabel, rawPublicKeyBase64Url } from "../keys.ts";

/** Versioned purpose labels — never reuse a label for a different purpose. */
export const RECOVERY_LABEL_SIGNING = "meshrix/private-relay/recovery-signing/v1";
export const RECOVERY_LABEL_BACKUP_WRITER = "meshrix/private-relay/backup-writer/v1";
export const RECOVERY_LABEL_BACKUP_ENCRYPTION = "meshrix/private-relay/backup-encryption/v1";

export interface DerivedRecoveryKey {
  /** Opaque key id derived from the public key — stable across reinstalls. */
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url — the vault verifier shape. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

export interface RecoveryMaterial {
  /** Recovery signing key: proves the pre-enrolled recovery authority. */
  readonly signing: DerivedRecoveryKey;
  /** Backup writer key: authorizes vault CAS writes (enrolled per vault). */
  readonly writer: DerivedRecoveryKey;
  /** 32-byte AES key sealing snapshot plaintext. */
  readonly backupKey: Buffer;
}

function keyIdFor(prefix: string, publicKeyB64: string): string {
  // keyId is opaque to the vault; derive it deterministically from the public
  // key so a fresh device presents the same identity: `<prefix>.<fp16>`.
  const raw = Buffer.from(publicKeyB64, "base64url");
  const fingerprint = createHash("sha256").update(raw).digest().subarray(0, 16);
  return `${prefix}.${Buffer.from(fingerprint).toString("base64url")}`;
}

/** Derive all recovery material from the 32-byte user-held secret. */
export function deriveRecoveryMaterial(secret: Uint8Array): RecoveryMaterial {
  if (secret.byteLength !== 32) {
    throw entryError("recovery_key_invalid", "Recovery secret must be 32 bytes.");
  }
  const signingPair = ed25519FromSeed(hkdfLabel(secret, RECOVERY_LABEL_SIGNING));
  const writerPair = ed25519FromSeed(hkdfLabel(secret, RECOVERY_LABEL_BACKUP_WRITER));
  return {
    signing: Object.freeze({
      keyId: keyIdFor("rckey", rawPublicKeyBase64Url(signingPair.publicKey)),
      publicKey: rawPublicKeyBase64Url(signingPair.publicKey),
      privateKey: signingPair.privateKey
    }),
    writer: Object.freeze({
      keyId: keyIdFor("wkey", rawPublicKeyBase64Url(writerPair.publicKey)),
      publicKey: rawPublicKeyBase64Url(writerPair.publicKey),
      privateKey: writerPair.privateKey
    }),
    backupKey: hkdfLabel(secret, RECOVERY_LABEL_BACKUP_ENCRYPTION)
  };
}

/**
 * AAD binding every authenticated envelope field: purpose, vault locator,
 * format, generation and revision. Tampering any of them breaks the tag.
 */
export function snapshotAad(input: {
  vaultId: string;
  formatVersion: number;
  generation: number;
  revision: number;
}): Buffer {
  return Buffer.from([
    "meshrix.private-relay.snapshot",
    "aes-256-gcm",
    input.vaultId,
    `fmt${input.formatVersion}`,
    `g${input.generation}`,
    `r${input.revision}`
  ].join("|"), "utf8");
}

export interface AeadEnvelopeFields {
  readonly algorithm: "AES-256-GCM";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly byteLength: number;
}

/**
 * Seal the canonical bundle JSON. `nonce` is a fresh qualified token
 * (`sn.<random>`) — unique across writers, retries, reinstalls and rollback
 * because it is random, not because a revision counter says so. The GCM IV
 * (12 bytes) prefixes the ciphertext inside the opaque payload.
 */
export function sealRecoverySnapshot(input: {
  readonly plaintext: Uint8Array;
  readonly backupKey: Uint8Array;
  readonly vaultId: string;
  readonly formatVersion: number;
  readonly generation: number;
  readonly revision: number;
  readonly nonce?: Uint8Array;
}): AeadEnvelopeFields {
  const iv = input.nonce ? Buffer.from(input.nonce) : randomBytes(12);
  if (iv.byteLength !== 12) {
    throw entryError("snapshot_malformed", "AES-256-GCM requires a 12-byte IV.");
  }
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(input.backupKey), iv);
  cipher.setAAD(snapshotAad(input));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(input.plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ciphertext, tag]);
  return Object.freeze({
    algorithm: "AES-256-GCM",
    nonce: `sn.${randomBytes(15).toString("base64url")}`,
    ciphertext: payload.toString("base64url"),
    byteLength: payload.byteLength
  });
}

/** Open a sealed snapshot envelope; auth failure → `snapshot_decrypt_failed`. */
export function openRecoverySnapshot(input: {
  readonly envelope: { readonly nonce: string; readonly ciphertext: string; readonly algorithm?: string };
  readonly backupKey: Uint8Array;
  readonly vaultId: string;
  readonly formatVersion: number;
  readonly generation: number;
  readonly revision: number;
}): Uint8Array {
  if (input.envelope.algorithm !== "AES-256-GCM") {
    throw entryError(
      "snapshot_malformed",
      `Unsupported snapshot algorithm ${String(input.envelope.algorithm)} — this entry implements AES-256-GCM.`
    );
  }
  const payload = Buffer.from(input.envelope.ciphertext, "base64url");
  if (payload.byteLength < 12 + 16) {
    throw entryError("snapshot_malformed", "Snapshot ciphertext is shorter than the IV+tag floor.");
  }
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(payload.byteLength - 16);
  const ciphertext = payload.subarray(12, payload.byteLength - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(input.backupKey), iv);
  decipher.setAAD(snapshotAad(input));
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw entryError(
      "snapshot_decrypt_failed",
      "Snapshot failed authentication — wrong recovery key or tampered ciphertext."
    );
  }
}
