import { describe, expect, it, vi } from "vitest";

import { createSecurityPermissionsProvider } from "../../../packages/foundation/src/security/security-permissions-provider.mjs";

describe("security permissions provider behavior", () => {
  it("formats authorization denial messages for capabilities, scopes, and reason codes", async () => {
    const authSession = { user: { userId: "user-a" } };
    const engine = {
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
    const provider = createSecurityPermissionsProvider({ authorizationEngine: engine });

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

  it("delegates all governance and authorization store operations when stores are available", () => {
    const governanceStore = {
      getPolicyRevision: vi.fn(() => ({ revision: 3 })),
      listRoles: vi.fn(() => ["role-a"]),
      upsertRole: vi.fn((input) => ({ role: input })),
      listTeams: vi.fn(() => ["team-a"]),
      upsertTeam: vi.fn((input) => ({ team: input })),
      listUserPolicies: vi.fn(() => ["policy-a"]),
      upsertUserPolicy: vi.fn((input) => ({ userPolicy: input })),
      listAgentGroups: vi.fn(() => ["group-a"]),
      upsertAgentGroup: vi.fn((input) => ({ agentGroup: input })),
      listAgentBindings: vi.fn(() => ["binding-a"]),
      upsertAgentBinding: vi.fn((input) => ({ agentBinding: input })),
      listApprovals: vi.fn(() => ["approval-a"]),
      upsertApproval: vi.fn((input) => ({ approval: input })),
      revokeApproval: vi.fn((approvalId, reason) => ({ approvalId, reason }))
    };
    const authStore = {
      listReceipts: vi.fn((input) => [{ receipt: input }]),
      listLoanRecords: vi.fn((input) => [{ loan: input }]),
      listDeniedRequests: vi.fn((input) => [{ denied: input }]),
      listDecisions: vi.fn((input) => [{ decision: input }]),
      appendReceipt: vi.fn((receipt, metadata) => ({ receipt, metadata })),
      appendLoanRecord: vi.fn((record, metadata) => ({ record, metadata })),
      appendDeniedRequest: vi.fn((request) => ({ request })),
      appendDecision: vi.fn((decision) => ({ decision }))
    };
    const engine = {
      evaluate: vi.fn((input) => ({ allowed: true, input }))
    };
    const provider = createSecurityPermissionsProvider({
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

    const generatedPolicy = provider.setWorkspaceAssetPolicy({
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

    const permission = provider.checkWorkspaceAssetPermission({
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
