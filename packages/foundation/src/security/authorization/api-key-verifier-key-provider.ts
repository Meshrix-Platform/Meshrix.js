import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../../storage/private-file-atomic.ts";

export const API_KEY_VERIFIER_GENERATION = "v1";

export function createMemoryApiKeyVerifierKeyProvider(key: Buffer = crypto.randomBytes(32)): any {
  const material: any = Buffer.from(key);
  if (material.length !== 32) throw new Error("API Key verifier key must be 256 bits.");
  return Object.freeze({
    currentGeneration: API_KEY_VERIFIER_GENERATION,
    getKey(generation: string): Buffer | null {
      return generation === API_KEY_VERIFIER_GENERATION ? Buffer.from(material) : null;
    }
  });
}

export function createApiKeyVerifierKeyProvider({ userDataPath }: Record<string, any> = {}): any {
  const root: any = path.join(String(userDataPath || ""), "security", "api-key-verifiers");
  const keyPath: any = path.join(root, `${API_KEY_VERIFIER_GENERATION}.key`);
  ensurePrivateDir(root);
  let material: any;
  try {
    material = fs.readFileSync(keyPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    material = crypto.randomBytes(32);
    try {
      fs.writeFileSync(keyPath, material, { flag: "wx", mode: 0o600 });
    } catch (writeError: any) {
      if (writeError?.code !== "EEXIST") throw writeError;
      material = fs.readFileSync(keyPath);
    }
  }
  if (!Buffer.isBuffer(material) || material.length !== 32) {
    throw new Error("API Key verifier key generation is unavailable.");
  }
  fs.chmodSync(keyPath, 0o600);
  return createMemoryApiKeyVerifierKeyProvider(material);
}
