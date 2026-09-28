import { createHash } from "node:crypto";

export const UPSTREAM_MCP_CLIENT_PROTOCOL_VERSION: any = "v0.0.1:mcp:upstream-client-1";
export const MCP_JSONRPC_VERSION: any = "2.0";
export const MCP_DEFAULT_PROTOCOL_VERSION: any = "2025-06-18";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly any[] = Object.freeze([
  "2025-03-26",
  MCP_DEFAULT_PROTOCOL_VERSION
]);
export const DEFAULT_MCP_INITIALIZE_TIMEOUT_MS: any = 30_000;
export const DEFAULT_MCP_CONTROL_TIMEOUT_MS: any = 30_000;
const MAX_MCP_REQUEST_TIMEOUT_MS: any = 2_147_483_647;
export const MCP_TOOLS_LIST_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  pages: 64,
  tools: 4_096,
  bytes: 8 * 1024 * 1024
});

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

export function positiveInt(value?: any, fallback: any = 0) : any {
  const number: any = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function validateMcpRequestTimeoutMs(value?: any) : any {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_MCP_REQUEST_TIMEOUT_MS
  ) {
    throw new RangeError("MCP request timeout must be a positive integer supported by the runtime.");
  }
  return value;
}

export function requestTimeoutMs(
  requestOptions: Record<string, any> = {},
  normalizedConfig: Record<string, any> = {}
) : any {
  if (requestOptions.timeoutMs === null) {
    if (requestOptions.signal) return 0;
    throw new TypeError("An unset MCP request timeout requires an owning cancellation signal.");
  }
  if (requestOptions.timeoutMs !== undefined) {
    return validateMcpRequestTimeoutMs(requestOptions.timeoutMs);
  }
  if (normalizedConfig.timeoutMs === undefined) return 0;
  return validateMcpRequestTimeoutMs(normalizedConfig.timeoutMs);
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
  const configuredTimeoutMs: any = source.timeoutMs !== undefined
    ? source.timeoutMs
    : source.timeout !== undefined
      ? source.timeout
      : config.timeoutMs;
  const timeoutMs: any = configuredTimeoutMs === undefined
    ? undefined
    : validateMcpRequestTimeoutMs(configuredTimeoutMs);
  const normalized: Record<string, any> = {
    ...source,
    transport
  };
  if (timeoutMs > 0) normalized.timeoutMs = timeoutMs;
  else delete normalized.timeoutMs;
  return normalized;
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
  // MCP negotiation: the client proposes a version, the server selects the
  // version it supports. Accept any server-selected version we support rather
  // than requiring an exact echo of the request.
  if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
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

export async function collectCompleteMcpToolsList(
  requestPage: (cursor: string | undefined) => Promise<Record<string, any>>
) : Promise<any[]> {
  const seenCursors: any = new Set<any>();
  const seenToolNames: any = new Set<any>();
  const tools: any[] = [];
  let cursor: any = undefined;
  let bytes: any = 0;
  for (let page = 1; page <= MCP_TOOLS_LIST_LIMITS.pages; page += 1) {
    const result: any = await requestPage(cursor);
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.tools)) {
      throw Object.assign(new Error("Upstream MCP tools/list returned an invalid page."), {
        code: "upstream_mcp_tools_list_malformed",
        status: 502
      });
    }
    if (result.tools.some((tool?: any) : any => !tool || typeof tool !== "object" || Array.isArray(tool) || typeof tool.name !== "string" || !text(tool.name))) {
      throw Object.assign(new Error("Upstream MCP tools/list returned an invalid tool."), {
        code: "upstream_mcp_tools_list_malformed",
        status: 502
      });
    }
    for (const tool of result.tools) {
      const name: any = text(tool.name);
      if (seenToolNames.has(name)) {
        throw Object.assign(new Error("Upstream MCP tools/list returned a duplicate tool name."), {
          code: "upstream_mcp_tools_list_malformed",
          status: 502
        });
      }
      seenToolNames.add(name);
    }
    bytes += Buffer.byteLength(JSON.stringify(result.tools), "utf8");
    if (tools.length + result.tools.length > MCP_TOOLS_LIST_LIMITS.tools || bytes > MCP_TOOLS_LIST_LIMITS.bytes) {
      throw Object.assign(new Error("Upstream MCP tools/list exceeded the complete-list admission limit."), {
        code: "upstream_mcp_tools_list_limit",
        status: 502
      });
    }
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return tools;
    if (typeof result.nextCursor !== "string") {
      throw Object.assign(new Error("Upstream MCP tools/list returned an invalid cursor."), {
        code: "upstream_mcp_tools_list_cursor_invalid",
        status: 502
      });
    }
    if (seenCursors.has(result.nextCursor)) {
      throw Object.assign(new Error("Upstream MCP tools/list returned a repeated cursor."), {
        code: "upstream_mcp_tools_list_cursor_repeated",
        status: 502
      });
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw Object.assign(new Error("Upstream MCP tools/list exceeded the page admission limit."), {
    code: "upstream_mcp_tools_list_page_limit",
    status: 502
  });
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
  const kind: any = text(config.sessionKind || config.mcp?.sessionKind);
  return {
    key: explicitKey || fallbackSessionKey(config),
    scope: text(config.sessionScope || config.mcp?.sessionScope),
    generation: asObject(config.sessionGeneration || config.mcp?.sessionGeneration),
    kind: kind === "stateful" ? "stateful" : "ephemeral"
  };
}

export function isHttpMcpTransport(transport: any = "") : any {
  return ["http", "https", "streamable-http", "sse", "remote"].includes(
    text(transport).toLowerCase()
  );
}
