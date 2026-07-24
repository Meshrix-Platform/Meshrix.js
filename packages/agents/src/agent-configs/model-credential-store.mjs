import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";

export const MODEL_CREDENTIAL_MASTER_KEY_ENV = "MESHRIX_MODEL_CREDENTIAL_MASTER_KEY";

const SCHEMA_VERSION = "v0.0.1:agent:model-credential-envelope-1";

function text(value) {
  return String(value || "").trim();
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function masterKey() {
  const material = String(process.env[MODEL_CREDENTIAL_MASTER_KEY_ENV] || "");
  if (material.length < 32) {
    const error = new Error(
      `Model credentials require ${MODEL_CREDENTIAL_MASTER_KEY_ENV} with at least 32 characters.`
    );
    error.code = "model_credential_master_key_required";
    throw error;
  }
  return crypto.createHash("sha256").update(material).digest();
}

async function writePrivateJson(filePath, value) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function assertReference(reference = "") {
  const value = text(reference);
  const match = /^model-credential:\/\/([a-z0-9-]+)\/([a-f0-9]{64})$/u.exec(value);
  if (!match) {
    throw new Error("Model credential reference is invalid.");
  }
  return { reference: value, generation: match[1], id: match[2] };
}

export class ModelCredentialStore {
  constructor({ rootPath } = {}) {
    const resolvedRoot = text(rootPath);
    if (!resolvedRoot) {
      throw new TypeError("ModelCredentialStore requires an explicit rootPath.");
    }
    this.rootPath = resolvedRoot;
  }

  valuePath(reference) {
    const parsed = assertReference(reference);
    return path.join(this.rootPath, `${parsed.id}.json`);
  }

  async save({ generation, binding, payload = {} } = {}) {
    const normalizedGeneration = text(generation);
    const normalizedBinding = text(binding);
    const apiKey = text(payload.apiKey);
    const token = text(payload.token);
    if (!/^generation-[a-z0-9-]+$/u.test(normalizedGeneration) || !normalizedBinding) {
      throw new Error("Model credential generation and binding are required.");
    }
    if (!apiKey && !token) {
      return "";
    }
    const id = digest([
      normalizedGeneration,
      normalizedBinding,
      crypto.randomBytes(16).toString("hex")
    ].join("\n"));
    const reference = `model-credential://${normalizedGeneration}/${id}`;
    const nonce = crypto.randomBytes(12);
    const aad = Buffer.from(`${reference}\n${normalizedBinding}`, "utf8");
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ apiKey, token }), "utf8"),
      cipher.final()
    ]);
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      reference,
      generation: normalizedGeneration,
      bindingDigest: digest(normalizedBinding),
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    await writePrivateJson(this.valuePath(reference), envelope);
    return reference;
  }

  async load({ reference, binding } = {}) {
    const parsed = assertReference(reference);
    const normalizedBinding = text(binding);
    if (!normalizedBinding) {
      throw new Error("Model credential binding is required.");
    }
    const envelope = await readJson(this.valuePath(parsed.reference));
    if (
      envelope?.schemaVersion !== SCHEMA_VERSION ||
      envelope.reference !== parsed.reference ||
      envelope.generation !== parsed.generation ||
      envelope.bindingDigest !== digest(normalizedBinding) ||
      envelope.algorithm !== "aes-256-gcm"
    ) {
      throw new Error("Model credential envelope or binding is invalid.");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      Buffer.from(envelope.nonce, "base64")
    );
    decipher.setAAD(Buffer.from(`${parsed.reference}\n${normalizedBinding}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    const payload = JSON.parse(plaintext);
    return {
      apiKey: text(payload.apiKey),
      token: text(payload.token)
    };
  }

  async delete(reference) {
    if (!reference) return;
    await fs.rm(this.valuePath(reference), { force: true });
  }

  async deleteGeneration(generation) {
    const normalizedGeneration = text(generation);
    let entries = [];
    try {
      entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(this.rootPath, entry.name);
        const envelope = await readJson(filePath);
        if (envelope?.generation === normalizedGeneration) {
          await fs.rm(filePath, { force: true });
        }
      }));
  }
}
