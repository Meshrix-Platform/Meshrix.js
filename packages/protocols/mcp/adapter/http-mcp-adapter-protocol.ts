import { MCP_PROTOCOL_VERSION, MCP_SERVER_VERSION } from "./http-mcp-adapter-constants.ts";
import {
  BASE64_SENTINEL_PREFIX,
  BASE64_SENTINEL_SUFFIX,
  encodeMcpHeaderValue,
  isPlainObject,
  MCP_DISCOVER_METHOD,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_NAME_BEARING_METHODS
} from "./http-mcp-adapter-client-wire.ts";

export { MCP_PROTOCOL_VERSION, MCP_SERVER_VERSION };
export {
  encodeMcpHeaderValue,
  MCP_DISCOVER_METHOD,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_CLIENT_INFO,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  mcpModernHttpRequest,
  mcpModernJsonRpcMessage,
  mcpModernRequestHeaders,
  mcpRequestMetadata
} from "./http-mcp-adapter-client-wire.ts";
import { jsonRpcError, jsonRpcNotification } from "./http-mcp-adapter-response.ts";

export const MCP_PROTOCOL_VERSION_HEADER: any = "mcp-protocol-version";
export const MCP_METHOD_HEADER: any = "mcp-method";
export const MCP_NAME_HEADER: any = "mcp-name";
export const MCP_SUBSCRIBE_METHOD: any = "subscriptions/listen";
export const MCP_SUBSCRIPTION_ACK_METHOD: any = "notifications/subscriptions/acknowledged";
export const MCP_RESULT_TYPE_COMPLETE: any = "complete";
export const MCP_CACHE_SCOPE_PRIVATE: any = "private";
export const MCP_CACHE_SCOPE_PUBLIC: any = "public";
export const MCP_TOOLS_LIST_CACHE_TTL_MS: any = 0;
export const MCP_DISCOVER_CACHE_TTL_MS: any = 3_600_000;

export const MCP_META_SUBSCRIPTION_ID: any = "io.modelcontextprotocol/subscriptionId";

export const MCP_JSONRPC_INVALID_PARAMS: any = -32602;
export const MCP_JSONRPC_METHOD_NOT_FOUND: any = -32601;
export const MCP_JSONRPC_INVALID_REQUEST: any = -32600;
export const MCP_ERROR_HEADER_MISMATCH: any = -32020;
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION: any = -32022;

export const MCP_NOTIFICATION_CAPABILITY_METHODS: any = Object.freeze({
  toolsListChanged: "notifications/tools/list_changed",
  meshrixSkillHubCatalogChanged: "notifications/meshrix/skill_hub/catalog_changed",
  meshrixUpdateAvailable: "notifications/meshrix/update_available"
});

const KNOWN_UNSUPPORTED_NOTIFICATION_CAPABILITIES: any = Object.freeze([
  "promptsListChanged",
  "resourcesListChanged",
  "resourceSubscriptions"
]);

const KNOWN_NOTIFICATION_CAPABILITIES: any = Object.freeze([
  ...Object.keys(MCP_NOTIFICATION_CAPABILITY_METHODS),
  ...KNOWN_UNSUPPORTED_NOTIFICATION_CAPABILITIES
]);

function headerRaw(request?: any, name?: any) : any {
  const headers: any = request?.headers || {};
  const lowerName: any = String(name || "").toLowerCase();
  const raw: any = headers[lowerName] ?? (Object.entries(headers) as [string, any][]).find(
    ([headerName]: any[]) : any => String(headerName || "").toLowerCase() === lowerName
  )?.[1];
  if (Array.isArray(raw)) {
    return raw.length === 1 ? raw[0] : raw.length === 0 ? undefined : "";
  }
  return raw;
}

export function mcpRequestHeader(request?: any, name?: any) : any {
  const raw: any = headerRaw(request, name);
  if (raw === undefined || raw === null) return "";
  return String(raw);
}

export function mcpProtocolVersionHeader(request?: any) : any {
  return mcpRequestHeader(request, MCP_PROTOCOL_VERSION_HEADER).trim();
}

export function mcpMethodHeader(request?: any) : any {
  return mcpRequestHeader(request, MCP_METHOD_HEADER);
}

export function isJsonRpcNotification(message?: any) : any {
  return Boolean(message) &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    !Object.prototype.hasOwnProperty.call(message, "id");
}

export function isMcpJsonRpcBatch(payload?: any) : any {
  return Array.isArray(payload);
}

function isValidBase64(value?: any) : any {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    !value.startsWith("=") &&
    (value.match(/=/g) || []).length <= 2 &&
    !/=[^=]/.test(value);
}

function isSafeRawMcpHeaderValue(text?: any) : any {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text !== text.trim()) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code: any = text.charCodeAt(index);
    if (code !== 0x09 && code !== 0x20 && (code < 0x21 || code > 0x7E)) {
      return false;
    }
  }
  return true;
}

function decodeBase64Utf8Strict(encoded?: any) : any {
  if (!isValidBase64(encoded)) {
    return { ok: false, reason: "malformed" };
  }
  const bytes: any = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    return { ok: false, reason: "malformed" };
  }
  try {
    const decoder: any = new TextDecoder("utf-8", { fatal: true });
    return { ok: true, value: decoder.decode(bytes) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export function decodeMcpHeaderValue(raw?: any) : any {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "missing" };
  }
  const text: any = String(raw);
  if (text.startsWith(BASE64_SENTINEL_PREFIX) && text.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return decodeBase64Utf8Strict(text.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length));
  }
  if (!isSafeRawMcpHeaderValue(text)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, value: text };
}

function protocolError(id?: any, httpStatus?: any, code?: any, message?: any, data: Record<string, any> = {}) : any {
  return {
    ok: false,
    httpStatus,
    body: jsonRpcError(id ?? null, code, message, data)
  };
}

export function mcpUnsupportedVersionError(id?: any, requested: any = "") : any {
  return protocolError(
    id,
    400,
    MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
    "Unsupported MCP protocol version.",
    {
      supported: [MCP_PROTOCOL_VERSION],
      requested: String(requested || "")
    }
  );
}

export function mcpMethodNotFoundError(id?: any) : any {
  return protocolError(
    id,
    404,
    MCP_JSONRPC_METHOD_NOT_FOUND,
    "Method not found.",
    {
      supported: [MCP_PROTOCOL_VERSION]
    }
  );
}

export function mcpBatchRejectedError() : any {
  return protocolError(
    null,
    400,
    MCP_JSONRPC_INVALID_REQUEST,
    "MCP Streamable HTTP accepts exactly one JSON-RPC request or notification per POST."
  );
}

export function evaluateMcpProtocolContract({
  request = null,
  message = null
}: Record<string, any> = {}) : any {
  if (isJsonRpcNotification(message)) {
    return { ok: true, notification: true, protocolVersion: MCP_PROTOCOL_VERSION };
  }

  const method: any = String(message?.method || "");
  const params: any = isPlainObject(message?.params) ? message.params : {};
  const meta: any = params._meta;
  if (!isPlainObject(meta)) {
    return protocolError(
      message?.id,
      400,
      MCP_JSONRPC_INVALID_PARAMS,
      "MCP request is missing required params._meta object."
    );
  }
  const bodyVersion: any = typeof meta[MCP_META_PROTOCOL_VERSION] === "string"
    ? meta[MCP_META_PROTOCOL_VERSION].trim()
    : "";
  if (!bodyVersion) {
    return protocolError(
      message?.id,
      400,
      MCP_JSONRPC_INVALID_PARAMS,
      `MCP request is missing required _meta['${MCP_META_PROTOCOL_VERSION}'].`
    );
  }
  if (!isPlainObject(meta[MCP_META_CLIENT_CAPABILITIES])) {
    return protocolError(
      message?.id,
      400,
      MCP_JSONRPC_INVALID_PARAMS,
      `MCP request is missing required object _meta['${MCP_META_CLIENT_CAPABILITIES}'].`
    );
  }

  const rawVersionHeader: any = headerRaw(request, MCP_PROTOCOL_VERSION_HEADER);
  const rawMethodHeader: any = headerRaw(request, MCP_METHOD_HEADER);
  if (rawVersionHeader === undefined || rawVersionHeader === null || String(rawVersionHeader).trim() === "") {
    return protocolError(
      message?.id,
      400,
      MCP_ERROR_HEADER_MISMATCH,
      "Required MCP-Protocol-Version header is missing."
    );
  }
  if (rawMethodHeader === undefined || rawMethodHeader === null || String(rawMethodHeader) === "") {
    return protocolError(
      message?.id,
      400,
      MCP_ERROR_HEADER_MISMATCH,
      "Required Mcp-Method header is missing."
    );
  }
  const headerVersion: any = String(rawVersionHeader).trim();
  const headerMethod: any = String(rawMethodHeader);
  if (headerVersion !== bodyVersion) {
    return protocolError(
      message?.id,
      400,
      MCP_ERROR_HEADER_MISMATCH,
      "MCP-Protocol-Version header does not match the request body protocol version."
    );
  }
  if (headerMethod !== method) {
    return protocolError(
      message?.id,
      400,
      MCP_ERROR_HEADER_MISMATCH,
      "Mcp-Method header does not match the JSON-RPC method."
    );
  }

  const nameField: any = MCP_NAME_BEARING_METHODS[method];
  if (nameField) {
    const rawNameHeader: any = headerRaw(request, MCP_NAME_HEADER);
    if (rawNameHeader === undefined || rawNameHeader === null || String(rawNameHeader) === "") {
      return protocolError(
        message?.id,
        400,
        MCP_ERROR_HEADER_MISMATCH,
        "Required Mcp-Name header is missing."
      );
    }
    const decoded: any = decodeMcpHeaderValue(rawNameHeader);
    if (!decoded.ok) {
      return protocolError(
        message?.id,
        400,
        MCP_ERROR_HEADER_MISMATCH,
        "Mcp-Name header is malformed."
      );
    }
    const bodyName: any = typeof params[nameField] === "string" ? params[nameField] : params[nameField];
    if (decoded.value !== bodyName) {
      return protocolError(
        message?.id,
        400,
        MCP_ERROR_HEADER_MISMATCH,
        "Mcp-Name header does not match the request body name."
      );
    }
  }

  if (bodyVersion !== MCP_PROTOCOL_VERSION) {
    return mcpUnsupportedVersionError(message?.id, bodyVersion);
  }

  return {
    ok: true,
    protocolVersion: MCP_PROTOCOL_VERSION
  };
}

export function mcpCacheFields({
  ttlMs = 0,
  cacheScope = MCP_CACHE_SCOPE_PRIVATE
}: Record<string, any> = {}) : any {
  return Object.freeze({
    ttlMs: Number.isSafeInteger(ttlMs) && ttlMs >= 0 ? ttlMs : 0,
    cacheScope: cacheScope === MCP_CACHE_SCOPE_PUBLIC ? MCP_CACHE_SCOPE_PUBLIC : MCP_CACHE_SCOPE_PRIVATE
  });
}

export function mcpCompleteResult(fields: Record<string, any> = {}) : any {
  return {
    resultType: MCP_RESULT_TYPE_COMPLETE,
    ...fields
  };
}

export function mcpToolsListResult({
  tools = [],
  meta = {},
  nextCursor = undefined,
  ttlMs = MCP_TOOLS_LIST_CACHE_TTL_MS,
  cacheScope = MCP_CACHE_SCOPE_PRIVATE
}: Record<string, any> = {}) : any {
  const cache: any = mcpCacheFields({ ttlMs, cacheScope });
  return mcpCompleteResult({
    tools,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ttlMs: cache.ttlMs,
    cacheScope: cache.cacheScope,
    _meta: meta
  });
}

export function parseMcpSubscriptionNotifications(params: Record<string, any> = {}) : any {
  const notifications: any = params?.notifications;
  if (!isPlainObject(notifications)) {
    return {
      ok: false,
      error: "MCP subscription notifications must be an object of capability flags."
    };
  }
  const selected: any[] = [];
  const accepted: Record<string, any> = {};
  for (const [key, value] of Object.entries(notifications) as [string, any][]) {
    if (value !== true) {
      continue;
    }
    const method: any = MCP_NOTIFICATION_CAPABILITY_METHODS[key];
    if (!method) {
      continue;
    }
    accepted[key] = true;
    selected.push(method);
  }
  return {
    ok: true,
    methods: Object.freeze(selected),
    notifications: Object.freeze(accepted)
  };
}

export function mcpSubscriptionIdFromRequest(message?: any) : any {
  const requestId: any = message?.id;
  return typeof requestId === "number" || typeof requestId === "string" ? requestId : "";
}

export function mcpSubscriptionAckNotification({
  subscriptionId,
  notifications = {}
}: Record<string, any> = {}) : any {
  return jsonRpcNotification(MCP_SUBSCRIPTION_ACK_METHOD, {
    notifications,
    _meta: {
      [MCP_META_SUBSCRIPTION_ID]: subscriptionId
    }
  });
}

export function stampMcpSubscriptionMetadata(payload?: any, subscriptionId?: any) : any {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || subscriptionId === undefined || subscriptionId === "") {
    return payload;
  }
  const params: any = isPlainObject(payload.params) ? payload.params : {};
  const meta: any = isPlainObject(params._meta) ? { ...params._meta } : {};
  meta[MCP_META_SUBSCRIPTION_ID] = subscriptionId;
  return {
    ...payload,
    params: {
      ...params,
      _meta: meta
    }
  };
}

export function mcpInitializeCapabilities() : any {
  return {
    tools: {
      listChanged: true
    }
  };
}

export function isUnauthenticatedMcpMethod(method: any = "") : any {
  return method === "ping" || method === MCP_DISCOVER_METHOD;
}

export { KNOWN_NOTIFICATION_CAPABILITIES };
