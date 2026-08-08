import crypto from "node:crypto";
import {
  MCP_INTERFACE_VERSION,
  MCP_TOOLSET_VERSION
} from "./http-mcp-adapter-constants.ts";
import { mcpVersionInfo } from "./http-mcp-adapter-discovery.ts";
import {
  jsonRpcError,
  publicMcpEnvelopeValue
} from "./http-mcp-adapter-response.ts";
import {
  grantMetadata,
  localMcpGrantTargets,
  mcpSubjectFromAuthorization,
  normalizeGrantValues
} from "./http-mcp-adapter-session.ts";

function normalizedLocalHost(value?: any) : any {
  const host: any = String(value || "").trim().toLowerCase();
  return host === "::1" || host === "[::1]" ? "localhost" : host.split(":")[0];
}

export function isAllowedOrigin(request?: any) : any {
  const origin: any = String(request?.headers?.origin || "").trim();
  if (!origin) {
    return true;
  }
  try {
    const parsed: any = new URL(origin);
    const host: any = normalizedLocalHost(parsed.hostname);
    return new Set<any>(["localhost", "127.0.0.1", "host.orb.internal"]).has(host);
  } catch {
    return false;
  }
}

export function hasMcpAuthToken(request: any = null) : any {
  const authorization: any = String(request?.headers?.authorization || "").trim();
  return Boolean(
    /^Bearer\s+.+/i.test(authorization) ||
      String(request?.headers?.["x-meshrix-tool-token"] || "").trim() ||
      String(request?.headers?.["x-meshrix-api-key"] || "").trim()
  );
}

function randomMcpId(prefix?: any) : any {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function normalizeMcpSubject(value?: any, authorization?: any) : any {
  const authenticatedSubject: any = mcpSubjectFromAuthorization(authorization);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      ...authenticatedSubject,
      declaredSubject: publicMcpEnvelopeValue(value)
    };
  }
  return authenticatedSubject;
}

function requestTraceIdFromAuthorization(authorization: any = null) : any {
  return String(authorization?.traceId || authorization?.authorizationDecision?.traceId || "").trim();
}

export function normalizeMcpOperationEnvelope(input?: any, authorization?: any) : any {
  const payload: any = input && typeof input === "object" ? input : {};
  const apiVersion: any = String(payload.apiVersion || MCP_INTERFACE_VERSION).trim();
  if (apiVersion !== MCP_INTERFACE_VERSION) {
    return {
      ok: false,
      error: jsonRpcError(null, -32602, `Unsupported Meshrix.js MCP apiVersion: ${apiVersion}`, {
        expectedApiVersion: MCP_INTERFACE_VERSION,
        toolsetVersion: MCP_TOOLSET_VERSION,
        upgrade: mcpVersionInfo()
      })
    };
  }
  const operation: any = String(payload.operation || "").trim();
  if (!operation) {
    return {
      ok: false,
      error: jsonRpcError(null, -32602, "Meshrix.js MCP outlet calls require arguments.operation.", {
        expectedApiVersion: MCP_INTERFACE_VERSION
      })
    };
  }
  const grant: any = authorization?.grant || null;
  const metadata: any = grantMetadata(grant);
  const authenticatedSubject: any = mcpSubjectFromAuthorization(authorization);
  const apiKeyWorkload: any = authorization?.credentialKind === "scoped_api_key";
  const operationInput: any = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input
    : {};
  const workspaceId: any = String(
    payload.workspaceId ||
      operationInput.workspaceId ||
      operationInput.workspaceRef ||
      operationInput["workspace-ref"] ||
      ""
  ).trim();
  const agentProfileId: any = String(
    apiKeyWorkload
      ? ""
      : payload.agentProfileId ||
        payload.agent_profile_id ||
        metadata.agentProfileId ||
        metadata.agentProfile ||
        ""
  ).trim();
  const targets: any = localMcpGrantTargets(grant);
  const operatorId: any = String(
    apiKeyWorkload
      ? authenticatedSubject.subjectId
      : payload.operatorId ||
        payload.operator_id ||
        metadata.operatorId ||
        metadata.operator ||
        targets[0] ||
        authenticatedSubject.subjectId ||
        "mcp-agent"
  ).trim();
  const traceId: any = String(payload.traceId || payload.trace_id || requestTraceIdFromAuthorization(authorization) || randomMcpId("mcp_trace")).trim();
  const idempotencyKey: any = String(payload.idempotencyKey || payload.idempotency_key || randomMcpId("mcp_intent")).trim();
  const envelope: Record<string, any> = {
    apiVersion,
    operation,
    intent: String(payload.intent || operation).trim(),
    input: operationInput,
    subject: normalizeMcpSubject(payload.subject, authorization),
    operatorId,
    agentProfileId,
    workspaceId,
    traceId,
    idempotencyKey,
    dryRun: payload.dryRun === true,
    requestedScopes: normalizeGrantValues(payload.requestedScopes || payload.requested_scopes || [], 128),
    clientVersion: String(payload.clientVersion || "").trim()
  };
  return {
    ok: true,
    operation,
    input: operationInput,
    envelope
  };
}
