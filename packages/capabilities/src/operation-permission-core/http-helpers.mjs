import { redactOperationAuditValue } from "@lico/foundation/security/operation-audit";
import { OPERATION_PERMISSION_API_PREFIX } from "./catalog.mjs";

export function parseJsonBody(requestBody) {
  if (!requestBody || requestBody.length === 0) {
    return {};
  }
  return JSON.parse(requestBody.toString("utf8"));
}

export function pathAfterPrefix(pathname) {
  return String(pathname || "").slice(OPERATION_PERMISSION_API_PREFIX.length) || "/";
}

const EXTERNAL_CONTEXT_PROOF_KEYS = new Set([
  "approval",
  "pendingOperationApproved",
  "approvedPendingOperation",
  "authorizedGrant",
  "authorization",
  "authorizationDecision",
  "policy",
  "policyDecision",
  "policyDecisionId",
  "grant",
  "grantId",
  "transport",
  "requirePendingOperation",
  "pendingApprovalRequired",
  "approvalExpiresAt",
  "expiresAt",
  "delegatedChildOperation",
  "grantBindingVerified",
  "missingRequestBindings",
  "requestBindingMismatches",
  "delegatedMcpGrantId",
  "delegatedSessionId",
  "delegatedTurnId",
  "delegatedSubjectId",
  "delegatedTargetId",
  "delegatedWorkspaceId",
  "delegatedParentOperationId",
  "delegatedTraceId",
  "parentOperationId",
  "sourceIp",
  "userAgent",
  "toolExecutionId"
]);

const SAFE_EXTERNAL_CONTEXT_KEYS = new Set([
  "source",
  "correlationId",
  "requestId",
  "idempotencyKey",
  "agentId",
  "agentProfileId",
  "profileId",
  "userId",
  "boundUserId",
  "subjectId",
  "clientId",
  "clientName",
  "namespace",
  "bindingNamespace",
  "batch",
  "call"
]);

const PUBLIC_TELEMETRY_REDACTED_KEYS = new Set([
  "agentId",
  "agentProfileId",
  "approvalId",
  "authorizedGrant",
  "boundUserId",
  "context",
  "grant",
  "grantId",
  "idempotencyKey",
  "policyDecisionId",
  "profileId",
  "redactedInput",
  "delegatedChildOperation",
  "delegatedMcpGrantId",
  "delegatedSessionId",
  "delegatedTurnId",
  "delegatedSubjectId",
  "delegatedTargetId",
  "delegatedWorkspaceId",
  "delegatedParentOperationId",
  "delegatedTraceId",
  "requestId",
  "resolvedBy",
  "resumedToolExecutionId",
  "sourceIp",
  "subjectId",
  "traceId",
  "toolExecutionId",
  "userAgent",
  "virtualAgentId",
  "workspaceId"
].map((key) => key.toLowerCase()));

const PUBLIC_TELEMETRY_DIMENSION_KEYS = new Set([
  "byAgent",
  "byGrant",
  "byProfile",
  "usageByGrant",
  "usageByProfile"
].map((key) => key.toLowerCase()));

function publicTelemetryScalar(value) {
  if (typeof value !== "string") {
    return redactOperationAuditValue(value);
  }
  return String(redactOperationAuditValue(value))
    .replace(/\b(?:grant|workspace)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-id]")
    .replace(/\b(?:delegated_mcp|tool_exec|pending_op)_[A-Za-z0-9_-]+\b/g, "[redacted-id]");
}

function publicTelemetryKey(value = "") {
  return String(value || "")
    .replace(/\b(?:grant|workspace)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-id]")
    .replace(/\b(?:delegated_mcp|tool_exec|pending_op)_[A-Za-z0-9_-]+\b/g, "[redacted-id]");
}

function normalizedTelemetryKey(value = "") {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isPublicPermissionRequestId(key = "", pathKeys = []) {
  if (normalizedTelemetryKey(key) !== "requestid") {
    return false;
  }
  return pathKeys.some((entry) =>
    [
      "permissionrequest",
      "pendingpermissionrequests",
      "remainingpermissionrequests"
    ].includes(normalizedTelemetryKey(entry))
  );
}

function publicOperationPermissionValue(value, key = "", depth = 0, pathKeys = []) {
  if (depth > 8) {
    return "[redacted-depth]";
  }
  const normalizedKey = String(key || "").toLowerCase();
  if (
    (PUBLIC_TELEMETRY_REDACTED_KEYS.has(normalizedKey) && !isPublicPermissionRequestId(key, pathKeys)) ||
    /workspaceids?$/.test(normalizedKey)
  ) {
    return "[redacted]";
  }
  if (PUBLIC_TELEMETRY_DIMENSION_KEYS.has(normalizedKey)) {
    return {
      redacted: true,
      dimension: key
    };
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return publicTelemetryScalar(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => publicOperationPermissionValue(item, "", depth + 1, pathKeys));
  }
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const publicKey = publicTelemetryKey(childKey);
    output[publicKey] = publicOperationPermissionValue(childValue, childKey, depth + 1, [...pathKeys, childKey]);
  }
  return output;
}

export function publicOperationPermissionResponse(value) {
  return publicOperationPermissionValue(value);
}

export function publicPendingOperationListResponse(value) {
  if (!Array.isArray(value)) {
    return publicOperationPermissionResponse(value);
  }
  return value.map((item) => {
    const publicItem = publicOperationPermissionResponse(item);
    if (item && typeof item === "object" && !Array.isArray(item) && publicItem && typeof publicItem === "object") {
      const pendingOperationId = String(item.pendingOperationId || "").trim();
      if (pendingOperationId) {
        publicItem.pendingOperationId = pendingOperationId;
      }
    }
    return publicItem;
  });
}

export function plainObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeExternalContextScalar(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 256 ? text.slice(0, 256) : text;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

export function sanitizeExternalToolContext(value = {}, serverContext = {}) {
  const sanitized = {};
  for (const [key, entry] of Object.entries(plainObject(value))) {
    if (EXTERNAL_CONTEXT_PROOF_KEYS.has(key) || key.startsWith("__lico") || !SAFE_EXTERNAL_CONTEXT_KEYS.has(key)) {
      continue;
    }
    const scalar = sanitizeExternalContextScalar(entry);
    if (scalar !== undefined) {
      sanitized[key] = scalar;
    }
  }
  return {
    ...sanitized,
    ...serverContext
  };
}
