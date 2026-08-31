import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SECURITY_PERMISSIONS_PROTOCOL_VERSION,
  createSecurityPermissionsProvider
} from "../../../packages/foundation/src/security/security-permissions-provider.ts";

afterEach(() : any => {
  vi.restoreAllMocks();
});

function defaultSummary() : any {
  return {
    enabled: false,
    bootstrap: {},
    session: {
      authenticated: false,
      csrfToken: "",
      expiresAt: "",
      user: null
    },
    roles: [],
    oidc: {}
  };
}

function governanceRevision() : any {
  return {
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 0,
    updatedAt: ""
  };
}

describe("security permissions provider defaults and fallback paths", () : any => {
  it("exposes default summaries and terminal fallbacks without console auth", async () : Promise<any> => {
    const provider: any = createSecurityPermissionsProvider();
    const summary: any = defaultSummary();

    expect(provider.protocolVersion).toBe(SECURITY_PERMISSIONS_PROTOCOL_VERSION);
    expect(provider.authorizationEngine).toBeNull();
    expect(provider.authorizationStore).toBeNull();
    expect(provider.authorizationGovernanceStore).toBeNull();
    expect(provider.getConsoleSummary()).toEqual(summary);
    expect(provider.getSummary()).toEqual(summary);
    expect(provider.getGovernancePolicyRevision()).toEqual(governanceRevision());
    expect(provider.getGovernanceSummary()).toEqual({
      policyRevision: governanceRevision(),
      roles: [],
      departments: [],
      teams: [],
      userPolicies: [],
      agentBindings: [],
      agentGroups: [],
      approvals: [],
      apiKeyRecoveryAssignments: []
    });

    await expect(provider.authorizeOperation({
      authSession: { user: { userId: "user-1" } }
    })).resolves.toEqual({
      ok: false,
      status: 503,
      error: "授权失败：authorization engine 不可用。",
      session: { user: { userId: "user-1" } },
      authorizationDecision: null,
      bootstrap: { authorizationEngineAvailable: false }
    });

    expect(() : any => provider.login()).toThrow("Console authentication login provider is unavailable.");
    expect(provider.logout()).toEqual({ ok: true, cookies: [] });
    expect(provider.rotateSession()).toEqual({
      ok: false,
      status: 503,
      error: "Console session rotation provider is unavailable."
    });
    expect(provider.audit({ action: "login" })).toBeNull();
    expect(provider.roleList()).toEqual([]);
    expect(provider.listUsers()).toEqual([]);
    expect(provider.updateUser("user-1")).toBeNull();
    expect(provider.getOidcConfig()).toEqual({});
    expect(provider.listAudit()).toEqual([]);
    expect(provider.listSessions()).toEqual([]);
    expect(provider.revokeSession("session-1")).toEqual({ ok: false });
    expect(provider.resolveSubject()).toBeNull();
    await expect(provider.evaluatePolicy()).resolves.toEqual({
      effect: "deny",
      allowed: false,
      reasonCode: "authorization_engine_unavailable",
      redactedReason: "Authorization engine is unavailable.",
      evaluatedLayers: ["platform_default"],
      missingScopes: [],
      missingToolsets: [],
      createdAt: expect.any(String)
    });
    expect(provider.listGovernanceRoles()).toEqual([]);
    expect(provider.listGovernanceTeams()).toEqual([]);
    expect(provider.listGovernanceUserPolicies()).toEqual([]);
    expect(provider.listGovernanceAgentBindings()).toEqual([]);
    expect(provider.listGovernanceAgentGroups()).toEqual([]);
    expect(provider.listGovernanceApprovals()).toEqual([]);
    expect(provider.listReceipts()).toEqual([]);
    expect(provider.listLoanRecords()).toEqual([]);
    expect(provider.listDeniedRequests()).toEqual([]);
    expect(provider.listDecisions()).toEqual([]);
    expect(provider.appendReceipt(null)).toBeNull();
    expect(provider.appendLoanRecord(null)).toBeNull();
    expect(provider.appendDeniedRequest(null)).toBeNull();
    expect(provider.appendDecision(null)).toBeNull();
    expect(provider.setWorkspaceAssetPolicy({
      workspaceId: "  workspace-a  ",
      policyId: "  policy-a  ",
      accessMode: "read"
    })).toMatchObject({
      workspaceId: "workspace-a",
      policyId: "policy-a",
      accessMode: "read"
    });
    expect(provider.getWorkspaceAssetPolicy({
      workspaceId: "workspace-a",
      policyId: "policy-a"
    })).toMatchObject({
      workspaceId: "workspace-a",
      policyId: "policy-a",
      accessMode: "read"
    });
    expect(provider.getWorkspaceAssetPolicy({
      workspaceId: "workspace-a",
      policyId: "missing"
    })).toBeNull();
    await expect(provider.checkWorkspaceAssetPermission({
      request: { headers: {} }
    })).resolves.toBeNull();

    expect(() : any => provider.setOidcConfig({ issuer: "issuer" })).toThrow("Console OIDC provider is unavailable.");
    expect(() : any => provider.upsertGovernanceRole({ roleId: "role-a" })).toThrow("Authorization governance role store is unavailable.");
  });
});

describe("security permissions provider construction and delegation", () : any => {
  it("prefers explicit constructor inputs and delegates console auth operations", async () : Promise<any> => {
    const explicitEngine: Record<string, any> = {
      evaluate: vi.fn(() : any => ({ allowed: false, reasonCode: "explicit-engine" })),
      resolveSubject: vi.fn(() : any => ({ subjectId: "explicit-subject" }))
    };
    const explicitStore: Record<string, any> = { id: "explicit-store" };
    const explicitGovernanceStore: Record<string, any> = { id: "explicit-governance-store" };
    const consoleAuth: Record<string, any> = {
      authorizationStore: { id: "console-store" },
      authorizationGovernanceStore: { id: "console-governance-store" },
      authorizationEngine: {
        evaluate: vi.fn(() : any => ({ allowed: false, reasonCode: "console-engine" }))
      },
      getSummary: vi.fn(() : any => ({
        enabled: true,
        bootstrap: { source: "console-auth" },
        session: {
          authenticated: true,
          csrfToken: "csrf_console",
          expiresAt: "",
          user: { userId: "console-user" }
        },
        roles: ["console-role"],
        oidc: { issuer: "console-issuer" }
      })),
      authorizeOperation: vi.fn(async (input?: any) : Promise<any> => ({
        ok: true,
        delegated: true,
        input
      })),
      login: vi.fn((input?: any, request?: any) : any => ({
        ok: true,
        input,
        request
      })),
      logout: vi.fn(() : any => ({ ok: false, cookies: ["logout-cookie"] })),
      rotateSession: vi.fn(() : any => ({ ok: true, rotated: true })),
      audit: vi.fn((entry?: any) : any => ({ recorded: entry })),
      roleList: vi.fn(() : any => ["role-a"]),
      listUsers: vi.fn(() : any => ["user-a"]),
      updateUser: vi.fn((userId?: any, input?: any) : any => ({ userId, input })),
      getOidcConfig: vi.fn(() : any => ({ issuer: "console-issuer" })),
      setOidcConfig: vi.fn((input?: any) : any => ({ saved: input })),
      listAudit: vi.fn(() : any => ["audit-a"]),
      listSessions: vi.fn(() : any => ["session-a"]),
      revokeSession: vi.fn((sessionId?: any) : any => ({ ok: true, sessionId }))
    };

    const provider: any = createSecurityPermissionsProvider({
      consoleAuth,
      authorizationEngine: explicitEngine,
      authorizationStore: explicitStore,
      authorizationGovernanceStore: explicitGovernanceStore
    });

    expect(provider.authorizationEngine).toBe(explicitEngine);
    expect(provider.authorizationStore).toBe(explicitStore);
    expect(provider.authorizationGovernanceStore).toBe(explicitGovernanceStore);

    expect(provider.getSummary({ requestId: "summary-request" })).toEqual({
      enabled: true,
      bootstrap: { source: "console-auth" },
      session: {
        authenticated: true,
        csrfToken: "csrf_console",
        expiresAt: "",
        user: { userId: "console-user" }
      },
      roles: ["console-role"],
      oidc: { issuer: "console-issuer" }
    });
    expect(consoleAuth.getSummary).toHaveBeenCalledWith({ requestId: "summary-request" });

    const loginRequest: Record<string, any> = { headers: { host: "unit.test" } };
    expect(provider.login({ username: "owner" }, loginRequest)).toEqual({
      ok: true,
      input: { username: "owner" },
      request: loginRequest
    });
    expect(provider.logout(loginRequest)).toEqual({ ok: false, cookies: ["logout-cookie"] });
    expect(provider.rotateSession(loginRequest)).toEqual({ ok: true, rotated: true });
    expect(provider.audit({ action: "update" })).toEqual({ recorded: { action: "update" } });
    expect(provider.roleList()).toEqual(["role-a"]);
    expect(provider.listUsers()).toEqual(["user-a"]);
    expect(provider.updateUser("user-1", { enabled: true })).toEqual({
      userId: "user-1",
      input: { enabled: true }
    });
    expect(provider.getOidcConfig()).toEqual({ issuer: "console-issuer" });
    expect(provider.setOidcConfig({ issuer: "new-issuer" })).toEqual({
      saved: { issuer: "new-issuer" }
    });
    expect(provider.listAudit()).toEqual(["audit-a"]);
    expect(provider.listSessions()).toEqual(["session-a"]);
    expect(provider.revokeSession("session-1")).toEqual({
      ok: true,
      sessionId: "session-1"
    });

    const delegated: any = await provider.authorizeOperation({
      operation: { id: "unit.delegate" },
      request: { traceId: "trace-1" },
      authSession: { user: { userId: "user-1" } },
      method: "POST",
      url: new URL("http://unit.test/api/unit/delegate"),
      transport: "custom-transport"
    });

    expect(delegated).toMatchObject({
      ok: true,
      delegated: true,
      input: {
        operation: { id: "unit.delegate" },
        request: { traceId: "trace-1" },
        authSession: { user: { userId: "user-1" } },
        method: "POST",
        transport: "custom-transport"
      }
    });
    expect(delegated.input.url.href).toBe("http://unit.test/api/unit/delegate");
    expect(consoleAuth.authorizeOperation).toHaveBeenCalledTimes(1);
    expect(explicitEngine.evaluate).not.toHaveBeenCalled();

    expect(provider.resolveSubject({ subjectId: "subject-1" })).toEqual({ subjectId: "explicit-subject" });
    await expect(provider.evaluatePolicy({ operation: { id: "policy-1" } })).resolves.toEqual({
      allowed: false,
      reasonCode: "explicit-engine"
    });
    expect(explicitEngine.evaluate).toHaveBeenCalledWith({
      operation: { id: "policy-1" }
    });
  });
});

describe("security permissions provider authorization engine behavior", () : any => {
  it("allows, denies, and formats denial messages from the resolved engine", async () : Promise<any> => {
    const allowedDecision: Record<string, any> = { allowed: true, reasonCode: "allowed", marker: "allow" };
    const missingCapabilitiesDecision: Record<string, any> = {
      allowed: false,
      reasonCode: "missing_capabilities",
      missingCapabilities: ["cap:alpha", "cap:beta"]
    };
    const missingScopesDecision: Record<string, any> = {
      allowed: false,
      reasonCode: "missing_scopes",
      missingScopes: ["scope:read"]
    };
    const fallbackDeniedDecision: Record<string, any> = {
      allowed: false,
      reasonCode: "policy_denied"
    };
    const evaluate: any = vi
      .fn()
      .mockReturnValueOnce(allowedDecision)
      .mockReturnValueOnce(missingCapabilitiesDecision)
      .mockReturnValueOnce(missingScopesDecision)
      .mockReturnValueOnce(fallbackDeniedDecision)
      .mockReturnValueOnce(allowedDecision);
    const provider: any = createSecurityPermissionsProvider({
      authorizationEngine: { evaluate }
    });
    const session: Record<string, any> = { user: { userId: "user-1" } };
    const request: Record<string, any> = { traceId: "request-1" };

    await expect(provider.authorizeOperation({
      operation: { id: "unit.allow" },
      request,
      authSession: session,
      method: "GET",
      url: new URL("http://unit.test/api/allow")
    })).resolves.toEqual({
      ok: true,
      session,
      authorizationDecision: allowedDecision
    });
    expect(evaluate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: { id: "unit.allow" },
      request,
      authSession: session,
      input: { method: "GET", path: "/api/allow" },
      context: { transport: "security-permissions-provider" },
      enforceConfirmation: false
    }));

    await expect(provider.authorizeOperation({
      operation: { id: "unit.missing-capabilities" },
      authSession: session,
      method: "POST",
      url: new URL("http://unit.test/api/deny")
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "权限不足：cap:alpha, cap:beta。",
      session,
      authorizationDecision: missingCapabilitiesDecision
    });

    await expect(provider.authorizeOperation({
      operation: { id: "unit.missing-scopes" },
      authSession: session,
      method: "PATCH",
      url: new URL("http://unit.test/api/deny-scopes")
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "权限不足：scope:read。",
      session,
      authorizationDecision: missingScopesDecision
    });

    await expect(provider.authorizeOperation({
      operation: { id: "unit.reason-code" },
      authSession: session,
      method: "DELETE",
      url: new URL("http://unit.test/api/deny-reason")
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "权限不足：policy_denied。",
      session,
      authorizationDecision: fallbackDeniedDecision
    });

    await expect(provider.authorizeOperation({
      operation: { id: "unit.custom-transport" },
      authSession: session,
      method: "PUT",
      url: new URL("http://unit.test/api/custom-transport"),
      transport: "custom-transport",
      input: {
        workspaceId: "ws-provider",
        method: "forged",
        path: "/forged"
      },
      context: {
        resource: {
          tenantId: "tenant-provider"
        }
      }
    })).resolves.toEqual({
      ok: true,
      session,
      authorizationDecision: allowedDecision
    });
    expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({
      input: {
        workspaceId: "ws-provider",
        method: "PUT",
        path: "/api/custom-transport"
      },
      context: {
        resource: {
          tenantId: "tenant-provider"
        },
        transport: "custom-transport"
      }
    }));
  });

  it("checks workspace asset permissions through the engine", async () : Promise<any> => {
    const decision: Record<string, any> = { allowed: true, reasonCode: "allowed" };
    const evaluate: any = vi.fn(() : any => decision);
    const provider: any = createSecurityPermissionsProvider({
      authorizationEngine: { evaluate }
    });
    const input: Record<string, any> = {
      authSession: { user: { userId: "workspace-reader" } },
      request: { headers: { host: "unit.test" } },
      requestedAction: "read",
      requestedEgress: "https://egress.example"
    };

    await expect(provider.checkWorkspaceAssetPermission(input)).resolves.toBe(decision);
    expect(evaluate).toHaveBeenCalledWith({
      operation: {
        id: "workspace.asset.permission.check",
        requiredScopes: ["workspace:read"],
        safety: { risk: "read_only" },
        readOnly: true
      },
      request: input.request,
      authSession: input.authSession,
      input,
      context: {
        requestedAction: "read",
        requestedEgress: "https://egress.example"
      }
    });
  });
});

describe("security permissions provider workspace asset policies", () : any => {
  it("requires an explicit workspace binding and normalizes policy identifiers", () : any => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-1111-2222-3333-444444444444");

    const provider: any = createSecurityPermissionsProvider();
    expect(() : any => provider.setWorkspaceAssetPolicy({
      workspace: "legacy-workspace",
      "policy-id": "policy-a",
      accessMode: "read"
    })).toThrow(expect.objectContaining({ code: "workspace_binding_invalid" }));
    const explicit: any = provider.setWorkspaceAssetPolicy({
      workspaceId: "  workspace-a  ",
      "policy-id": "  policy-a  ",
      accessMode: "read"
    });

    expect(explicit).toMatchObject({
      workspaceId: "workspace-a",
      policyId: "policy-a",
      accessMode: "read"
    });
    expect(explicit.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(provider.getWorkspaceAssetPolicy({
      workspaceId: "workspace-a",
      policyId: "policy-a"
    })).toEqual(explicit);

    const generated: any = provider.setWorkspaceAssetPolicy({
      workspaceId: "workspace-b",
      policyId: "   ",
      accessMode: "write"
    });

    expect(generated.policyId).toBe("workspace_asset_policy_00000000-1111-2222-3333-444444444444");
    expect(provider.getWorkspaceAssetPolicy({
      workspace: "workspace-b",
      "policy-id": generated.policyId
    })).toEqual(generated);
    expect(provider.getWorkspaceAssetPolicy({
      workspaceId: "workspace-b",
      policyId: "   "
    })).toBeNull();
    expect(provider.getWorkspaceAssetPolicy({
      workspaceId: "workspace-b"
    })).toBeNull();
  });
});
