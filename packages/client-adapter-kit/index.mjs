import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterError, sanitizedMessage } from "./shared.mjs";

// Shared with the bundled installer runner and mcp-release-targets.ts.
export * from "./shared.mjs";
export * from "./native-registration.mjs";
export const ADAPTER_PROTOCOL = "v0.0.1:meshrix:client-adapter-json-stdio-1";
export const ADAPTER_DESCRIPTOR_SCHEMA = "v0.0.1:meshrix:client-adapter-descriptor-1";
export const MCP_SERVER_NAME = "lico";
const MAX_INPUT_BYTES = 256 * 1024;
const SECRET_KEY = /^(?:token|accessToken|refreshToken|apiKey|secret|password|privateKey)$/iu;

export function descriptor(value) {
  const result = Object.freeze({
    schemaVersion: ADAPTER_DESCRIPTOR_SCHEMA,
    protocol: ADAPTER_PROTOCOL,
    actions: Object.freeze(["describe", "scan", "install", "verify", "uninstall"]),
    locations: Object.freeze(["local"]),
    ...value
  });
  if (!/^[a-z][a-z0-9-]*$/u.test(result.target || "")) throw new Error("Adapter target is invalid.");
  if (!Array.isArray(result.commandNames) || result.commandNames.length === 0) throw new Error("Adapter command names are invalid.");
  return result;
}

function assertNoSecrets(value, location = "request") {
  if (typeof value === "string" && /mxak1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u.test(value)) {
    throw adapterError("raw_secret_rejected", "Raw credentials are forbidden in adapter requests.", 64);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || /^(?:headers|authorization|connector)$/iu.test(key)) throw adapterError("raw_secret_rejected", "Raw credentials and connector configuration are forbidden in adapter requests.", 64);
    assertNoSecrets(entry, `${location}.${key}`);
  }
}

export function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw adapterError("input_limit", "Adapter request exceeded the input limit.", 64);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let request;
  try { request = JSON.parse(raw); } catch { throw adapterError("invalid_json", "Adapter request must be JSON.", 64); }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw adapterError("invalid_request", "Adapter request must be an object.", 64);
  assertNoSecrets(request);
  return request;
}

export async function invokeAdapter(adapter, action, request = {}) {
  if (action === "describe") return adapter.description;
  if (!adapter.description.actions.includes(action) || typeof adapter[action] !== "function") {
    throw adapterError("unsupported_action", "The adapter action is unsupported.", 64);
  }
  if (request.schemaVersion && request.schemaVersion !== ADAPTER_PROTOCOL) {
    throw adapterError("unsupported_protocol", "The adapter request protocol is unsupported.", 64);
  }
  assertNoSecrets(request);
  return adapter[action](request);
}

export async function runAdapterCli(adapter) {
  const action = String(process.argv[2] || "describe");
  try {
    const result = await invokeAdapter(adapter, action, await readRequest());
    process.stdout.write(`${JSON.stringify({ schemaVersion: ADAPTER_PROTOCOL, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: ADAPTER_PROTOCOL,
      ok: false,
      error: { code: error?.adapterCode || "adapter_failure", message: sanitizedMessage(error) }
    })}\n`);
    process.exitCode = Number(error?.exitCode || 70);
  }
}

export function isDirectInvocation(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl)); }
  catch { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl)); }
}
