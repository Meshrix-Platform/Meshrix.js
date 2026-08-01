import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "@meshrix/foundation/storage/private-file-atomic";

export const MODEL_CREDENTIAL_MASTER_KEY_ENV: any = "MESHRIX_MODEL_CREDENTIAL_MASTER_KEY";

const SCHEMA_VERSION: any = "v0.0.1:agent:model-credential-envelope-1";

function text(value?: any) : any {
  return String(value || "").trim();
}

function digest(value?: any) : any {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function masterKey() : any {
  const material: any = String(process.env[MODEL_CREDENTIAL_MASTER_KEY_ENV] || "");
  if (material.length < 32) {
    const error: Error & Record<string, any> = new Error(
      `Model credentials require ${MODEL_CREDENTIAL_MASTER_KEY_ENV} with at least 32 characters.`
    );
    error.code = "model_credential_master_key_required";
    throw error;
  }
  return crypto.createHash("sha256").update(material).digest();
}

async function writePrivateJson(filePath?: any, value?: any) : Promise<any> {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function assertReference(reference: any = "") : any {
  const value: any = text(reference);
  const match: any = /^model-credential:\/\/([a-z0-9-]+)\/([a-f0-9]{64})$/u.exec(value);
  if (!match) {
    throw new Error("Model credential reference is invalid.");
  }
  return { reference: value, generation: match[1], id: match[2] };
}

export class ModelCredentialStore {
  rootPath: any;
  constructor({ rootPath }: Record<string, any> = {}) {
    const resolvedRoot: any = text(rootPath);
    if (!resolvedRoot) {
      throw new TypeError("ModelCredentialStore requires an explicit rootPath.");
    }
    this.rootPath = resolvedRoot;
  }

  valuePath(reference?: any) : any {
    const parsed: any = assertReference(reference);
    return path.join(this.rootPath, `${parsed.id}.json`);
  }

  async save({ generation, binding, payload = {} }: Record<string, any> = {}) : Promise<any> {
    const normalizedGeneration: any = text(generation);
    const normalizedBinding: any = text(binding);
    const apiKey: any = text(payload.apiKey);
    const token: any = text(payload.token);
    if (!/^generation-[a-z0-9-]+$/u.test(normalizedGeneration) || !normalizedBinding) {
      throw new Error("Model credential generation and binding are required.");
    }
    if (!apiKey && !token) {
      return "";
    }
    const id: any = digest([
      normalizedGeneration,
      normalizedBinding,
      crypto.randomBytes(16).toString("hex")
    ].join("\n"));
    const reference: any = `model-credential://${normalizedGeneration}/${id}`;
    const nonce: any = crypto.randomBytes(12);
    const aad: any = Buffer.from(`${reference}\n${normalizedBinding}`, "utf8");
    const cipher: any = crypto.createCipheriv("aes-256-gcm", masterKey(), nonce);
    cipher.setAAD(aad);
    const ciphertext: any = Buffer.concat([
      cipher.update(JSON.stringify({ apiKey, token }), "utf8"),
      cipher.final()
    ]);
    const envelope: Record<string, any> = {
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

  async load({ reference, binding }: Record<string, any> = {}) : Promise<any> {
    const parsed: any = assertReference(reference);
    const normalizedBinding: any = text(binding);
    if (!normalizedBinding) {
      throw new Error("Model credential binding is required.");
    }
    const envelope: any = await readJson(this.valuePath(parsed.reference));
    if (
      envelope?.schemaVersion !== SCHEMA_VERSION ||
      envelope.reference !== parsed.reference ||
      envelope.generation !== parsed.generation ||
      envelope.bindingDigest !== digest(normalizedBinding) ||
      envelope.algorithm !== "aes-256-gcm"
    ) {
      throw new Error("Model credential envelope or binding is invalid.");
    }
    const decipher: any = crypto.createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      Buffer.from(envelope.nonce, "base64")
    );
    decipher.setAAD(Buffer.from(`${parsed.reference}\n${normalizedBinding}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext: any = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
    const payload: any = JSON.parse(plaintext);
    return {
      apiKey: text(payload.apiKey),
      token: text(payload.token)
    };
  }

  async delete(reference?: any) : Promise<any> {
    if (!reference) return;
    await fs.rm(this.valuePath(reference), { force: true });
  }

  async deleteGeneration(generation?: any) : Promise<any> {
    const normalizedGeneration: any = text(generation);
    let entries: any[] = [];
    try {
      entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry?: any) : any => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry?: any) : Promise<any> => {
        const filePath: any = path.join(this.rootPath, entry.name);
        const envelope: any = await readJson(filePath);
        if (envelope?.generation === normalizedGeneration) {
          await fs.rm(filePath, { force: true });
        }
      }));
  }
}
