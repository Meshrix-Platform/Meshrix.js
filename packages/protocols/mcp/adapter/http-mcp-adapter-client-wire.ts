import { MCP_PROTOCOL_VERSION, MCP_SERVER_VERSION } from "./http-mcp-adapter-constants.ts";

export { MCP_PROTOCOL_VERSION, MCP_SERVER_VERSION };

export const MCP_DISCOVER_METHOD: any = "server/discover";
export const MCP_META_PROTOCOL_VERSION: any = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_CAPABILITIES: any = "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_CLIENT_INFO: any = "io.modelcontextprotocol/clientInfo";
export const MCP_META_SERVER_INFO: any = "io.modelcontextprotocol/serverInfo";

export const MCP_NAME_BEARING_METHODS: any = Object.freeze({
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name"
});

export const BASE64_SENTINEL_PREFIX: any = "=?base64?";
export const BASE64_SENTINEL_SUFFIX: any = "?=";

export function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function headerValueNeedsBase64(value?: any) : any {
  const text: any = String(value);
  if (text.startsWith(BASE64_SENTINEL_PREFIX) && text.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return true;
  }
  if (text !== text.trim()) {
    return true;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code: any = text.charCodeAt(index);
    if (code !== 0x09 && code !== 0x20 && (code < 0x21 || code > 0x7E)) {
      return true;
    }
  }
  return false;
}

export function encodeMcpHeaderValue(value?: any) : any {
  const text: any = String(value ?? "");
  if (!headerValueNeedsBase64(text)) {
    return text;
  }
  return `${BASE64_SENTINEL_PREFIX}${Buffer.from(text, "utf8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

export function mcpRequestMetadata(extra: Record<string, any> = {}) : any {
  return {
    [MCP_META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [MCP_META_CLIENT_CAPABILITIES]: isPlainObject(extra[MCP_META_CLIENT_CAPABILITIES])
      ? extra[MCP_META_CLIENT_CAPABILITIES]
      : {},
    [MCP_META_CLIENT_INFO]: isPlainObject(extra[MCP_META_CLIENT_INFO])
      ? extra[MCP_META_CLIENT_INFO]
      : {
          name: "meshrix-mcp-connector",
          version: MCP_SERVER_VERSION
        },
    ...extra
  };
}

export function mcpModernRequestHeaders(message?: any, extra: Record<string, any> = {}) : any {
  const method: any = String(message?.method || "");
  const params: any = isPlainObject(message?.params) ? message.params : {};
  const headers: Record<string, any> = {
    accept: "application/json, text/event-stream",
    "content-type": extra["content-type"] || extra["Content-Type"] || "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
    ...extra
  };
  const nameField: any = MCP_NAME_BEARING_METHODS[method];
  if (nameField && params[nameField] !== undefined && params[nameField] !== null) {
    headers["Mcp-Name"] = encodeMcpHeaderValue(params[nameField]);
  }
  return headers;
}

export function mcpModernJsonRpcMessage(message: Record<string, any> = {}, extraMeta: Record<string, any> = {}) : any {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  if (!message.method || String(message.method).startsWith("notifications/")) return message;
  const params: Record<string, any> = isPlainObject(message.params) ? { ...message.params } : {};
  const currentMeta: any = isPlainObject(params._meta) ? params._meta : {};
  params._meta = mcpRequestMetadata({ ...currentMeta, ...extraMeta });
  return { ...message, params };
}

export function mcpModernHttpRequest(message: Record<string, any> = {}, extraHeaders: Record<string, any> = {}) : any {
  const outgoing: any = mcpModernJsonRpcMessage(message);
  return {
    message: outgoing,
    body: JSON.stringify(outgoing),
    headers: mcpModernRequestHeaders(outgoing, extraHeaders)
  };
}
