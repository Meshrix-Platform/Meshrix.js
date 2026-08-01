import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_IDENTITY_SCHEMA_VERSION,
  stableStringify
} from "@meshrix/protocols/mcp/adapter/mcp-identity";

function base64Url(input?: any) : any {
  return Buffer.from(input).toString("base64url");
}

function identityPath(userDataPath?: any) : any {
  return path.join(userDataPath, "mcp-identity.json");
}

function keyIdFromPublicKey(publicKeyJwk?: any) : any {
  return `ed25519:${base64Url(stableStringify(publicKeyJwk)).slice(0, 32)}`;
}

function normalizeIdentity(payload?: any) : any {
  if (
    payload?.schemaVersion !== MCP_IDENTITY_SCHEMA_VERSION ||
    payload?.algorithm !== "Ed25519" ||
    !payload?.publicKeyJwk ||
    !payload?.privateKeyJwk
  ) {
    throw new Error("Invalid MCP identity file.");
  }
  return {
    ...payload,
    schemaVersion: MCP_IDENTITY_SCHEMA_VERSION,
    keyId: payload.keyId || keyIdFromPublicKey(payload.publicKeyJwk)
  };
}

async function writeIdentity(filePath?: any, identity?: any) : Promise<any> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${filePath}.tmp`, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function loadOrCreateMcpIdentity(userDataPath?: any) : Promise<any> {
  const filePath: any = identityPath(userDataPath);
  try {
    const payload: any = JSON.parse(await fs.readFile(filePath, "utf8"));
    const identity: any = normalizeIdentity(payload);
    if (identity.schemaVersion !== payload.schemaVersion || identity.keyId !== payload.keyId) {
      await writeIdentity(filePath, identity);
    }
    return identity;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk: any = publicKey.export({ format: "jwk" });
  const identity: Record<string, any> = {
    schemaVersion: MCP_IDENTITY_SCHEMA_VERSION,
    algorithm: "Ed25519",
    keyId: keyIdFromPublicKey(publicKeyJwk),
    publicKeyJwk,
    privateKeyJwk: privateKey.export({ format: "jwk" }),
    createdAt: new Date().toISOString()
  };
  await writeIdentity(filePath, identity);
  return identity;
}
