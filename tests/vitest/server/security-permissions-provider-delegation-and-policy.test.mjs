import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SECURITY_PERMISSIONS_PROTOCOL_VERSION,
  createSecurityPermissionsProvider
} from "../../../packages/foundation/src/security/security-permissions-provider.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

function defaultSummary() {
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

function governanceRevision() {
  return {
    protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
    revision: 0,
    updatedAt: ""
  };
}

describe("security permissions provider defaults and fallback paths", () => {
  it("exposes default summaries and terminal fallbacks without console auth", async () => {
    const provider = createSecurityPermissionsProvider();
    const summary = defaultSummary();

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
      approvals: []
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

    expect(() => provider.login()).toThrow("Console authentication login provider is unavailable.");
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
    expect(provider.evaluatePolicy()).toEqual({
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
    expect(provider.checkWorkspaceAssetPermission({
      request: { headers: {} }
    })).toBeNull();

    expect(() => provider.setOidcConfig({ issuer: "issuer" })).toThrow("Console OIDC provider is unavailable.");
    expect(() => provider.upsertGovernanceRole({ roleId: "role-a" })).toThrow("Authorization governance role store is unavailable.");
  });
});

describe("security permissions provider construction and delegation", () => {
  it("prefers explicit constructor inputs and delegates console auth operations", async () => {
    const explicitEngine = {
      evaluate: vi.fn(() => ({ allowed: false, reasonCode: "explicit-engine" })),
      resolveSubject: vi.fn(() => ({ subjectId: "explicit-subject" }))
    };
    const explicitStore = { id: "explicit-store" };
    const explicitGovernanceStore = { id: "explicit-governance-store" };
    const consoleAuth = {
      authorizationStore: { id: "console-store" },
      authorizationGovernanceStore: { id: "console-governance-store" },
      authorizationEngine: {
        evaluate: vi.fn(() => ({ allowed: false, reasonCode: "console-engine" }))
      },
      getSummary: vi.fn(() => ({
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
      authorizeOperation: vi.fn(async (input) => ({
        ok: true,
        delegated: true,
        input
      })),
      login: vi.fn((input, request) => ({
        ok: true,
        input,
        request
      })),
      logout: vi.fn(() => ({ ok: false, cookies: ["logout-cookie"] })),
      rotateSession: vi.fn(() => ({ ok: true, rotated: true })),
      audit: vi.fn((entry) => ({ recorded: entry })),
      roleList: vi.fn(() => ["role-a"]),
      listUsers: vi.fn(() => ["user-a"]),
      updateUser: vi.fn((userId, input) => ({ userId, input })),
      getOidcConfig: vi.fn(() => ({ issuer: "console-issuer" })),
      setOidcConfig: vi.fn((input) => ({ saved: input })),
      listAudit: vi.fn(() => ["audit-a"]),
      listSessions: vi.fn(() => ["session-a"]),
      revokeSession: vi.fn((sessionId) => ({ ok: true, sessionId }))
    };

    const provider = createSecurityPermissionsProvider({
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

    const loginRequest = { headers: { host: "unit.test" } };
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

    const delegated = await provider.authorizeOperation({
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
    expect(provider.evaluatePolicy({ operation: { id: "policy-1" } })).toEqual({
      allowed: false,
      reasonCode: "explicit-engine"
    });
    expect(explicitEngine.evaluate).toHaveBeenCalledWith({
      operation: { id: "policy-1" }
    });
  });
});

describe("security permissions provider authorization engine behavior", () => {
  it("allows, denies, and formats denial messages from the resolved engine", async () => {
    const allowedDecision = { allowed: true, reasonCode: "allowed", marker: "allow" };
    const missingCapabilitiesDecision = {
      allowed: false,
      reasonCode: "missing_capabilities",
      missingCapabilities: ["cap:alpha", "cap:beta"]
    };
    const missingScopesDecision = {
      allowed: false,
      reasonCode: "missing_scopes",
      missingScopes: ["scope:read"]
    };
    const fallbackDeniedDecision = {
      allowed: false,
      reasonCode: "policy_denied"
    };
    const evaluate = vi
      .fn()
      .mockReturnValueOnce(allowedDecision)
      .mockReturnValueOnce(missingCapabilitiesDecision)
      .mockReturnValueOnce(missingScopesDecision)
      .mockReturnValueOnce(fallbackDeniedDecision)
      .mockReturnValueOnce(allowedDecision);
    const provider = createSecurityPermissionsProvider({
      authorizationEngine: { evaluate }
    });
    const session = { user: { userId: "user-1" } };
    const request = { traceId: "request-1" };

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

  it("checks workspace asset permissions through the engine", () => {
    const decision = { allowed: true, reasonCode: "allowed" };
    const evaluate = vi.fn(() => decision);
    const provider = createSecurityPermissionsProvider({
      authorizationEngine: { evaluate }
    });
    const input = {
      authSession: { user: { userId: "workspace-reader" } },
      request: { headers: { host: "unit.test" } },
      requestedAction: "read",
      requestedEgress: "https://egress.example"
    };

    expect(provider.checkWorkspaceAssetPermission(input)).toBe(decision);
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

describe("security permissions provider workspace asset policies", () => {
  it("normalizes policy identifiers and falls back from blank ids", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-1111-2222-3333-444444444444");

    const provider = createSecurityPermissionsProvider();
    const explicit = provider.setWorkspaceAssetPolicy({
      workspace: "  workspace-a  ",
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

    const generated = provider.setWorkspaceAssetPolicy({
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
