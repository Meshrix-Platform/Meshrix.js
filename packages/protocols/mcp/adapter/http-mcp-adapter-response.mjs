import { MCP_INTERFACE_VERSION } from "./http-mcp-adapter-constants.mjs";

export function jsonRpcResult(id, result = {}) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

export function jsonRpcError(id, code, message, data = {}) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message: publicMcpEnvelopeString(message),
      data: publicMcpEnvelopeValue(data)
    }
  };
}

export function jsonRpcNotification(method, params = {}) {
  return {
    jsonrpc: "2.0",
    method,
    params
  };
}

export function parseRequestBody(requestBody) {
  if (!requestBody || requestBody.length === 0) {
    return {};
  }
  return JSON.parse(requestBody.toString("utf8"));
}

export function executeToolPayload(result = {}) {
  return result.payload?.result !== undefined ? result.payload.result : result.payload;
}

export function mcpToolResult(payload) {
  const structuredContent = payload?.result !== undefined ? payload.result : payload;
  return {
    content: payload?.content || [
      {
        type: "text",
        text: JSON.stringify(structuredContent ?? {}, null, 2)
      }
    ],
    structuredContent
  };
}

function isInternalMcpAbsolutePath(value) {
  const text = String(value || "");
  return (
    /^\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\//.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

export function publicMcpWorkspaceToken(workspaceDirectory = null, workspaceId = "") {
  const entry = workspaceDirectory?.byId?.get?.(String(workspaceId || ""));
  return entry?.ref || "workspace-hidden";
}

export function publicMcpEnvelopeString(value, workspaceDirectory = null) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  if (isInternalMcpAbsolutePath(text)) {
    return "[server-internal-path]";
  }
  return text
    .replace(/\bworkspace_[A-Za-z0-9_]+\b/g, (workspaceId) => publicMcpWorkspaceToken(workspaceDirectory, workspaceId))
    .replace(/\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b/gi, "grant-hidden")
    .replace(/(^|[\s"'=:(])((?:\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\/)[^\s"',)\]}]+)/g, "$1[server-internal-path]")
    .replace(/(^|[\s"'=:(])([A-Za-z]:[\\/][^\s"',)\]}]+)/g, "$1[server-internal-path]")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(X-Meshrix-Api-Key\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(x-meshrix-tool-token\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/(^|[\s"'=:(])(--token(?:=|\s+))[^\s"',;)\]}]+/gi, "$1$2<redacted-token>")
    .replace(/\b(token|access_token|refresh_token|api_key|apiKey|secret|password)=([^\s"',;)\]}]+)/gi, "$1=<redacted-secret>");
}

export function publicMcpEnvelopeValue(value, workspaceDirectory = null, depth = 0) {
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => publicMcpEnvelopeValue(item, workspaceDirectory, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? publicMcpEnvelopeString(value, workspaceDirectory) : value;
  }
  if (depth > 5) {
    return { type: "object", keys: Object.keys(value).slice(0, 40).map((key) => publicMcpEnvelopeString(key, workspaceDirectory)) };
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isSensitiveMcpEnvelopeKey(key))
    .map(([key, child]) => [
      publicMcpEnvelopeString(key, workspaceDirectory),
      publicMcpEnvelopeValue(child, workspaceDirectory, depth + 1)
    ]));
}

function isSensitiveMcpEnvelopeKey(key = "") {
  const normalized = String(key || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized === "secretref" || normalized === "endpointref") {
    return false;
  }
  return [
    "authorization",
    "bearertoken",
    "cookie",
    "setcookie",
    "token",
    "tokenprefix",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "apikey",
    "xlicoapikey",
    "xmeshrixapikey",
    "xlicotooltoken",
    "secret",
    "clientsecret",
    "password",
    "privatekey",
    "privatekeyjwk"
  ].includes(normalized);
}

export function mcpEnvelopePublic(envelope = {}, workspaceDirectory = null) {
  return {
    apiVersion: envelope.apiVersion || MCP_INTERFACE_VERSION,
    operation: envelope.operation || "",
    intent: publicMcpEnvelopeString(envelope.intent || envelope.operation || "", workspaceDirectory),
    traceId: publicMcpEnvelopeString(envelope.traceId || "", workspaceDirectory),
    idempotencyKey: publicMcpEnvelopeString(envelope.idempotencyKey || "", workspaceDirectory),
    operatorId: publicMcpEnvelopeString(envelope.operatorId || "", workspaceDirectory),
    agentProfileId: publicMcpEnvelopeString(envelope.agentProfileId || "", workspaceDirectory),
    workspaceId: publicMcpEnvelopeString(envelope.workspaceId || "", workspaceDirectory),
    requestedScopes: publicMcpEnvelopeValue(envelope.requestedScopes || [], workspaceDirectory),
    dryRun: envelope.dryRun === true,
    subject: publicMcpEnvelopeValue(envelope.subject || {}, workspaceDirectory)
  };
}
