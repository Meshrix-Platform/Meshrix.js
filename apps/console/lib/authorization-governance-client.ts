import { getJson, postJson } from "@lico/ui-console/bridge-http";

export type AuthorizationGovernanceKind =
  | "role"
  | "department"
  | "team"
  | "userPolicy"
  | "agentGroup"
  | "agentBinding"
  | "approval";

export type AuthorizationGovernanceResponse = {
  governance: Record<string, unknown>;
};

export type McpAuthorizationRequest = {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "expired" | "issuing" | "consumed" | "failed";
  requestKind?: "generic" | "local_mcp_install";
  clientName?: string;
  reason?: string;
  requestedScopes?: string[];
  requestedTools?: string[];
  targets?: string[];
  toolsets?: string[];
  maxRisk?: string;
  verificationCode?: string;
  processKeyFingerprints?: Array<{ target: string; fingerprint: string }>;
  expiresAt?: string;
} & Record<string, unknown>;

export type ResolveMcpAuthorizationRequestPayload = {
  resolution: "approved" | "rejected";
  clientName?: string;
  scopes?: string[];
  toolsets?: string[];
  toolAllow?: string[];
};

const authorizationGovernanceEndpoints = {
  role: "/api/authorization/roles",
  department: "/api/authorization/departments",
  team: "/api/authorization/teams",
  userPolicy: "/api/authorization/users/policy",
  agentGroup: "/api/authorization/agent-groups",
  agentBinding: "/api/authorization/agents/binding",
  approval: "/api/authorization/approvals",
} as const satisfies Record<AuthorizationGovernanceKind, string>;

export function getAuthorizationGovernance() {
  return getJson<AuthorizationGovernanceResponse>("/api/authorization/governance");
}

export function upsertAuthorizationGovernance(
  kind: AuthorizationGovernanceKind,
  payload: Record<string, unknown>,
) {
  return postJson<Record<string, unknown>>(authorizationGovernanceEndpoints[kind], payload, {
    safetyConfirm: true,
  });
}

export function revokeAuthorizationApproval(approvalId: string, reason = "") {
  return postJson<Record<string, unknown>>(
    `/api/authorization/approvals/${encodeURIComponent(approvalId)}/revoke`,
    { reason },
    { safetyConfirm: true },
  );
}

export function listMcpAuthorizationRequests(status = "pending") {
  return getJson<{ requests: McpAuthorizationRequest[] }>(
    `/api/console/mcp/authorization/requests?status=${encodeURIComponent(status)}`,
  );
}

export function resolveMcpAuthorizationRequest(
  requestId: string,
  payload: ResolveMcpAuthorizationRequestPayload,
) {
  return postJson<{ ok: boolean; grantId?: string }>(
    `/api/console/mcp/authorization/requests/${encodeURIComponent(requestId)}/resolve`,
    payload,
    { safetyConfirm: true },
  );
}
