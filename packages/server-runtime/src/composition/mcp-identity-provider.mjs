import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_IDENTITY_SCHEMA_VERSION,
  stableStringify
} from "@meshrix/protocols/mcp/adapter/mcp-identity";

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function identityPath(userDataPath) {
  return path.join(userDataPath, "mcp-identity.json");
}

function keyIdFromPublicKey(publicKeyJwk) {
  return `ed25519:${base64Url(stableStringify(publicKeyJwk)).slice(0, 32)}`;
}

function normalizeIdentity(payload) {
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

async function writeIdentity(filePath, identity) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${filePath}.tmp`, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function loadOrCreateMcpIdentity(userDataPath) {
  const filePath = identityPath(userDataPath);
  try {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
    const identity = normalizeIdentity(payload);
    if (identity.schemaVersion !== payload.schemaVersion || identity.keyId !== payload.keyId) {
      await writeIdentity(filePath, identity);
    }
    return identity;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  const identity = {
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
