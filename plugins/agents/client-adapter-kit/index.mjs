import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Canonical protocol contract pinned by Meshrix Core; do not edit here without a Core release.
// Source: Meshrix/packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.mjs (MCP_CLIENT_ADAPTER_PROTOCOL)
// and  .../gateway-installer/lib/cli/client-adapter-runner.mjs (CLIENT_ADAPTER_DESCRIPTOR_SCHEMA).
export const ADAPTER_PROTOCOL = "v0.0.1:meshrix:client-adapter-json-stdio-1";
export const ADAPTER_DESCRIPTOR_SCHEMA = "v0.0.1:meshrix:client-adapter-descriptor-1";
export const MCP_SERVER_NAME = "lico";
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
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

export function connectorFrom(request, target) {
  const connector = request?.connector;
  if (!connector || typeof connector.command !== "string" || !connector.command.trim() ||
      !Array.isArray(connector.args) || connector.args.some((entry) => typeof entry !== "string")) {
    throw adapterError("invalid_connector", "A connector command and string arguments are required.", 64);
  }
  const baseUrl = String(request.baseUrl || "").trim();
  const tokenEnv = String(request.tokenEnv || "MESHRIX_MCP_TOKEN").trim();
  if (!/^https?:\/\/[^\s]+$/u.test(baseUrl)) throw adapterError("invalid_base_url", "A valid HTTP base URL is required.", 64);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) throw adapterError("invalid_token_binding", "The credential environment binding is invalid.", 64);
  return {
    command: connector.command.trim(),
    args: [...connector.args, "proxy", "--target", target, "--url", baseUrl, "--token-env", tokenEnv]
  };
}

export function clientCommand(request, fallback) {
  const value = String(request?.client?.command || fallback || "").trim();
  if (!value) throw adapterError("client_not_configured", "A client command is required.", 64);
  return value;
}

export function adapterError(code, message, exitCode = 70) {
  const error = new Error(message);
  error.adapterCode = code;
  error.exitCode = exitCode;
  return error;
}

export function sanitizedMessage(error) {
  return String(error?.message || error || "Adapter operation failed.")
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/)[^\s"']+/gu, "<redacted-path>")
    .replace(/[A-Za-z]:\\[^\s"']+/gu, "<redacted-path>")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9._~-]{24,}\b/gu, "<redacted-secret>")
    .slice(0, 320);
}

function assertNoSecrets(value, location = "request") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw adapterError("raw_secret_rejected", `Raw credential field is forbidden at ${location}.`, 64);
    assertNoSecrets(entry, `${location}.${key}`);
  }
}

export async function run(command, args = [], {
  allowFailure = false,
  input = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env
} = {}) {
  if (!command || !Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
    throw adapterError("invalid_command", "Client command invocation is invalid.", 64);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        throw adapterError("output_limit", "Client command exceeded the output limit.", 70);
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { finish(() => reject(error)); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { finish(() => reject(error)); }
    });
    child.on("error", (error) => finish(() => reject(adapterError("client_unavailable", sanitizedMessage(error), 69))));
    child.on("close", (code) => finish(() => {
      const result = { ok: code === 0, code: Number(code ?? -1), stdout, stderr };
      if (!result.ok && !allowFailure) reject(adapterError("client_command_failed", "The client command failed.", 70));
      else resolve(result);
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(adapterError("client_timeout", "The client command timed out.", 70)));
    }, Math.max(100, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 60_000)));
    child.stdin.end(input);
  });
}

export async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw adapterError("invalid_client_config", "The client configuration is invalid.", 74);
  }
}

export function parseJsonc(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < String(source).length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; output += char; continue; }
    if (char === "/" && next === "/") { while (index < source.length && source[index] !== "\n") index += 1; output += "\n"; continue; }
    if (char === "/" && next === "*") { index += 2; while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1; index += 1; continue; }
    output += char;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/gu, "$1"));
}

export async function readJsonc(filePath, fallback = {}) {
  try {
    return parseJsonc(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw adapterError("invalid_client_config", "The client configuration is invalid.", 74);
  }
}

export async function writeJson(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export async function removeNamedEntry(filePath, rootKey) {
  const config = await readJsonc(filePath, {});
  const existed = Boolean(config?.[rootKey] && Object.hasOwn(config[rootKey], MCP_SERVER_NAME));
  if (existed) {
    delete config[rootKey][MCP_SERVER_NAME];
    await writeJson(filePath, config);
  }
  return existed;
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
