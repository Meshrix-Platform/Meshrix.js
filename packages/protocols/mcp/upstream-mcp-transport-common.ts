import { createHash } from "node:crypto";

export const UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION: any = "v0.0.1:mcp:upstream-client-1";
export const MCP_JSONRPC_VERSION: any = "2.0";
export const MCP_DEFAULT_PROTOCOL_VERSION: any = "2025-06-18";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly any[] = Object.freeze([MCP_DEFAULT_PROTOCOL_VERSION]);
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS: any = 30_000;

const ENV_REF_PATTERN: any = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const ENV_TEMPLATE_PATTERN: any = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const MCP_PROTOCOL_VERSION_PATTERN: any = /^\d{4}-\d{2}-\d{2}$/;
const STDIO_EXECUTION_ENV_NAMES: readonly any[] = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ"
]);

export function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asArray(value?: any) : any {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function text(value?: any) : any {
  return String(value ?? "").trim();
}

export function positiveInt(value?: any, fallback: any = DEFAULT_MCP_REQUEST_TIMEOUT_MS) : any {
  const number: any = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function resolveEnvString(value?: any, env: any = process.env) : any {
  const raw: any = String(value ?? "");
  const match: any = raw.match(ENV_REF_PATTERN);
  if (match) {
    return String(env[match[1] || match[2] || ""] ?? "");
  }
  return raw.replace(
    ENV_TEMPLATE_PATTERN,
    (_match?: any, braced?: any, bare?: any) : any => String(env[braced || bare] ?? "")
  );
}

export function resolveStringRecord(record: Record<string, any> = {}, env: any = process.env) : any {
  return Object.fromEntries(
    (Object.entries(asObject(record)) as [string, any][])
      .map(([key, value]: any[]) : any => [text(key), resolveEnvString(value, env)])
      .filter(([key]: any[]) : any => key)
  );
}

export function stdioExecutionEnv(env: any = process.env) : any {
  return Object.fromEntries(
    STDIO_EXECUTION_ENV_NAMES
      .filter((name?: any) : any => env[name] !== undefined)
      .map((name?: any) : any => [name, String(env[name])])
  );
}

export function parseJson(value?: any) : any {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

export function normalizeTransportConfig(config: Record<string, any> = {}) : any {
  const source: any = asObject(config.mcp || config);
  const transport: any = text(source.transport || source.type || "stdio").toLowerCase();
  return {
    ...source,
    transport,
    timeoutMs: positiveInt(
      source.timeoutMs || source.timeout || config.timeoutMs,
      DEFAULT_MCP_REQUEST_TIMEOUT_MS
    )
  };
}

export function requestedProtocolVersion(config: Record<string, any> = {}) : any {
  const normalized: any = normalizeTransportConfig(config);
  const hinted: any = text(
    normalized.protocolVersionHint ||
      normalized.mcpProtocolVersion ||
      normalized.protocolRevision
  );
  if (MCP_PROTOCOL_VERSION_PATTERN.test(hinted)) {
    if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(hinted)) {
      throw protocolError("Upstream MCP configuration selected an unsupported protocol version.");
    }
    return hinted;
  }
  const direct: any = text(normalized.protocolVersion);
  const selected: any = MCP_PROTOCOL_VERSION_PATTERN.test(direct)
    ? direct
    : MCP_DEFAULT_PROTOCOL_VERSION;
  if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(selected)) {
    throw protocolError("Upstream MCP configuration selected an unsupported protocol version.");
  }
  return selected;
}

export function assertNegotiatedProtocolVersion(result: Record<string, any> = {}, requested: any = MCP_DEFAULT_PROTOCOL_VERSION) : any {
  const negotiated: any = text(asObject(result).protocolVersion);
  if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated) || negotiated !== requested) {
    throw protocolError("Upstream MCP negotiated an unsupported protocol version.");
  }
  return negotiated;
}

export function initializeParams(config: Record<string, any> = {}) : any {
  return {
    protocolVersion: requestedProtocolVersion(config),
    capabilities: {},
    clientInfo: {
      name: "Meshrix.js Upstream MCP Gateway",
      version: "0.0.1"
    }
  };
}

export function jsonRpcRequest(id?: any, method?: any, params: Record<string, any> = {}) : any {
  return {
    jsonrpc: MCP_JSONRPC_VERSION,
    id,
    method,
    params
  };
}

export function jsonRpcNotification(method?: any, params: Record<string, any> = {}) : any {
  return {
    jsonrpc: MCP_JSONRPC_VERSION,
    method,
    params
  };
}

export function assertJsonRpcResponse(payload?: any, id?: any) : any {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw protocolError("Upstream MCP response is not a JSON-RPC object.");
  }
  if (payload.jsonrpc !== MCP_JSONRPC_VERSION) {
    throw protocolError("Upstream MCP response used an unsupported JSON-RPC version.");
  }
  if (id !== undefined && payload.id !== id) {
    throw protocolError("Upstream MCP response id did not match the request id.");
  }
  const hasResult: any = Object.prototype.hasOwnProperty.call(payload, "result");
  const hasError: any = Object.prototype.hasOwnProperty.call(payload, "error");
  if (hasResult === hasError) {
    throw protocolError("Upstream MCP response must contain exactly one result or error.");
  }
  if (hasError) {
    const error: Error & Record<string, any> = new Error(text(payload.error.message) || "Upstream MCP request failed.");
    error.code = payload.error.code;
    error.data = payload.error.data;
    error.mcpJsonRpcError = true;
    throw error;
  }
  return payload.result ?? {};
}

export function abortError(message: any = "Upstream MCP request was cancelled.") : any {
  const error: Error & Record<string, any> = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function timeoutError(method: any = "request") : any {
  const error: Error & Record<string, any> = new Error(`Upstream MCP request timed out: ${method}`);
  error.name = "TimeoutError";
  error.code = "UPSTREAM_MCP_TIMEOUT";
  return error;
}

export function fatalSessionError(message?: any, cause?: any) : any {
  const error: Error & Record<string, any> = new Error(message, cause ? { cause } : undefined);
  error.code = "UPSTREAM_MCP_SESSION_FATAL";
  error.mcpSessionFatal = true;
  return error;
}

export function missingSessionError() : any {
  const error: Error & Record<string, any> = new Error("Upstream MCP session is no longer available.");
  error.code = "UPSTREAM_MCP_SESSION_NOT_FOUND";
  error.mcpSessionFatal = true;
  error.mcpSessionNotFound = true;
  return error;
}

export function protocolError(message?: any) : any {
  const error: any = fatalSessionError(message);
  error.code = "UPSTREAM_MCP_PROTOCOL_ERROR";
  return error;
}

export function notifySafely(callback?: any, payload?: any) : any {
  if (typeof callback !== "function") return Promise.resolve();
  try {
    return Promise.resolve(callback(payload)).catch(() : any => undefined);
  } catch {
    return Promise.resolve();
  }
}

function canonicalValue(value?: any, seen: any = new WeakSet<object>()) : any {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry?: any) : any => canonicalValue(entry, seen));
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result: any = Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key?: any) : any => typeof value[key] !== "function")
      .map((key?: any) : any => [key, canonicalValue(value[key], seen)])
  );
  seen.delete(value);
  return result;
}

export function fallbackSessionKey(config: Record<string, any> = {}) : any {
  const normalized: any = normalizeTransportConfig(config);
  const identity: any = canonicalValue({
    transport: normalized.transport,
    command: normalized.command,
    args: normalized.args,
    env: normalized.env,
    url: normalized.url || normalized.endpoint || normalized.baseUrl,
    headers: normalized.headers,
    protocolVersion: requestedProtocolVersion(normalized),
    credentialRevision: config.credentialRevision || normalized.credentialRevision || "",
    configRevision: config.configRevision || normalized.configRevision || ""
  });
  return `derived:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function sessionIdentity(config: Record<string, any> = {}) : any {
  const explicitKey: any = text(config.sessionKey || config.mcp?.sessionKey);
  return {
    key: explicitKey || fallbackSessionKey(config),
    scope: text(config.sessionScope || config.mcp?.sessionScope),
    generation: asObject(config.sessionGeneration || config.mcp?.sessionGeneration)
  };
}

export function isHttpMcpTransport(transport: any = "") : any {
  return ["http", "https", "streamable-http", "sse", "remote"].includes(
    text(transport).toLowerCase()
  );
}
