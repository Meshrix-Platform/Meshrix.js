import { redactOperationAuditValue } from "@meshrix/foundation/security/operation-audit";
import { OPERATION_PERMISSION_API_PREFIX } from "./catalog.ts";

export function parseJsonBody(requestBody?: any) : any {
  if (!requestBody || requestBody.length === 0) {
    return {};
  }
  return JSON.parse(requestBody.toString("utf8"));
}

export function pathAfterPrefix(pathname?: any) : any {
  return String(pathname || "").slice(OPERATION_PERMISSION_API_PREFIX.length) || "/";
}

const EXTERNAL_CONTEXT_PROOF_KEYS: any = new Set<any>([
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

const SAFE_EXTERNAL_CONTEXT_KEYS: any = new Set<any>([
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

const PUBLIC_TELEMETRY_REDACTED_KEYS: any = new Set<any>([
  "agentId",
  "agentProfileId",
  "approvalId",
  "authorizedGrant",
  "boundUserId",
  "continuedPendingOperationId",
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
].map((key?: any) : any => key.toLowerCase()));

const PUBLIC_TELEMETRY_DIMENSION_KEYS: any = new Set<any>([
  "byAgent",
  "byGrant",
  "byProfile",
  "usageByGrant",
  "usageByProfile"
].map((key?: any) : any => key.toLowerCase()));

function publicTelemetryScalar(value?: any) : any {
  if (typeof value !== "string") {
    return redactOperationAuditValue(value);
  }
  return String(redactOperationAuditValue(value))
    .replace(/\b(?:grant|workspace)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-id]")
    .replace(/\b(?:delegated_mcp|tool_exec|pending_op)_[A-Za-z0-9_-]+\b/g, "[redacted-id]");
}

function publicTelemetryKey(value: any = "") : any {
  return String(value || "")
    .replace(/\b(?:grant|workspace)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-id]")
    .replace(/\b(?:delegated_mcp|tool_exec|pending_op)_[A-Za-z0-9_-]+\b/g, "[redacted-id]");
}

function normalizedTelemetryKey(value: any = "") : any {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isPublicPermissionRequestId(key: any = "", pathKeys: any = []) : any {
  if (normalizedTelemetryKey(key) !== "requestid") {
    return false;
  }
  return pathKeys.some((entry?: any) : any =>
    [
      "permissionrequest",
      "pendingpermissionrequests",
      "remainingpermissionrequests"
    ].includes(normalizedTelemetryKey(entry))
  );
}

function publicOperationPermissionValue(value?: any, key: any = "", depth: any = 0, pathKeys: any = []) : any {
  if (depth > 8) {
    return "[redacted-depth]";
  }
  const normalizedKey: any = String(key || "").toLowerCase();
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
    return value.map((item?: any) : any => publicOperationPermissionValue(item, "", depth + 1, pathKeys));
  }
  const output: Record<string, any> = {};
  for (const [childKey, childValue] of (Object.entries(value) as [string, any][])) {
    const publicKey: any = publicTelemetryKey(childKey);
    output[publicKey] = publicOperationPermissionValue(childValue, childKey, depth + 1, [...pathKeys, childKey]);
  }
  return output;
}

export function publicOperationPermissionResponse(value?: any) : any {
  return publicOperationPermissionValue(value);
}

export function publicPendingOperationListResponse(value?: any) : any {
  if (!Array.isArray(value)) {
    return publicOperationPermissionResponse(value);
  }
  return value.map((item?: any) : any => {
    const publicItem: any = publicOperationPermissionResponse(item);
    if (item && typeof item === "object" && !Array.isArray(item) && publicItem && typeof publicItem === "object") {
      const pendingOperationId: any = String(item.pendingOperationId || "").trim();
      if (pendingOperationId) {
        publicItem.pendingOperationId = pendingOperationId;
      }
    }
    return publicItem;
  });
}

export function plainObject(value: any = null) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeExternalContextScalar(value?: any) : any {
  if (typeof value === "string") {
    const text: any = value.trim();
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

export function sanitizeExternalToolContext(value: Record<string, any> = {}, serverContext: Record<string, any> = {}) : any {
  const sanitized: Record<string, any> = {};
  for (const [key, entry] of (Object.entries(plainObject(value)) as [string, any][])) {
    if (EXTERNAL_CONTEXT_PROOF_KEYS.has(key) || key.startsWith("__meshrix") || !SAFE_EXTERNAL_CONTEXT_KEYS.has(key)) {
      continue;
    }
    const scalar: any = sanitizeExternalContextScalar(entry);
    if (scalar !== undefined) {
      sanitized[key] = scalar;
    }
  }
  return {
    ...sanitized,
    ...serverContext
  };
}
