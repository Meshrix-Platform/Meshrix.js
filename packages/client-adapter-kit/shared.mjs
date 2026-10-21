import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const MAX_OUTPUT_BYTES = 256 * 1024;

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

export function registrationFrom(request) {
  const serverName = request?.serverName;
  const reference = request?.credentialRef;
  if (typeof serverName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(serverName) || ["constructor", "prototype"].includes(serverName)) {
    throw adapterError("invalid_registration_name", "An explicit alphanumeric MCP registration name is required.", 64);
  }
  if (!reference || reference.kind !== "env" || typeof reference.name !== "string" ||
      !/^[A-Z_][A-Z0-9_]*$/u.test(reference.name) || Object.keys(reference).some((key) => !["kind", "name"].includes(key))) {
    throw adapterError("invalid_credential_reference", "An explicit environment credential reference is required; no key value is accepted.", 64);
  }
  const baseUrl = String(request.baseUrl || "").trim().replace(/\/+$/u, "");
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw adapterError("invalid_base_url", "A valid HTTPS base URL is required.", 64);
  }
  if (!/^https?:$/u.test(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw adapterError("invalid_base_url", "A valid HTTPS base URL without embedded credentials, query, or fragment is required.", 64);
  }
  const authority = baseUrl.split("://")[1]?.split(/[/?#]/u)[0] || "";
  const literalHost = authority.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "");
  if (endpoint.protocol === "http:" && (!isIP(literalHost) || !isLiteralLoopback(endpoint.hostname))) {
    throw adapterError("insecure_base_url", "HTTP is allowed only for a literal loopback development endpoint; use HTTPS for remote endpoints.", 64);
  }
  return { serverName, baseUrl, url: `${baseUrl}/mcp`, credentialRef: { kind: "env", name: reference.name } };
}

function isLiteralLoopback(hostname) {
  const address = hostname.replace(/^\[|\]$/gu, "");
  if (address.toLowerCase() === "::1") return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) return false;
  const octets = address.split(".").map(Number);
  return octets.every((octet) => octet <= 255) && octets[0] === 127;
}

export function clientCommand(request, fallback) {
  const value = String(request?.client?.command || fallback || "").trim();
  if (!value) throw adapterError("client_not_configured", "A client command is required.", 64);
  return value;
}

export async function run(command, args = [], {
  allowFailure = false,
  input = "",
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
    if (char === "/" && next === "*") { index += 2; while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1; index += 1; output += " "; continue; }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (/\s/u.test(source[cursor])) { cursor += 1; continue; }
        if (source.startsWith("//", cursor)) {
          const end = source.indexOf("\n", cursor + 2);
          cursor = end < 0 ? source.length : end + 1;
          continue;
        }
        if (source.startsWith("/*", cursor)) {
          const end = source.indexOf("*/", cursor + 2);
          if (end < 0) break;
          cursor = end + 2;
          continue;
        }
        break;
      }
      if (source[cursor] === "}" || source[cursor] === "]") continue;
    }
    output += char;
  }
  return JSON.parse(output);
}

export async function readJsonc(filePath, fallback = {}) {
  try {
    return parseJsonc(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw adapterError("invalid_client_config", "The client configuration is invalid.", 74);
  }
}

export async function writePrivateFile(filePath, content) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await fs.mkdtemp(path.join(directory, ".meshrix-registration-"));
  const temporary = path.join(temporaryDirectory, "config");
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function writeJson(filePath, value) {
  await writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
