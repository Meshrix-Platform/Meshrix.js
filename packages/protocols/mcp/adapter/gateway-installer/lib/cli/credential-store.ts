import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MXAK1_CREDENTIAL_PATTERN, normalizeBaseUrl, normalizeTarget } from "./basic-utils.ts";

export const MESHRIX_MCP_CREDENTIAL_DIR_ENV: any = "MESHRIX_MCP_CREDENTIAL_DIR";

const CREDENTIAL_SCHEMA: any = "v0.0.1:meshrix:mcp-api-key-credential-1";

function credentialRoot() : any {
  const configured: any = String(process.env[MESHRIX_MCP_CREDENTIAL_DIR_ENV] || "").trim();
  return path.resolve(configured || path.join(os.homedir(), ".meshrix", "mcp", "credentials"));
}

function credentialBinding({ target, baseUrl }: Record<string, any>) : any {
  const normalizedTarget: any = normalizeTarget(target);
  const normalizedBaseUrl: any = normalizeBaseUrl(baseUrl);
  if (!normalizedTarget || !normalizedBaseUrl) {
    throw new Error("A target and Meshrix.js base URL are required for credential storage.");
  }
  const serverHash: any = createHash("sha256").update(normalizedBaseUrl, "utf8").digest("hex").slice(0, 24);
  return {
    target: normalizedTarget,
    baseUrl: normalizedBaseUrl,
    filePath: path.join(credentialRoot(), `${normalizedTarget}-${serverHash}.json`)
  };
}

function parseCredential(value?: any, expected: Record<string, any> = {}) : any {
  const record: any = typeof value === "string" ? JSON.parse(value) : value;
  if (
    record?.schemaVersion !== CREDENTIAL_SCHEMA
    || record?.target !== expected.target
    || record?.baseUrl !== expected.baseUrl
    || !MXAK1_CREDENTIAL_PATTERN.test(String(record?.apiKey || ""))
  ) {
    throw new Error("Stored Meshrix.js MCP credential is invalid.");
  }
  if (record.autoUpdate !== undefined && typeof record.autoUpdate !== "boolean") {
    throw new Error("Stored Meshrix.js MCP auto-update preference is invalid.");
  }
  return Object.freeze({ apiKey: String(record.apiKey), autoUpdate: record.autoUpdate === true });
}

async function writePrivateJson(filePath?: any, value?: any) : Promise<any> {
  const directory: any = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() : any => {});
  const temporaryPath: any = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle: any = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() : any => {});
  } finally {
    if (handle) await handle.close().catch(() : any => {});
    await fs.rm(temporaryPath, { force: true }).catch(() : any => {});
  }
}

export async function saveMcpApiKeyCredential({ target, baseUrl, token, autoUpdate = false }: Record<string, any>) : Promise<any> {
  const binding: any = credentialBinding({ target, baseUrl });
  const apiKey: any = String(token || "").trim();
  if (!MXAK1_CREDENTIAL_PATTERN.test(apiKey)) {
    throw new Error("A strict mxak1 credential is required for credential storage.");
  }
  await writePrivateJson(binding.filePath, {
    schemaVersion: CREDENTIAL_SCHEMA,
    target: binding.target,
    baseUrl: binding.baseUrl,
    apiKey,
    autoUpdate: autoUpdate === true
  });
  return { stored: true, backend: "connector-private-file" };
}

export async function loadMcpApiKeyCredential({ target, baseUrl }: Record<string, any>) : Promise<any> {
  if (!normalizeTarget(target) || !normalizeBaseUrl(baseUrl)) return "";
  const binding: any = credentialBinding({ target, baseUrl });
  let serialized: any;
  try {
    serialized = await fs.readFile(binding.filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  return parseCredential(serialized, binding).apiKey;
}

export async function loadMcpConnectorPreferences({ target, baseUrl }: Record<string, any>) : Promise<any> {
  if (!normalizeTarget(target) || !normalizeBaseUrl(baseUrl)) return Object.freeze({ autoUpdate: false });
  const binding: any = credentialBinding({ target, baseUrl });
  try {
    const credential: any = parseCredential(await fs.readFile(binding.filePath, "utf8"), binding);
    return Object.freeze({ autoUpdate: credential.autoUpdate });
  } catch (error: any) {
    if (error?.code === "ENOENT") return Object.freeze({ autoUpdate: false });
    throw error;
  }
}

export async function deleteMcpApiKeyCredential({ target, baseUrl }: Record<string, any>) : Promise<any> {
  if (!normalizeTarget(target) || !normalizeBaseUrl(baseUrl)) return { deleted: false };
  const binding: any = credentialBinding({ target, baseUrl });
  await fs.rm(binding.filePath, { force: true });
  const remains: any = await fs.lstat(binding.filePath).then(() : any => true).catch((error?: any) : any => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (remains) throw new Error("Meshrix.js MCP credential deletion was not confirmed.");
  return { deleted: true };
}
