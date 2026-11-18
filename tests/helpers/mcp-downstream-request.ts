import {
  mcpModernHttpRequest,
  mcpModernJsonRpcMessage,
  mcpModernRequestHeaders,
  mcpRequestMetadata
} from "../../packages/protocols/mcp/adapter/http-mcp-adapter-client-wire.ts";

export {
  mcpModernHttpRequest,
  mcpModernJsonRpcMessage,
  mcpModernRequestHeaders,
  mcpRequestMetadata
};

export function mcpModernMetadata(extra: Record<string, any> = {}) : any {
  return mcpRequestMetadata(extra);
}

export function mcpModernParams(params: Record<string, any> = {}, extraMeta: Record<string, any> = {}) : any {
  const next: Record<string, any> = { ...params };
  const currentMeta: any = next._meta && typeof next._meta === "object" && !Array.isArray(next._meta)
    ? next._meta
    : {};
  next._meta = mcpRequestMetadata({ ...currentMeta, ...extraMeta });
  return next;
}

export function mcpModernBody(body: Record<string, any> = {}, extraMeta: Record<string, any> = {}) : any {
  return mcpModernJsonRpcMessage(body, extraMeta);
}

export function mcpModernHeaders(body: Record<string, any> = {}, extra: Record<string, any> = {}) : any {
  return mcpModernRequestHeaders(body, extra);
}

function safePublicToolSegment(value: any = "") : any {
  return String(value || "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "service";
}

export function publicMcpToolCapabilityId(publicName: any = "") : any {
  const raw: any = String(publicName || "").trim();
  if (!raw.startsWith("upstream.")) return "";
  const rest: any = raw.slice("upstream.".length);
  const dot: any = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return "";
  return `cap:upstream:${safePublicToolSegment(rest.slice(0, dot))}:tools-call-${safePublicToolSegment(rest.slice(dot + 1))}`;
}

export function executionSubject(overrides: Record<string, any> = {}) : any {
  const publicToolNames: any[] = [
    ...(Array.isArray(overrides.publicToolNames) ? overrides.publicToolNames : []),
    ...(overrides.publicToolName ? [overrides.publicToolName] : [])
  ];
  const derivedCapabilities: any[] = publicToolNames
    .map((name?: any) : any => publicMcpToolCapabilityId(name))
    .filter(Boolean);
  const {
    publicToolName: _publicToolName,
    publicToolNames: _publicToolNames,
    grant: grantOverride,
    ...rest
  } = overrides;
  const dynamicCapabilities: any = Array.isArray(rest.dynamicCapabilities)
    ? rest.dynamicCapabilities
    : derivedCapabilities;
  const grant: Record<string, any> = {
    id: "grant-1",
    subjectId: "subject-1",
    ...(dynamicCapabilities.length > 0 ? { dynamicCapabilities } : {}),
    ...(grantOverride && typeof grantOverride === "object" ? grantOverride : {})
  };
  return {
    type: "tool-grant",
    subjectId: "subject-1",
    grantId: "grant-1",
    grant,
    scopes: ["gateway:read", "gateway:write"],
    ...(dynamicCapabilities.length > 0 ? { dynamicCapabilities } : {}),
    ...rest,
    grant
  };
}
