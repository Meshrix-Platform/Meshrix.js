import crypto from "node:crypto";

import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

export const LOCAL_SECRET_ENVELOPE_VERSION =
  "v0.0.1:security:local-secret-envelope-1";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

interface LocalSecretKeyFact {
  key: Buffer;
  keyId: string;
}

interface LocalSecretKeyProvider {
  loadKey(): Promise<LocalSecretKeyFact>;
}

interface EnvelopeOperation {
  payload?: unknown;
  envelope?: unknown;
  binding?: unknown;
  keyProvider: LocalSecretKeyProvider;
}

type SecretRecord = Record<string, unknown>;

function record(value?: unknown): SecretRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SecretRecord
    : null;
}

function encryptionError(code = "local_secret_decryption_failed"): Error & { code: string } {
  const error = new Error("Meshrix.js local secret encrypted value is unavailable.") as Error & { code: string };
  error.code = code;
  return error;
}

function bindingBytes(binding?: unknown): Buffer {
  return Buffer.from(canonicalJson(binding), "utf8");
}

function digest(bytes: crypto.BinaryLike): string {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeBase64Url(value?: unknown, expectedBytes = 0): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw encryptionError();
  }
  const bytes = Buffer.from(value, "base64url");
  if ((expectedBytes && bytes.length !== expectedBytes) || bytes.length === 0) {
    bytes.fill(0);
    throw encryptionError();
  }
  return bytes;
}

function assertEnvelope(envelope?: unknown): SecretRecord {
  const value = record(envelope);
  if (
    !value ||
    Object.keys(value).some((key) => ![
      "protocolVersion",
      "algorithm",
      "keyId",
      "iv",
      "ciphertext",
      "authTag",
      "aadDigest",
    ].includes(key)) ||
    value.protocolVersion !== LOCAL_SECRET_ENVELOPE_VERSION ||
    value.algorithm !== ALGORITHM ||
    !SHA256_PATTERN.test(String(value.keyId || "")) ||
    !SHA256_PATTERN.test(String(value.aadDigest || ""))
  ) {
    throw encryptionError("local_secret_envelope_invalid");
  }
  return value;
}

export async function encryptLocalSecretPayload({
  payload,
  binding,
  keyProvider,
}: EnvelopeOperation): Promise<Readonly<SecretRecord>> {
  const plaintext = Buffer.from(canonicalJson(payload), "utf8");
  const aad = bindingBytes(binding);
  const iv = crypto.randomBytes(IV_BYTES);
  let keyFact: LocalSecretKeyFact | undefined;
  try {
    keyFact = await keyProvider.loadKey();
    const key = keyFact?.key;
    if (
      !Buffer.isBuffer(key) ||
      key.length !== 32 ||
      !SHA256_PATTERN.test(String(keyFact?.keyId || ""))
    ) {
      throw encryptionError("local_secret_key_invalid");
    }
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Object.freeze({
      protocolVersion: LOCAL_SECRET_ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyId: keyFact.keyId,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: authTag.toString("base64url"),
      aadDigest: digest(aad),
    });
  } finally {
    plaintext.fill(0);
    aad.fill(0);
    iv.fill(0);
    keyFact?.key?.fill(0);
  }
}

export async function decryptLocalSecretPayload({
  envelope,
  binding,
  keyProvider,
}: EnvelopeOperation): Promise<SecretRecord> {
  const value = assertEnvelope(envelope);
  const aad = bindingBytes(binding);
  const iv = decodeBase64Url(value.iv, IV_BYTES);
  const ciphertext = decodeBase64Url(value.ciphertext);
  const authTag = decodeBase64Url(value.authTag, TAG_BYTES);
  let keyFact: LocalSecretKeyFact | undefined;
  let plaintext: Buffer | undefined;
  try {
    if (digest(aad) !== value.aadDigest) throw encryptionError();
    keyFact = await keyProvider.loadKey();
    if (
      !Buffer.isBuffer(keyFact?.key) ||
      keyFact.key.length !== 32 ||
      keyFact.keyId !== value.keyId
    ) {
      throw encryptionError();
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, keyFact.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = record(JSON.parse(plaintext.toString("utf8")));
    if (!payload || Object.keys(payload).length === 0) {
      throw encryptionError();
    }
    return payload;
  } catch (error: unknown) {
    if ((error as { code?: string })?.code?.startsWith("local_secret_")) throw error;
    throw encryptionError();
  } finally {
    aad.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    authTag.fill(0);
    plaintext?.fill(0);
    keyFact?.key?.fill(0);
  }
}
