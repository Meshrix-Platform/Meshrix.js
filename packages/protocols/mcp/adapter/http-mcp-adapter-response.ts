import { MCP_INTERFACE_VERSION } from "./http-mcp-adapter-constants.ts";

export function jsonRpcResult(id?: any, result: Record<string, any> = {}) : any {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

export function jsonRpcError(id?: any, code?: any, message?: any, data: Record<string, any> = {}) : any {
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

export function jsonRpcNotification(method?: any, params: Record<string, any> = {}) : any {
  return {
    jsonrpc: "2.0",
    method,
    params
  };
}

export function parseRequestBody(requestBody?: any) : any {
  if (!requestBody || requestBody.length === 0) {
    return {};
  }
  return JSON.parse(requestBody.toString("utf8"));
}

export function executeToolPayload(result: Record<string, any> = {}) : any {
  return result.payload?.result !== undefined ? result.payload.result : result.payload;
}

export function mcpToolResult(payload?: any) : any {
  const structuredContent: any = payload?.result !== undefined ? payload.result : payload;
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

function isInternalMcpAbsolutePath(value?: any) : any {
  const text: any = String(value || "");
  return (
    /^\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\//.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

export function publicMcpWorkspaceToken(workspaceDirectory: any = null, workspaceId: any = "") : any {
  const entry: any = workspaceDirectory?.byId?.get?.(String(workspaceId || ""));
  return entry?.ref || "workspace-hidden";
}

export function publicMcpEnvelopeString(value?: any, workspaceDirectory: any = null) : any {
  const text: any = String(value || "");
  if (!text) {
    return "";
  }
  if (isInternalMcpAbsolutePath(text)) {
    return "[server-internal-path]";
  }
  return text
    .replace(/\bworkspace_[A-Za-z0-9_]+\b/g, (workspaceId?: any) : any => publicMcpWorkspaceToken(workspaceDirectory, workspaceId))
    .replace(/\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b/gi, "grant-hidden")
    .replace(/(^|[\s"'=:(])((?:\/(?:Users|home|root|private|var|tmp|opt|usr|Volumes)\/)[^\s"',)\]}]+)/g, "$1[server-internal-path]")
    .replace(/(^|[\s"'=:(])([A-Za-z]:[\\/][^\s"',)\]}]+)/g, "$1[server-internal-path]")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(X-Meshrix.js-Api-Key\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/\b(x-meshrix-tool-token\s*:\s*)[^\s"',;)\]}]+/gi, "$1<redacted-token>")
    .replace(/(^|[\s"'=:(])(--token(?:=|\s+))[^\s"',;)\]}]+/gi, "$1$2<redacted-token>")
    .replace(/\b(token|access_token|refresh_token|api_key|apiKey|secret|password)=([^\s"',;)\]}]+)/gi, "$1=<redacted-secret>");
}

export function publicMcpEnvelopeValue(value?: any, workspaceDirectory: any = null, depth: any = 0) : any {
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item?: any) : any => publicMcpEnvelopeValue(item, workspaceDirectory, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? publicMcpEnvelopeString(value, workspaceDirectory) : value;
  }
  if (depth > 5) {
    return { type: "object", keys: Object.keys(value).slice(0, 40).map((key?: any) : any => publicMcpEnvelopeString(key, workspaceDirectory)) };
  }
  return Object.fromEntries((Object.entries(value) as [string, any][])
    .filter(([key]: any[]) : any => !isSensitiveMcpEnvelopeKey(key))
    .map(([key, child]: any[]) : any => [
      publicMcpEnvelopeString(key, workspaceDirectory),
      publicMcpEnvelopeValue(child, workspaceDirectory, depth + 1)
    ]));
}

function isSensitiveMcpEnvelopeKey(key: any = "") : any {
  const normalized: any = String(key || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (normalized === "secretref" || normalized === "endpointref") {
    return false;
  }
  if (normalized.endsWith("apikey") || normalized.endsWith("tooltoken")) {
    return true;
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
    "secret",
    "clientsecret",
    "password",
    "privatekey",
    "privatekeyjwk"
  ].includes(normalized);
}

export function mcpEnvelopePublic(envelope: Record<string, any> = {}, workspaceDirectory: any = null) : any {
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
