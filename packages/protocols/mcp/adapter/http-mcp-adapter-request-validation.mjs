import crypto from "node:crypto";
import {
  MCP_INTERFACE_VERSION,
  MCP_TOOLSET_VERSION
} from "./http-mcp-adapter-constants.mjs";
import { mcpVersionInfo } from "./http-mcp-adapter-discovery.mjs";
import {
  jsonRpcError,
  publicMcpEnvelopeValue
} from "./http-mcp-adapter-response.mjs";
import {
  grantMetadata,
  localMcpGrantTargets,
  mcpSubjectFromGrant,
  normalizeGrantValues
} from "./http-mcp-adapter-session.mjs";

function normalizedLocalHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return host === "::1" || host === "[::1]" ? "localhost" : host.split(":")[0];
}

export function isAllowedOrigin(request) {
  const origin = String(request?.headers?.origin || "").trim();
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    const host = normalizedLocalHost(parsed.hostname);
    return new Set(["localhost", "127.0.0.1", "host.orb.internal"]).has(host);
  } catch {
    return false;
  }
}

export function hasMcpAuthToken(request = null) {
  const authorization = String(request?.headers?.authorization || "").trim();
  return Boolean(
    /^Bearer\s+.+/i.test(authorization) ||
      String(request?.headers?.["x-lico-tool-token"] || "").trim() ||
      String(request?.headers?.["x-licomesh-api-key"] || "").trim()
  );
}

function randomMcpId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function normalizeMcpSubject(value, authorization) {
  const authenticatedSubject = mcpSubjectFromGrant(authorization?.grant || null);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      ...authenticatedSubject,
      declaredSubject: publicMcpEnvelopeValue(value)
    };
  }
  return authenticatedSubject;
}

function requestTraceIdFromAuthorization(authorization = null) {
  return String(authorization?.traceId || authorization?.authorizationDecision?.traceId || "").trim();
}

export function normalizeMcpOperationEnvelope(input, authorization) {
  const payload = input && typeof input === "object" ? input : {};
  const apiVersion = String(payload.apiVersion || MCP_INTERFACE_VERSION).trim();
  if (apiVersion !== MCP_INTERFACE_VERSION) {
    return {
      ok: false,
      error: jsonRpcError(null, -32602, `Unsupported LicoMesh MCP apiVersion: ${apiVersion}`, {
        expectedApiVersion: MCP_INTERFACE_VERSION,
        toolsetVersion: MCP_TOOLSET_VERSION,
        upgrade: mcpVersionInfo()
      })
    };
  }
  const operation = String(payload.operation || "").trim();
  if (!operation) {
    return {
      ok: false,
      error: jsonRpcError(null, -32602, "LicoMesh MCP outlet calls require arguments.operation.", {
        expectedApiVersion: MCP_INTERFACE_VERSION
      })
    };
  }
  const grant = authorization?.grant || null;
  const metadata = grantMetadata(grant);
  const operationInput = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input
    : {};
  const workspaceId = String(
    payload.workspaceId ||
      operationInput.workspaceId ||
      operationInput.workspaceRef ||
      operationInput["workspace-ref"] ||
      ""
  ).trim();
  const agentProfileId = String(
    payload.agentProfileId ||
      payload.agent_profile_id ||
      metadata.agentProfileId ||
      metadata.agentProfile ||
      ""
  ).trim();
  const targets = localMcpGrantTargets(grant);
  const operatorId = String(
    payload.operatorId ||
      payload.operator_id ||
      metadata.operatorId ||
      metadata.operator ||
      targets[0] ||
      grant?.id ||
      "mcp-agent"
  ).trim();
  const traceId = String(payload.traceId || payload.trace_id || requestTraceIdFromAuthorization(authorization) || randomMcpId("mcp_trace")).trim();
  const idempotencyKey = String(payload.idempotencyKey || payload.idempotency_key || randomMcpId("mcp_intent")).trim();
  const envelope = {
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
