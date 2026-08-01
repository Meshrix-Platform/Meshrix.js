import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  OperationPermissionAuditResponse,
  OperationPermissionCatalog,
  OperationPermissionGrant,
  OperationPermissionGrantIssue,
  OperationPermissionGrantsResponse,
  OperationPermissionMetricsResponse,
  OperationPermissionPendingOperationsResponse,
} from "./types";

export type {
  OperationPermissionAuditItem,
  OperationPermissionAuditResponse,
  OperationPermissionCatalog,
  OperationPermissionGrant,
  OperationPermissionGrantIssue,
  OperationPermissionGrantsResponse,
  OperationPermissionMetrics,
  OperationPermissionMetricsResponse,
  OperationPermissionPendingOperation,
  OperationPermissionPendingOperationsResponse,
  OperationPermissionProfile,
  OperationPermissionScope,
  OperationPermissionTool,
  OperationPermissionToolGroup,
  OperationPermissionToolset,
} from "./types";

export type CreateToolGrantPayload = {
  label: string;
  scopes?: string[];
  toolsets?: string[];
};

export type UpdateToolGrantPayload = Partial<
  Pick<
    OperationPermissionGrant,
    "enabled" | "label" | "scopes" | "toolAllow" | "toolDeny" | "toolsets"
  >
>;

export function getOperationPermissionCatalog() : any {
  return getJson<OperationPermissionCatalog>("/api/operation-permission/v1/catalog");
}

export function getOperationPermissionAudit(limit: any = 50) : any {
  return getJson<OperationPermissionAuditResponse>(
    `/api/operation-permission/v1/audit?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function getOperationPermissionMetrics() : any {
  return getJson<OperationPermissionMetricsResponse>("/api/operation-permission/v1/metrics/summary");
}

export function getOperationPermissionMetricsHealth() : any {
  return getJson<Record<string, unknown>>("/api/operation-permission/v1/metrics/health");
}

export function exportOperationPermissionMetrics() : any {
  return getJson<Record<string, unknown>>("/api/operation-permission/v1/metrics/export");
}

export function previewToolPolicy(payload: Record<string, unknown>) : any {
  return postJson<Record<string, unknown>>("/api/operation-permission/v1/policy/preview", payload);
}

export function getOperationPermissionGrants() : any {
  return getJson<OperationPermissionGrantsResponse>("/api/operation-permission/v1/grants");
}

export function createToolGrant(payload: CreateToolGrantPayload) : any {
  return postJson<OperationPermissionGrantIssue>("/api/operation-permission/v1/grants", payload, {
    safetyConfirm: true,
  });
}

export function updateToolGrant(grantId: string, payload: UpdateToolGrantPayload) : any {
  return postJson<{ grant: OperationPermissionGrant }>(
    `/api/operation-permission/v1/grants/${encodeURIComponent(grantId)}`,
    payload,
    { safetyConfirm: true },
  );
}

export function deleteToolGrant(grantId: string) : any {
  return postJson<{ grant: OperationPermissionGrant }>(
    `/api/operation-permission/v1/grants/${encodeURIComponent(grantId)}/revoke`,
    { reason: "revoked_from_console" },
    { safetyConfirm: true },
  );
}

export function rotateToolGrantToken(grantId: string) : any {
  return postJson<OperationPermissionGrantIssue>(
    `/api/operation-permission/v1/grants/${encodeURIComponent(grantId)}/rotate`,
    {},
    { safetyConfirm: true },
  );
}

export function listPendingOperations(status: any = "pending", limit: any = 100) : any {
  return getJson<OperationPermissionPendingOperationsResponse>(
    `/api/operation-permission/v1/pending-operations?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(String(limit))}`,
  );
}

export function resolvePendingOperation(
  pendingOperationId: string,
  payload: Record<string, unknown>,
) : any {
  return postJson<Record<string, unknown>>(
    `/api/operation-permission/v1/pending-operations/${encodeURIComponent(pendingOperationId)}/resolve`,
    payload,
    { safetyConfirm: true },
  );
}
