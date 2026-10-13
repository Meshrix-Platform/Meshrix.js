import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  browseServerPath,
  createPathBrowserRoots
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/path-browser.ts";

let executeConsoleDomainOperation: any;

beforeAll(async () : Promise<any> => {
  ({ executeConsoleDomainOperation } = await import(
    "../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts"
  ));
});

async function runOperation(operationId?: any, { input = {}, context = {} }: Record<string, any> = {}) : Promise<any> {
  return executeConsoleDomainOperation({ operationId, input, context });
}

function createAuthProvider(overrides: Record<string, any> = {}) : any {
  const user: Record<string, any> = { userId: "u-1", username: "alice", roleId: "maintainer", enabled: true };
  const roles: any[] = [
    { roleId: "maintainer", name: "Maintainer" },
    { roleId: "viewer", name: "Viewer" }
  ];
  return {
    getConsoleSummary: vi.fn(() : any => ({ ok: true, source: "console-summary" })),
    getSummary: vi.fn(() : any => ({ ok: true, source: "summary" })),
    login: vi.fn(async () : Promise<any> => ({
      cookies: ["sid=next; HttpOnly"],
      csrfToken: "csrf-1",
      session: {
        sessionId: "session-1",
        expiresAt: "2026-06-04T10:00:00.000Z",
        user
      }
    })),
    logout: vi.fn(() : any => ({ cookies: ["sid=; Max-Age=0"] })),
    audit: vi.fn(),
    roleList: vi.fn(() : any => roles),
    listUsers: vi.fn(() : any => [user]),
    updateUser: vi.fn(async (userId?: any, input?: any) : Promise<any> => (userId ? { ...user, ...input, userId } : null)),
    getOidcConfig: vi.fn(() : any => ({ enabled: false })),
    setOidcConfig: vi.fn((input?: any) : any => ({
      enabled: input.enabled === true,
      issuer: input.issuer || "",
      clientId: input.clientId || ""
    })),
    listAudit: vi.fn(() : any => [{ auditId: "auth-audit-1", status: "ok" }]),
    listSessions: vi.fn(() : any => [{ sessionId: "session-1" }]),
    rotateSession: vi.fn(() : any => ({
      ok: true,
      cookies: ["sid=rotated; HttpOnly"],
      csrfToken: "csrf-2",
      rotatedAt: "2026-06-04T11:00:00.000Z",
      session: { sessionId: "session-2", user }
    })),
    revokeSession: vi.fn((sessionId?: any) : any => (sessionId === "missing" ? { ok: false } : { ok: true, sessionId })),
    listDecisions: vi.fn(() : any => [{ decisionId: "decision-1" }]),
    resolveSubject: vi.fn(({ subject }: Record<string, any>) : any => ({ subjectId: subject?.id || "subject-1" })),
    evaluatePolicy: vi.fn(({ operation }: Record<string, any>) : any => ({ allowed: true, operationId: operation.id })),
    getGovernanceSummary: vi.fn(() : any => ({ revision: 1 })),
    listGovernanceRoles: vi.fn(() : any => [{ roleId: "governance-admin" }]),
    upsertGovernanceRole: vi.fn((input?: any) : any => ({ roleId: input.roleId || "governance-admin" })),
    listGovernanceTeams: vi.fn(() : any => [{ teamId: "team-1" }]),
    upsertGovernanceTeam: vi.fn((input?: any) : any => ({ teamId: input.teamId || "team-2" })),
    listGovernanceUserPolicies: vi.fn(() : any => [{ userId: "u-1" }]),
    upsertGovernanceUserPolicy: vi.fn((input?: any) : any => ({ userId: input.userId || "u-2" })),
    listGovernanceAgentGroups: vi.fn(() : any => [{ groupId: "group-1" }]),
    upsertGovernanceAgentGroup: vi.fn((input?: any) : any => ({ groupId: input.groupId || "group-2" })),
    listGovernanceAgentBindings: vi.fn(() : any => [{ agentId: "agent-1", profileId: "profile-1" }]),
    upsertGovernanceAgentBinding: vi.fn((input?: any) : any => ({
      agentId: input.agentId || "agent-2",
      profileId: input.profileId || "profile-2"
    })),
    listGovernanceApprovals: vi.fn(() : any => [{ approvalId: "approval-1" }]),
    upsertGovernanceApproval: vi.fn((input?: any) : any => ({ approvalId: input.approvalId || "approval-2" })),
    revokeGovernanceApproval: vi.fn((approvalId?: any, reason?: any) : any =>
      approvalId === "missing" ? null : { approvalId, revoked: true, reason }
    ),
    listReceipts: vi.fn(() : any => [{ receiptId: "receipt-1" }]),
    listLoanRecords: vi.fn(() : any => [{ loanId: "loan-1" }]),
    listDeniedRequests: vi.fn(() : any => [{ requestId: "denied-1" }]),
    setWorkspaceAssetPolicy: vi.fn((input?: any) : any => ({ workspaceId: input.workspaceId, policyId: "policy-1" })),
    checkWorkspaceAssetPermission: vi.fn((input?: any) : any => ({ allowed: true, workspaceId: input.workspaceId })),
    getGovernancePolicyRevision: vi.fn(() : any => 7),
    ...overrides
  };
}

function createAuditStore() : any {
  const items: any[] = [
    {
      auditId: "audit-1",
      operationId: "workspace.write",
      transport: "http",
      risk: "content_write",
      status: "ok",
      createdAt: "2026-06-04T00:00:00.000Z",
      inputHash: "hash-1",
      actor: { userId: "u-1" }
    },
    {
      auditId: "audit-2",
      operationId: "workspace.read",
      transport: "http",
      risk: "read_only",
      status: "failed",
      readOnly: true
    }
  ];
  return {
    list: vi.fn(() : any => items),
    exportRedacted: vi.fn(() : any => ({
      manifest: { exportId: "export-1" },
      items: [{ auditId: "redacted-1" }],
      jsonl: "{\"auditId\":\"redacted-1\"}\n"
    })),
    getRetentionPolicy: vi.fn(() : any => ({ retentionDays: 30 })),
    setRetentionPolicy: vi.fn((input?: any) : any => ({ ...input, retentionDays: Number(input.retentionDays) })),
    pruneExpired: vi.fn((input?: any) : any => ({ deleted: 3, retentionDays: Number(input.retentionDays) })),
    getTrace: vi.fn((traceId?: any) : any => ({ traceId, items: [{ auditId: "audit-1" }] }))
  };
}

function createProtocolEventBus() : any {
  return {
    publish: vi.fn(async (topic?: any, _payload?: any, options: Record<string, any> = {}) : Promise<any> => ({
      id: `evt-${options.type || topic}`,
      offset: 1,
      topic
    }))
  };
}

describe("console domain auth and authorization facade coverage", () : any => {
  it("covers auth session, login, user, oidc, audit, trace, and session branches", async () : Promise<any> => {
    const request: Record<string, any> = { headers: { "user-agent": "vitest" } };
    const authSession: Record<string, any> = { user: { userId: "u-1", username: "alice", roleId: "maintainer" } };
    const authProvider: any = createAuthProvider();
    const auditStore: any = createAuditStore();
    const context: Record<string, any> = {
      request,
      authSession,
      securityPermissions: authProvider,
      operationAuditStore: auditStore,
      appendConsoleOperationLog: vi.fn()
    };

    await expect(runOperation("auth.session", { context: { request, securityPermissions: null } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("auth.session", { context }))
      .resolves.toMatchObject({ status: 200, payload: { source: "console-summary" } });
    const fallbackProvider: any = createAuthProvider({ getConsoleSummary: undefined });
    await expect(runOperation("auth.session", { context: { request, securityPermissions: fallbackProvider } }))
      .resolves.toMatchObject({ status: 200, payload: { source: "summary" } });
    const disclosingProvider: any = createAuthProvider({
      getConsoleSummary: vi.fn(() : any => ({
        enabled: true,
        session: { authenticated: false, csrfToken: "", expiresAt: "", user: null },
        roles: [{
          roleId: "owner",
          label: "Owner",
          scopes: ["auth:admin"],
          resourcePolicies: [{ resourceType: "workspace" }]
        }],
        oidc: { issuer: "https://issuer.example.invalid", clientId: "console-client" }
      }))
    });
    const anonymousSession: any = await runOperation("auth.session", {
      context: { request, securityPermissions: disclosingProvider }
    });
    expect(anonymousSession.status).toBe(200);
    expect(anonymousSession.payload).not.toHaveProperty("oidc");
    expect(anonymousSession.payload).not.toHaveProperty("roles");
    expect(JSON.stringify(anonymousSession.payload)).not.toMatch(/scopes|resourcePolicies|issuer\.example/);

    await expect(runOperation("auth.login", {
      input: { username: "alice", password: "secret", remember: true },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: {
        ok: true,
        csrfToken: "csrf-1",
        roles: [
          { roleId: "maintainer", label: "maintainer" },
          { roleId: "viewer", label: "viewer" }
        ]
      }
    });
    expect(authProvider.audit).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "auth.login",
      status: "ok"
    }));

    const failedProvider: any = createAuthProvider({
      login: vi.fn(async () : Promise<any> => {
        throw new Error("EACCES: synthetic-private-path; synthetic-secret-password");
      })
    });
    const failedLoginLog = vi.fn();
    await expect(runOperation("auth.login", {
      input: { username: "alice", password: "synthetic-secret-password" },
      context: { request, securityPermissions: failedProvider, appendConsoleOperationLog: failedLoginLog }
    })).resolves.toMatchObject({ status: 401, payload: { error: "用户名或密码错误。" } });
    expect(failedProvider.audit).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "console_login_failed",
      error: "用户名或密码错误。"
    }));
    expect(failedLoginLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "console.auth.login.failed",
      error: "用户名或密码错误。"
    }));
    expect(JSON.stringify(failedLoginLog.mock.calls)).not.toContain("synthetic-private-path");
    expect(JSON.stringify(failedLoginLog.mock.calls)).not.toContain("synthetic-secret-password");

    await expect(runOperation("auth.logout", { context }))
      .resolves.toMatchObject({ status: 200, payload: { ok: true } });
    await expect(runOperation("auth.users", { context }))
      .resolves.toMatchObject({ status: 200, payload: { users: expect.any(Array), roles: expect.any(Array) } });
    await expect(runOperation("auth.users.create", { context }))
      .resolves.toMatchObject({ status: 405 });
    await expect(runOperation("auth.users.update", { input: { userId: "u-1", password: "blocked" }, context }))
      .resolves.toMatchObject({ status: 405 });
    await expect(runOperation("auth.users.update", { input: {}, context }))
      .resolves.toMatchObject({ status: 404 });
    await expect(runOperation("auth.users.update", { input: { "user-id": "u-2", roleId: "viewer" }, context }))
      .resolves.toMatchObject({ status: 200, payload: { user: { userId: "u-2", roleId: "viewer" } } });
    const throwingProvider: any = createAuthProvider({
      updateUser: vi.fn(async () : Promise<any> => {
        throw new Error("invalid role");
      })
    });
    await expect(runOperation("auth.users.update", {
      input: { id: "u-3" },
      context: { securityPermissions: throwingProvider }
    })).resolves.toMatchObject({ status: 400, payload: { error: "invalid role" } });

    await expect(runOperation("auth.roles.get", { input: { id: "missing" }, context }))
      .resolves.toMatchObject({ status: 404 });
    await expect(runOperation("auth.roles.get", { input: { roleId: "maintainer" }, context }))
      .resolves.toMatchObject({ status: 200, payload: { role: { roleId: "maintainer" } } });
    await expect(runOperation("auth.oidc.get", { context }))
      .resolves.toMatchObject({ status: 200, payload: { oidc: { enabled: false } } });
    await expect(runOperation("auth.oidc.set", {
      input: { enabled: true, issuer: "https://issuer.example.invalid", clientId: "client-1" },
      context
    })).resolves.toMatchObject({ status: 200, payload: { oidc: { enabled: true } } });

    await expect(runOperation("auth.audit", {
      input: { limit: "5", "operation-id": "workspace.write", "trace-id": "trace-1" },
      context
    })).resolves.toMatchObject({ status: 200, payload: { items: expect.any(Array) } });
    await expect(runOperation("auth.audit", { context: { securityPermissions: authProvider } }))
      .resolves.toMatchObject({ status: 200, payload: { items: [{ auditId: "auth-audit-1", status: "ok" }] } });
    await expect(runOperation("auth.audit.export", { context: { securityPermissions: authProvider } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("auth.audit.export", { input: { userId: "u-1" }, context }))
      .resolves.toMatchObject({ status: 200, payload: { export: { manifest: { exportId: "export-1" } } } });
    await expect(runOperation("auth.audit.retention.get", { context: { securityPermissions: authProvider } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("auth.audit.retention.get", { context }))
      .resolves.toMatchObject({ status: 200, payload: { policy: { retentionDays: 30 } } });
    await expect(runOperation("auth.audit.retention.set", {
      input: { "retention-days": "45", "max-export-items": 200 },
      context
    })).resolves.toMatchObject({ status: 200, payload: { policy: { retentionDays: 45 } } });
    await expect(runOperation("auth.audit.prune", { input: { retentionDays: "15" }, context }))
      .resolves.toMatchObject({ status: 200, payload: { prune: { deleted: 3, retentionDays: 15 } } });
    await expect(runOperation("observability.trace.get", { context: { securityPermissions: authProvider } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("observability.trace.get", {
      input: { id: "trace-1", limit: "9", "tenant-id": "tenant-1" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { traceId: "trace-1", authorizationDecisionCount: 1 }
    });

    await expect(runOperation("auth.sessions", { context }))
      .resolves.toMatchObject({ status: 200, payload: { sessions: [{ sessionId: "session-1" }] } });
    const rotateFailureProvider: any = createAuthProvider({
      rotateSession: vi.fn(() : any => ({ ok: false, status: 419, error: "expired" }))
    });
    await expect(runOperation("auth.sessions.rotate", {
      context: { request, securityPermissions: rotateFailureProvider }
    })).resolves.toMatchObject({ status: 419, payload: { error: "expired" } });
    await expect(runOperation("auth.sessions.rotate", { context }))
      .resolves.toMatchObject({ status: 200, payload: { ok: true, rotatedAt: expect.any(String) } });
    await expect(runOperation("auth.sessions.revoke", { input: { id: "missing" }, context }))
      .resolves.toMatchObject({ status: 404 });
    await expect(runOperation("auth.sessions.revoke", { input: { "session-id": "session-1" }, context }))
      .resolves.toMatchObject({ status: 200, payload: { ok: true, sessionId: "session-1" } });

    expect(auditStore.list).toHaveBeenCalledWith(expect.objectContaining({
      limit: 5,
      operationId: "workspace.write",
      traceId: "trace-1"
    }));
    expect(authProvider.listDecisions).toHaveBeenCalledWith(expect.objectContaining({
      traceId: "trace-1",
      limit: 9,
      tenantId: "tenant-1"
    }));
  });

  it("covers workspace audit query, history, and revert scope payloads", async () : Promise<any> => {
    const diagnosticNeedle = "synthetic-checkpoint-private-path";
    const checkpointTreeApi: Record<string, any> = {
      checkpointTreeId: vi.fn(() : any => "tree-workspace-1"),
      loadCheckpointTree: vi.fn(async () : Promise<any> => ({
        treeId: "tree-workspace-1",
        rootNodeId: "root",
        ownerId: "workspace-1",
        nodes: {
          root: {
            nodeId: "root",
            completedAt: "2026-06-04T00:00:00.000Z",
            metadata: {
              operationId: "workspace.seed",
              workspaceFileSnapshot: {
                workspaceId: "workspace-1",
                deleteExtraneous: true,
                files: []
              }
            }
          },
          write: {
            nodeId: "write",
            parentId: "root",
            completedAt: "2026-06-04T00:01:00.000Z",
            metadata: {
              operationId: "workspace.write",
              workspaceFileSnapshot: {
                workspaceId: "workspace-1",
                deleteExtraneous: true,
                files: [{ path: "docs/state.txt", content: "before" }]
              }
            }
          }
        }
      })),
      restoreCheckpointTree: vi.fn(async () : Promise<any> => {
        throw new Error(`EACCES: denied at ${diagnosticNeedle}`);
      })
    };
    const agentWorkspace: Record<string, any> = {
      restoreWorkspaceFiles: vi.fn(async (input?: any) : Promise<any> => ({
        ok: true,
        dryRun: input.dryRun === true,
        applied: input.dryRun !== true,
        workspaceId: input.workspaceId,
        appliedActions: []
      }))
    };
    const context: Record<string, any> = { operationAuditStore: createAuditStore(), checkpointTreeApi, agentWorkspace };

    await expect(runOperation("workspace.audit.query", {
      input: { limit: "2", operationId: "workspace.write", status: "ok" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { ok: true, count: 2, items: expect.any(Array) }
    });
    await expect(runOperation("workspace.operation.history", { context }))
      .resolves.toMatchObject({ status: 200, payload: { count: 2 } });
    await expect(runOperation("workspace.operation.revert.scope", {
      input: { "audit-id": "audit-1", workspaceId: "workspace-1" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: {
        requestedAuditId: "audit-1",
        candidateCount: 1,
        reversibleCount: 1,
        canApply: true,
        mode: "preview",
        revert: { dryRun: true, workspaceFileRestore: { dryRun: true } }
      }
    });
    expect(checkpointTreeApi.loadCheckpointTree).toHaveBeenCalledWith(expect.objectContaining({
      treeId: "tree-workspace-1"
    }));
    expect(agentWorkspace.restoreWorkspaceFiles).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      dryRun: true,
      operationId: "workspace.operation.revert.scope"
    }));
    await expect(runOperation("workspace.operation.revert.scope", {
      input: { limit: "50" },
      context: {}
    })).resolves.toMatchObject({
      status: 200,
      payload: { candidateCount: 0, reversibleCount: 0, canApply: false }
    });

    const applied = await runOperation("workspace.operation.revert.apply", {
      input: { auditId: "audit-1", workspaceId: "workspace-1" },
      context
    });
    expect(applied).toMatchObject({
      status: 200,
      payload: {
        revert: {
          applied: true,
          checkpointMarker: {
            ok: false,
            errorCode: "checkpoint_marker_restore_failed",
            error: "Checkpoint restore marker could not be saved."
          }
        }
      }
    });
    expect(JSON.stringify(applied.payload)).not.toContain(diagnosticNeedle);

    checkpointTreeApi.loadCheckpointTree.mockRejectedValueOnce(
      new Error(`EACCES: checkpoint snapshot at ${diagnosticNeedle}`)
    );
    const failedRevert = await runOperation("workspace.operation.revert.scope", {
      input: { auditId: "audit-1", workspaceId: "workspace-1" },
      context
    });
    expect(failedRevert).toMatchObject({
      status: 500,
      payload: {
        errorCode: "checkpoint_tree_load_failed",
        error: "The workspace checkpoint could not be loaded."
      }
    });
    expect(JSON.stringify(failedRevert.payload)).not.toContain(diagnosticNeedle);
  });

  it("keeps filesystem diagnostics out of path-browser responses", async () : Promise<any> => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-path-browser-private-error-"));
    const diagnosticNeedle = "synthetic-path-browser-private-root";
    const roots = createPathBrowserRoots({ userDataPath });
    const privateDataRoot = roots.find((root?: any) : any => root.label === "Meshrix.js 数据目录");
    const readDirectory = vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      new Error(`EACCES: denied at ${diagnosticNeedle}`) as any
    );
    try {
      const result = await browseServerPath({
        requestedPath: `${privateDataRoot.id}:/`,
        userDataPath
      });
      expect(result.errorCode).toBe("path_browser_read_failed");
      expect(result.error).toBe("无法读取目录，请检查访问权限或目录是否仍存在。");
      expect(JSON.stringify(result)).not.toContain(diagnosticNeedle);
      expect(JSON.stringify(result)).not.toContain(userDataPath);
    } finally {
      readDirectory.mockRestore();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("redacts checkpoint provider and workspace restore failures", async () : Promise<any> => {
    const diagnosticNeedle = "synthetic-checkpoint-private-root";
    const checkpointTreeApi: Record<string, any> = {
      diffCheckpointTree: vi.fn(async () : Promise<any> => {
        throw new Error(`EACCES: denied at ${diagnosticNeedle}`);
      }),
      previewCheckpointRestore: vi.fn(async () : Promise<any> => ({
        treeId: "tree-workspace-1",
        nodeId: "root",
        actions: [],
        target: {
          metadata: {
            workspaceId: "workspace-1",
            workspaceFileSnapshot: {
              workspaceId: "workspace-1",
              deleteExtraneous: true,
              files: []
            }
          }
        }
      })),
      restoreCheckpointTree: vi.fn(async () : Promise<any> => {
        throw new Error(`EACCES: denied at ${diagnosticNeedle}`);
      })
    };
    const agentWorkspace = {
      restoreWorkspaceFiles: vi.fn(async () : Promise<any> => ({
        ok: false,
        status: 409,
        error: `Workspace conflict at ${diagnosticNeedle}`
      }))
    };
    const context = { checkpointTreeApi, agentWorkspace };

    const diff = await runOperation("workspace.checkpoint.diff", {
      input: { treeId: "tree-workspace-1" },
      context
    });
    expect(diff).toMatchObject({
      status: 404,
      payload: { code: "checkpoint_diff_failed", error: "Checkpoint diff could not be completed." }
    });
    expect(JSON.stringify(diff.payload)).not.toContain(diagnosticNeedle);

    const preview = await runOperation("workspace.checkpoint.restore.preview", {
      input: { treeId: "tree-workspace-1", workspaceId: "workspace-1" },
      context
    });
    expect(preview).toMatchObject({
      status: 409,
      payload: {
        code: "workspace_file_restore_failed",
        error: "The workspace changed since this checkpoint. Refresh and try again."
      }
    });
    expect(JSON.stringify(preview.payload)).not.toContain(diagnosticNeedle);

    const restored = await runOperation("workspace.checkpoint.restore", {
      input: { treeId: "tree-workspace-1", workspaceId: "workspace-1" },
      context: {
        checkpointTreeApi: {
          previewCheckpointRestore: vi.fn(async () : Promise<any> => ({ treeId: "tree-workspace-1", nodeId: "root", actions: [] })),
          restoreCheckpointTree: checkpointTreeApi.restoreCheckpointTree
        }
      }
    });
    expect(restored).toMatchObject({
      status: 404,
      payload: { code: "checkpoint_restore_failed", error: "Checkpoint restore could not be completed." }
    });
    expect(JSON.stringify(restored.payload)).not.toContain(diagnosticNeedle);
  });

  it("covers authorization facade unavailable, list, upsert, revoke, and workspace asset branches", async () : Promise<any> => {
    const securityPermissions: any = createAuthProvider();
    const protocolEventBus: any = createProtocolEventBus();
    const context: Record<string, any> = {
      securityPermissions,
      protocolEventBus,
      request: { id: "req-1" },
      authSession: { user: { userId: "u-1", username: "alice" } }
    };

    await expect(runOperation("authorization.subject.resolve", { context: {} }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("authorization.subject.resolve", {
      input: { subject: { id: "subject-custom" } },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { ok: true, subject: { subjectId: "subject-custom" } }
    });
    await expect(runOperation("authorization.policy.evaluate", { context: {} }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("authorization.policy.evaluate", {
      input: { operationId: "workspace.write", requiredScopes: ["workspace:write"], resourceId: "asset-1" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { decision: { allowed: true, operationId: "workspace.write" } }
    });
    await expect(runOperation("authorization.governance.summary", { context: { securityPermissions: {} } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("authorization.governance.summary", { context }))
      .resolves.toMatchObject({ status: 200, payload: { governance: { revision: 1 } } });

    for (const [operationId, expectedItem] of [
      ["authorization.roles.list", { roleId: "governance-admin" }],
      ["authorization.teams.list", { teamId: "team-1" }],
      ["authorization.users.policies.list", { userId: "u-1" }],
      ["authorization.agent_groups.list", { groupId: "group-1" }],
      ["authorization.agents.bindings.list", { agentId: "agent-1" }],
      ["authorization.approvals.list", { approvalId: "approval-1" }]
    ]) {
      await expect(runOperation(operationId, { input: { includeRevoked: "true" }, context }))
        .resolves.toMatchObject({ status: 200, payload: { items: [expectedItem], count: 1 } });
    }

    for (const [operationId, input, payloadKey] of [
      ["authorization.roles.upsert", { roleId: "role-2" }, "role"],
      ["authorization.teams.upsert", { teamId: "team-2" }, "team"],
      ["authorization.users.policy.upsert", { userId: "u-2" }, "userPolicy"],
      ["authorization.agent_groups.upsert", { groupId: "group-2" }, "agentGroup"],
      ["authorization.agents.binding.upsert", { agentId: "agent-2", profileId: "profile-2" }, "agentBinding"],
      ["authorization.approvals.upsert", { approvalId: "approval-2" }, "approval"]
    ]) {
      const response: any = await runOperation(operationId, { input, context });
      expect(response).toMatchObject({
        status: 200,
        payload: {
          [payloadKey]: expect.objectContaining(input),
          policyRevision: 7,
          refresh: { required: true },
          events: {
            governance: { topic: "authorization.governance.updated" },
            permissions: { topic: "permissions.updated" }
          }
        }
      });
    }

    await expect(runOperation("authorization.roles.upsert", { context: { securityPermissions: {} } }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("authorization.approvals.revoke", {
      input: { id: "missing" },
      context
    })).resolves.toMatchObject({ status: 404 });
    await expect(runOperation("authorization.approvals.revoke", {
      input: { approvalId: "approval-2", reason: "done" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { approval: { approvalId: "approval-2", revoked: true, reason: "done" } }
    });

    await expect(runOperation("authorization.receipts.list", { context: {} }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("authorization.receipts.list", {
      input: { limit: "3", "subject-id": "subject-1" },
      context
    })).resolves.toMatchObject({ status: 200, payload: { items: [{ receiptId: "receipt-1" }], count: 1 } });
    await expect(runOperation("authorization.loan_records.list", { context }))
      .resolves.toMatchObject({ status: 200, payload: { items: [{ loanId: "loan-1" }], count: 1 } });
    await expect(runOperation("authorization.denied_requests.list", {
      input: {
        limit: "4",
        "tenant-id": "tenant-1",
        "workspace-id": "workspace-1",
        "operation-id": "workspace.write",
        "tool-id": "tool-1",
        "reason-code": "scope_denied"
      },
      context
    })).resolves.toMatchObject({ status: 200, payload: { items: [{ requestId: "denied-1" }], count: 1 } });

    await expect(runOperation("workspace.asset.policy.set", { context: {} }))
      .resolves.toMatchObject({
        status: 400,
        payload: { error: { code: "workspace_binding_invalid" } }
      });
    await expect(runOperation("workspace.asset.policy.set", {
      input: { workspaceId: "workspace-1", mode: "restricted" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { policy: { workspaceId: "workspace-1", policyId: "policy-1" } }
    });
    await expect(runOperation("workspace.asset.permission.check", { context: {} }))
      .resolves.toMatchObject({ status: 503 });
    await expect(runOperation("workspace.asset.permission.check", {
      input: { workspaceId: "workspace-1", operationId: "workspace.read" },
      context
    })).resolves.toMatchObject({
      status: 200,
      payload: { decision: { allowed: true, workspaceId: "workspace-1" } }
    });

    expect(protocolEventBus.publish).toHaveBeenCalledWith(
      "authorization.governance.updated",
      expect.objectContaining({
        mutation: expect.objectContaining({ eventType: "upserted" })
      }),
      { type: "authorization.governance.updated" }
    );
    expect(securityPermissions.listDeniedRequests).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      workspaceId: "workspace-1",
      operationId: "workspace.write",
      toolId: "tool-1",
      reasonCode: "scope_denied"
    }));
  });

});
