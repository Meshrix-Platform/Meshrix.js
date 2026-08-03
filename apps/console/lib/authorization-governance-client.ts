import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

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

const authorizationGovernanceEndpoints: any = {
  role: "/api/authorization/roles",
  department: "/api/authorization/departments",
  team: "/api/authorization/teams",
  userPolicy: "/api/authorization/users/policy",
  agentGroup: "/api/authorization/agent-groups",
  agentBinding: "/api/authorization/agents/binding",
  approval: "/api/authorization/approvals",
} as const satisfies Record<AuthorizationGovernanceKind, string>;

export function getAuthorizationGovernance() : any {
  return getJson<AuthorizationGovernanceResponse>("/api/authorization/governance");
}

export function upsertAuthorizationGovernance(
  kind: AuthorizationGovernanceKind,
  payload: Record<string, unknown>,
) : any {
  return postJson<Record<string, unknown>>(authorizationGovernanceEndpoints[kind], payload, {
    safetyConfirm: true,
  });
}

export function revokeAuthorizationApproval(approvalId: string, reason: any = "") : any {
  return postJson<Record<string, unknown>>(
    `/api/authorization/approvals/${encodeURIComponent(approvalId)}/revoke`,
    { reason },
    { safetyConfirm: true },
  );
}
