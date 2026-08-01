import { describe, expect, it, vi } from "vitest";

import { createSecurityPermissionsProvider } from "../../../packages/foundation/src/security/security-permissions-provider.ts";

describe("security permissions provider behavior", () : any => {
  it("formats authorization denial messages for capabilities, scopes, and reason codes", async () : Promise<any> => {
    const authSession: Record<string, any> = { user: { userId: "user-a" } };
    const engine: Record<string, any> = {
      evaluate: vi.fn()
        .mockReturnValueOnce({
          allowed: false,
          missingCapabilities: ["cap.alpha", "cap.beta"]
        })
        .mockReturnValueOnce({
          allowed: false,
          missingScopes: ["scope.alpha"]
        })
        .mockReturnValueOnce({
          allowed: false,
          reasonCode: "custom_denied"
        })
        .mockReturnValueOnce({
          allowed: true,
          grantId: "grant-a"
        })
    };
    const provider: any = createSecurityPermissionsProvider({ authorizationEngine: engine });

    await expect(provider.authorizeOperation({
      operation: { id: "capability.denied" },
      authSession,
      method: "GET",
      url: new URL("http://unit.test/api/capability")
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "权限不足：cap.alpha, cap.beta。",
      session: authSession
    });
    await expect(provider.authorizeOperation({
      operation: { id: "scope.denied" },
      authSession,
      method: "POST",
      url: new URL("http://unit.test/api/scope")
    })).resolves.toMatchObject({
      ok: false,
      error: "权限不足：scope.alpha。"
    });
    await expect(provider.authorizeOperation({
      operation: { id: "reason.denied" }
    })).resolves.toMatchObject({
      ok: false,
      error: "权限不足：custom_denied。"
    });
    await expect(provider.authorizeOperation({
      operation: { id: "allowed" },
      authSession
    })).resolves.toMatchObject({
      ok: true,
      session: authSession,
      authorizationDecision: {
        allowed: true,
        grantId: "grant-a"
      }
    });

    expect(engine.evaluate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      input: { method: "GET", path: "/api/capability" },
      context: { transport: "security-permissions-provider" },
      enforceConfirmation: false
    }));
  });

  it("delegates all governance and authorization store operations when stores are available", () : any => {
    const governanceStore: Record<string, any> = {
      getPolicyRevision: vi.fn(() : any => ({ revision: 3 })),
      listRoles: vi.fn(() : any => ["role-a"]),
      upsertRole: vi.fn((input?: any) : any => ({ role: input })),
      listTeams: vi.fn(() : any => ["team-a"]),
      upsertTeam: vi.fn((input?: any) : any => ({ team: input })),
      listUserPolicies: vi.fn(() : any => ["policy-a"]),
      upsertUserPolicy: vi.fn((input?: any) : any => ({ userPolicy: input })),
      listAgentGroups: vi.fn(() : any => ["group-a"]),
      upsertAgentGroup: vi.fn((input?: any) : any => ({ agentGroup: input })),
      listAgentBindings: vi.fn(() : any => ["binding-a"]),
      upsertAgentBinding: vi.fn((input?: any) : any => ({ agentBinding: input })),
      listApprovals: vi.fn(() : any => ["approval-a"]),
      upsertApproval: vi.fn((input?: any) : any => ({ approval: input })),
      revokeApproval: vi.fn((approvalId?: any, reason?: any) : any => ({ approvalId, reason }))
    };
    const authStore: Record<string, any> = {
      listReceipts: vi.fn((input?: any) : any => [{ receipt: input }]),
      listLoanRecords: vi.fn((input?: any) : any => [{ loan: input }]),
      listDeniedRequests: vi.fn((input?: any) : any => [{ denied: input }]),
      listDecisions: vi.fn((input?: any) : any => [{ decision: input }]),
      appendReceipt: vi.fn((receipt?: any, metadata?: any) : any => ({ receipt, metadata })),
      appendLoanRecord: vi.fn((record?: any, metadata?: any) : any => ({ record, metadata })),
      appendDeniedRequest: vi.fn((request?: any) : any => ({ request })),
      appendDecision: vi.fn((decision?: any) : any => ({ decision }))
    };
    const engine: Record<string, any> = {
      evaluate: vi.fn((input?: any) : any => ({ allowed: true, input }))
    };
    const provider: any = createSecurityPermissionsProvider({
      authorizationEngine: engine,
      authorizationStore: authStore,
      authorizationGovernanceStore: governanceStore
    });

    expect(provider.getGovernancePolicyRevision()).toEqual({ revision: 3 });
    expect(provider.getGovernanceSummary()).toEqual({
      policyRevision: { revision: 3 },
      roles: ["role-a"],
      departments: [],
      teams: ["team-a"],
      userPolicies: ["policy-a"],
      agentBindings: ["binding-a"],
      agentGroups: ["group-a"],
      approvals: ["approval-a"]
    });
    expect(governanceStore.listApprovals).toHaveBeenCalledWith({ includeRevoked: true });
    expect(provider.listGovernanceRoles({ active: true })).toEqual(["role-a"]);
    expect(provider.upsertGovernanceRole({ roleId: "role-a" })).toEqual({ role: { roleId: "role-a" } });
    expect(provider.listGovernanceTeams({ active: true })).toEqual(["team-a"]);
    expect(provider.upsertGovernanceTeam({ teamId: "team-a" })).toEqual({ team: { teamId: "team-a" } });
    expect(provider.listGovernanceUserPolicies()).toEqual(["policy-a"]);
    expect(provider.upsertGovernanceUserPolicy({ userId: "user-a" })).toEqual({ userPolicy: { userId: "user-a" } });
    expect(provider.listGovernanceAgentGroups({ active: true })).toEqual(["group-a"]);
    expect(provider.upsertGovernanceAgentGroup({ groupId: "group-a" })).toEqual({ agentGroup: { groupId: "group-a" } });
    expect(provider.listGovernanceAgentBindings()).toEqual(["binding-a"]);
    expect(provider.upsertGovernanceAgentBinding({ bindingId: "binding-a" })).toEqual({ agentBinding: { bindingId: "binding-a" } });
    expect(provider.listGovernanceApprovals({ includeRevoked: false })).toEqual(["approval-a"]);
    expect(provider.upsertGovernanceApproval({ approvalId: "approval-a" })).toEqual({ approval: { approvalId: "approval-a" } });
    expect(provider.revokeGovernanceApproval("approval-a", "expired")).toEqual({ approvalId: "approval-a", reason: "expired" });

    expect(provider.listReceipts({ limit: 1 })).toEqual([{ receipt: { limit: 1 } }]);
    expect(provider.listLoanRecords({ limit: 2 })).toEqual([{ loan: { limit: 2 } }]);
    expect(provider.listDeniedRequests({ limit: 3 })).toEqual([{ denied: { limit: 3 } }]);
    expect(provider.listDecisions({ limit: 4 })).toEqual([{ decision: { limit: 4 } }]);
    expect(provider.appendReceipt({ id: "receipt-a" }, { traceId: "trace-a" })).toEqual({
      receipt: { id: "receipt-a" },
      metadata: { traceId: "trace-a" }
    });
    expect(provider.appendLoanRecord({ id: "loan-a" }, { traceId: "trace-b" })).toEqual({
      record: { id: "loan-a" },
      metadata: { traceId: "trace-b" }
    });
    expect(provider.appendDeniedRequest({ id: "denied-a" })).toEqual({
      request: { id: "denied-a" }
    });
    expect(provider.appendDecision({ id: "decision-a" })).toEqual({
      decision: { id: "decision-a" }
    });

    const generatedPolicy: any = provider.setWorkspaceAssetPolicy({
      workspace: " workspace-b ",
      accessMode: "write"
    });
    expect(generatedPolicy).toMatchObject({
      workspaceId: "workspace-b",
      accessMode: "write"
    });
    expect(generatedPolicy.policyId).toMatch(/^workspace_asset_policy_/);
    expect(provider.getWorkspaceAssetPolicy({
      workspace: "workspace-b",
      id: generatedPolicy.policyId
    })).toEqual(generatedPolicy);
    expect(provider.getWorkspaceAssetPolicy({ workspace: "workspace-b" })).toBeNull();

    const permission: any = provider.checkWorkspaceAssetPermission({
      request: { headers: { "x-unit": "1" } },
      authSession: { user: { userId: "user-a" } },
      action: "download",
      requestedEgress: "external"
    });
    expect(permission).toMatchObject({
      allowed: true,
      input: {
        operation: {
          id: "workspace.asset.permission.check",
          requiredScopes: ["workspace:read"],
          readOnly: true
        },
        context: {
          requestedAction: "download",
          requestedEgress: "external"
        }
      }
    });
  });
});
