/**
 * Key and digest helpers shared by custody, pairing and recovery.
 *
 * All primitives come from node:crypto (the repository-preferred runtime API):
 * Ed25519 keypairs (random or seed-derived via JWK), HKDF-SHA-256 label
 * derivation and SHA-256 fingerprints. No third-party crypto dependency.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject
} from "node:crypto";

export interface Ed25519Keypair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

/** Generate a fresh random Ed25519 pair. */
export function generateEd25519(): Ed25519Keypair {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/**
 * Deterministically derive an Ed25519 pair from a 32-byte seed. The seed is
 * wrapped in the fixed RFC 8410 PKCS#8 form (`302e…0420` + seed) so the same
 * seed always produces the same public key — this is what lets a fresh
 * device re-derive the enrolled recovery authority without storing keys.
 */
export function ed25519FromSeed(seed: Uint8Array): Ed25519Keypair {
  if (seed.byteLength !== 32) {
    throw new TypeError("Ed25519 seed derivation requires exactly 32 bytes.");
  }
  const privateKey = createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)])
  });
  return { publicKey: createPublicKey(privateKey), privateKey };
}

/** RFC 8410 `PrivateKeyInfo` header for a 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Raw 32-byte Ed25519 public key material, base64url — the vault `publicKey` shape. */
export function rawPublicKeyBase64Url(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string" || !jwk.x) {
    throw new TypeError("Expected an Ed25519 public key with raw JWK material.");
  }
  return jwk.x;
}

/** Import a raw 32-byte Ed25519 public key from its base64url form. */
export function publicKeyFromRawBase64Url(raw: string): KeyObject {
  return createPublicKey({
    format: "jwk",
    key: { kty: "OKP", crv: "Ed25519", x: raw }
  });
}

export function signEd25519(privateKey: KeyObject, transcript: Uint8Array | string): string {
  return cryptoSign(null, Buffer.from(transcript), privateKey).toString("base64url");
}

export function verifyEd25519(input: {
  readonly publicKey: KeyObject | string;
  readonly signature: string;
  readonly transcript: Uint8Array | string;
}): boolean {
  try {
    const key = typeof input.publicKey === "string"
      ? publicKeyFromRawBase64Url(input.publicKey)
      : input.publicKey;
    return cryptoVerify(null, Buffer.from(input.transcript), key, Buffer.from(input.signature, "base64url"));
  } catch {
    return false;
  }
}

/**
 * Device identity fingerprint: sha256 over the SPKI DER, matching the
 * `spkiSha256Base64Url` pin convention used by the private endpoint inner-TLS
 * channel. Presented as an opaque `fp.*` identifier on wire fields.
 */
export function publicKeyFingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `fp.${createHash("sha256").update(der).digest("base64url")}`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/** HKDF-SHA-256 (RFC 5869) with a fixed versioned salt and a purpose label. */
export function hkdfLabel(secret: Uint8Array, label: string, length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, ENTRY_KDF_SALT, label, length));
}

export const ENTRY_KDF_SALT = "meshrix/entry/recovery-root/v1";

/** Opaque-id-safe random token, e.g. `dev.kx8…`; first character is alnum. */
export function randomOpaqueId(prefix: string, randomLength = 12): string {
  return `${prefix}.${randomBytes(randomLength).toString("base64url")}`;
}

/** Fresh nonce token satisfying the wire NONCE_PATTERN (`<prefix>.<random>`). */
export function freshNonceToken(prefix: string, randomBytes_ = 20): string {
  return `${prefix}.${randomBytes(randomBytes_).toString("base64url")}`;
}
