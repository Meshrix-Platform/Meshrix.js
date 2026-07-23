import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const WRAP_ALGORITHM = "aes-256-gcm";

function custodyError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function readOrCreateMasterKey(keyPath) {
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(keyPath), 0o700);
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length !== 32) throw custodyError("custody_key_invalid", "Custody key broker material is invalid.");
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const created = crypto.randomBytes(32);
  let handle;
  try {
    handle = await fs.open(keyPath, "wx", 0o600);
    await handle.writeFile(created);
    await handle.sync();
    return Buffer.from(created);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await fs.readFile(keyPath);
    if (existing.length !== 32) throw custodyError("custody_key_invalid", "Custody key broker material is invalid.");
    return existing;
  } finally {
    await handle?.close().catch(() => {});
    created.fill(0);
  }
}

export function createLocalCustodyKeyBroker({ userDataPath } = {}) {
  const root = path.resolve(String(userDataPath || ""));
  if (!String(userDataPath || "").trim()) throw new TypeError("Custody key broker requires userDataPath.");
  const keyPath = path.join(root, "security", "execution-sandbox-custody", "master-key");
  const keyReference = "custody-key:local-primary";
  let masterKeyPromise = null;
  let closed = false;

  function masterKey() {
    if (closed) throw custodyError("custody_key_broker_closed", "Custody key broker is closed.");
    masterKeyPromise ||= readOrCreateMasterKey(keyPath);
    return masterKeyPromise;
  }

  async function wrapKey(dataKey, envelopeId) {
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
      throw new TypeError("Custody data key must contain 256 bits.");
    }
    const wrappingKey = await masterKey();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(WRAP_ALGORITHM, wrappingKey, nonce);
    cipher.setAAD(Buffer.from(String(envelopeId || ""), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Object.freeze({
      keyReference,
      algorithm: WRAP_ALGORITHM,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    });
  }

  async function unwrapKey(wrapped, envelopeId) {
    if (!wrapped || wrapped.keyReference !== keyReference || wrapped.algorithm !== WRAP_ALGORITHM) {
      throw custodyError("custody_key_reference_invalid", "Custody key reference is invalid.");
    }
    try {
      const decipher = crypto.createDecipheriv(
        WRAP_ALGORITHM,
        await masterKey(),
        Buffer.from(String(wrapped.nonce || ""), "base64")
      );
      decipher.setAAD(Buffer.from(String(envelopeId || ""), "utf8"));
      decipher.setAuthTag(Buffer.from(String(wrapped.tag || ""), "base64"));
      const key = Buffer.concat([
        decipher.update(Buffer.from(String(wrapped.ciphertext || ""), "base64")),
        decipher.final()
      ]);
      if (key.length !== 32) throw new Error("invalid key length");
      return key;
    } catch (error) {
      throw custodyError("custody_key_unwrap_failed", "Custody data key could not be recovered.", error);
    }
  }

  async function close() {
    closed = true;
    if (masterKeyPromise) (await masterKeyPromise).fill(0);
    masterKeyPromise = null;
  }

  return Object.freeze({ keyReference, wrapKey, unwrapKey, close });
}
