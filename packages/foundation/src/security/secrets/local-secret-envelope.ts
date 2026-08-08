import crypto from "node:crypto";

import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

export const LOCAL_SECRET_ENVELOPE_VERSION: any =
  "v0.0.1:security:local-secret-envelope-1";

const ALGORITHM: any = "aes-256-gcm";
const IV_BYTES: any = 12;
const TAG_BYTES: any = 16;
const SHA256_PATTERN: any = /^sha256:[0-9a-f]{64}$/u;

function record(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function encryptionError(code: any = "local_secret_decryption_failed") : any {
  const error: Error & Record<string, any> = new Error("Meshrix.js local secret encrypted value is unavailable.");
  error.code = code;
  return error;
}

function bindingBytes(binding?: any) : any {
  return Buffer.from(canonicalJson(binding), "utf8");
}

function digest(bytes?: any) : any {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeBase64Url(value?: any, expectedBytes: any = 0) : any {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw encryptionError();
  }
  const bytes: any = Buffer.from(value, "base64url");
  if ((expectedBytes && bytes.length !== expectedBytes) || bytes.length === 0) {
    bytes.fill(0);
    throw encryptionError();
  }
  return bytes;
}

function assertEnvelope(envelope?: any) : any {
  const value: any = record(envelope);
  if (
    !value ||
    Object.keys(value).some((key?: any) : any => ![
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
}: Record<string, any> = {}) : Promise<any> {
  const plaintext: any = Buffer.from(canonicalJson(payload), "utf8");
  const aad: any = bindingBytes(binding);
  const iv: any = crypto.randomBytes(IV_BYTES);
  let keyFact: any;
  try {
    keyFact = await keyProvider.loadKey();
    const key: any = keyFact?.key;
    if (
      !Buffer.isBuffer(key) ||
      key.length !== 32 ||
      !SHA256_PATTERN.test(String(keyFact?.keyId || ""))
    ) {
      throw encryptionError("local_secret_key_invalid");
    }
    const cipher: any = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext: any = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag: any = cipher.getAuthTag();
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
}: Record<string, any> = {}) : Promise<any> {
  const value: any = assertEnvelope(envelope);
  const aad: any = bindingBytes(binding);
  const iv: any = decodeBase64Url(value.iv, IV_BYTES);
  const ciphertext: any = decodeBase64Url(value.ciphertext);
  const authTag: any = decodeBase64Url(value.authTag, TAG_BYTES);
  let keyFact: any;
  let plaintext: any;
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
    const decipher: any = crypto.createDecipheriv(ALGORITHM, keyFact.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload: any = JSON.parse(plaintext.toString("utf8"));
    if (!record(payload) || Object.keys(payload).length === 0) {
      throw encryptionError();
    }
    return payload;
  } catch (error: any) {
    if (error?.code?.startsWith?.("local_secret_")) throw error;
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
