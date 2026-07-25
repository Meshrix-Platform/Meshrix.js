import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceGovernanceRegistry } from "../../../packages/agents/src/workspace-governance/index.mjs";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import { createSystemControllerWorkspaceRuntimeHandlers } from "../../../packages/protocols/http/controllers/system-controller-workspace-runtime-handlers.mjs";
import { executeAgentWorkspaceManagementOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/agent-workspace-management-executor.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function governedFixture({
  shareResult = { ok: true, workspace: { workspaceId: "workspace-target" } },
  shareThrows = false
} = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-share-governance-"));
  temporaryRoots.push(userDataPath);
  const governance = createWorkspaceGovernanceRegistry({ userDataPath });
  await governance.upsertPolicy({
    workspaceId: "workspace-source",
    organizationId: "org-a",
    projectId: "project-a",
    dataClass: "restricted",
    ownerSubjectIds: ["owner-a"],
    allowedActions: ["share"],
    copyPolicy: "withApproval"
  });
  const agentWorkspace = {
    shareWorkspace: vi.fn(() => {
      if (shareThrows) throw new Error("fixture share failure");
      return shareResult;
    }),
    unshareWorkspace: vi.fn(() => ({ ok: true, workspace: { workspaceId: "workspace-target" } }))
  };
  const context = {
    userDataPath,
    agentWorkspace,
    workspaceGovernanceRegistry: governance,
    authSession: {
      user: {
        userId: "owner-a",
        username: "owner-a",
        orgId: "org-a",
        roleId: "owner",
        scopes: ["workspace:maintain"]
      }
    }
  };
  return { agentWorkspace, context, governance, userDataPath };
}

function shareInput(patch = {}) {
  return {
    workspaceId: "workspace-source",
    targetWorkspaceId: "workspace-target",
    targetProjectId: "project-b",
    granteeId: "target-reader",
    clearance: "restricted",
    actions: ["read"],
    ...patch
  };
}

function authorizeShare(context, overrides = {}) {
  const binding = {
    actorId: "owner-a",
    operationId: "agent_workspaces.share",
    workspaceId: "workspace-source",
    targetWorkspaceId: "workspace-target",
    grantId: "owner-a",
    policyRevision: { grantPolicyRevision: 4, governancePolicyRevision: 2 }
  };
  context.operationAuthorization = {
    ok: true,
    grant: { id: "owner-a" },
    policy: {
      grantPolicyRevision: 4,
      governancePolicyRevision: { revision: 2 }
    },
    approvedPendingOperation: {
      pendingOperationId: "pending-workspace-share",
      status: "approved",
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...binding,
      ...overrides
    }
  };
}

describe("agent workspace governed sharing", () => {
  it("classifies workspace sharing as a confirmed repair write", () => {
    const operation = SERVER_API_OPERATIONS.find((entry) => entry.id === "agent_workspaces.share");
    expect(operation).toMatchObject({
      requiredScopes: ["workspace:maintain"],
      aspects: expect.arrayContaining(["workspace-governance", "share-grant"]),
      safety: {
        risk: "repair_write",
        requiresConfirmation: true,
        approvalScope: "workspace:maintain"
      }
    });
  });

  it("forwards the canonical server data root into share and unshare execution", async () => {
    const sendConsoleDomainOperation = vi.fn(async () => {});
    const agentWorkspace = {};
    const handlers = createSystemControllerWorkspaceRuntimeHandlers({
      sendConsoleDomainOperation,
      parseJsonBody: (body) => JSON.parse(body.toString("utf8")),
      protocolPayload: () => ({}),
      contextRuntime: {},
      agentWorkspace,
      userDataPath: "<user-data>"
    });
    const authSession = { user: { userId: "owner-a" } };
    const operationAuthorization = { ok: true, approvedPendingOperation: { pendingOperationId: "pending-share" } };
    const call = {
      operation: { id: "agent_workspaces.share" },
      workspaceId: "workspace-source",
      targetWorkspaceId: "workspace-target",
      requestBody: Buffer.from("{}"),
      response: {},
      authSession,
      request: { __licoToolRuntimeAuthorization: operationAuthorization }
    };

    await handlers.handleShareWorkspace(call);
    await handlers.handleUnshareWorkspace({
      ...call,
      operation: { id: "agent_workspaces.unshare" }
    });
    expect(sendConsoleDomainOperation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      context: { userDataPath: "<user-data>", agentWorkspace, authSession, operationAuthorization }
    }));
    expect(sendConsoleDomainOperation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      context: { userDataPath: "<user-data>", agentWorkspace, authSession }
    }));
  });

  it("denies before ACL mutation when the workspace policy requires an approval", async () => {
    const { agentWorkspace, context, governance } = await governedFixture();
    const response = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });

    expect(response).toMatchObject({
      status: 403,
      payload: {
        ok: false,
        governance: {
          granted: false,
          evaluation: {
            allowed: false,
            reasons: expect.arrayContaining(["copy_requires_approval"])
          }
        }
      }
    });
    expect(agentWorkspace.shareWorkspace).not.toHaveBeenCalled();
    expect((await governance.describe()).shareGrants).toEqual([]);
  });

  it("fails closed without inventing a default workspace governance policy", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-share-unconfigured-"));
    temporaryRoots.push(userDataPath);
    const agentWorkspace = { shareWorkspace: vi.fn(() => ({ ok: true })) };
    const workspaceGovernanceRegistry = createWorkspaceGovernanceRegistry({ userDataPath });
    const response = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput({ approvals: ["approval-a"] }),
      context: {
        userDataPath,
        agentWorkspace,
        workspaceGovernanceRegistry,
        authSession: { user: { userId: "owner-a", roleId: "owner" } }
      }
    });

    expect(response).toMatchObject({
      status: 403,
      payload: {
        ok: false,
        governance: {
          granted: false,
          evaluation: {
            allowed: false,
            reasons: expect.arrayContaining(["subject_not_allowed"])
          }
        }
      }
    });
    expect(agentWorkspace.shareWorkspace).not.toHaveBeenCalled();
    const described = await createWorkspaceGovernanceRegistry({ userDataPath }).describe();
    expect(described.policies).toEqual([]);
    expect(described.shareGrants).toEqual([]);
  });

  it("binds policy evaluation to the authenticated subject instead of caller-supplied identity", async () => {
    const { agentWorkspace, context } = await governedFixture();
    context.authSession.user = {
      ...context.authSession.user,
      userId: "intruder-a",
      username: "intruder-a",
      roleId: "member"
    };
    const response = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput({
        approvals: ["approval-a"],
        actor: "owner-a",
        subject: { subjectId: "owner-a" }
      }),
      context
    });

    expect(response).toMatchObject({
      status: 403,
      payload: {
        governance: {
          evaluation: {
            subject: { subjectId: "intruder-a" },
            reasons: expect.arrayContaining(["subject_not_allowed"])
          }
        }
      }
    });
    expect(agentWorkspace.shareWorkspace).not.toHaveBeenCalled();
  });

  it("persists a grant before sharing and closes it after unshare", async () => {
    const { agentWorkspace, context, governance } = await governedFixture();
    authorizeShare(context);
    const shared = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });

    expect(shared).toMatchObject({
      status: 200,
      payload: {
        ok: true,
        governance: {
          granted: true,
          shareGrant: {
            workspaceId: "workspace-source",
            targetWorkspaceId: "workspace-target",
            granteeId: "target-reader"
          }
        }
      }
    });
    expect(agentWorkspace.shareWorkspace).toHaveBeenCalledOnce();
    expect((await governance.describe()).shareGrants).toHaveLength(1);

    const unshared = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.unshare",
      input: shareInput({ reason: "access_removed" }),
      context
    });
    expect(unshared).toMatchObject({
      status: 200,
      payload: {
        ok: true,
        governance: {
          revocation: { revoked: true, revokedCount: 1 }
        }
      }
    });
    expect(agentWorkspace.unshareWorkspace).toHaveBeenCalledOnce();
    const afterUnshare = await governance.describe();
    expect(afterUnshare.shareGrants).toEqual([]);
    expect(afterUnshare.auditEvents.at(-1)?.eventType).toBe("workspace_governance.unshare_reconciled");
  });

  it("keeps the requester and approval actor as distinct trusted roles", async () => {
    const { agentWorkspace, context } = await governedFixture();
    expect(context.authSession.user.userId).toBe("owner-a");
    authorizeShare(context, { actorId: "approver-b" });

    const shared = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });

    expect(shared).toMatchObject({
      status: 200,
      payload: {
        ok: true,
        governance: { granted: true }
      }
    });
    expect(context.operationAuthorization.approvedPendingOperation.actorId).toBe("approver-b");
    expect(agentWorkspace.shareWorkspace).toHaveBeenCalledOnce();
  });

  it("persists and idempotently reconciles an incomplete unshare without repeating ACL removal", async () => {
    const { agentWorkspace, context, governance } = await governedFixture();
    authorizeShare(context);
    await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });
    const complete = governance.completeIncompleteUnshare.bind(governance);
    let failOnce = true;
    context.workspaceGovernanceRegistry = {
      ...governance,
      async completeIncompleteUnshare(input) {
        if (failOnce) {
          failOnce = false;
          throw new Error("fixture reconciliation interruption");
        }
        return complete(input);
      }
    };
    const input = shareInput({ reason: "access_removed", idempotencyKey: "unshare:fixture" });
    const interrupted = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.unshare",
      input,
      context
    });
    expect(interrupted).toMatchObject({
      status: 500,
      payload: { ok: false, accessRemoved: true, governance: { incompleteUnshareRef: expect.any(String) } }
    });
    expect(agentWorkspace.unshareWorkspace).toHaveBeenCalledOnce();
    expect((await governance.describe()).incompleteUnshares).toHaveLength(1);
    expect((await governance.describe()).shareGrants).toHaveLength(1);

    const reconciled = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.unshare",
      input,
      context
    });
    expect(reconciled).toMatchObject({
      status: 200,
      payload: {
        ok: true,
        accessAlreadyRemoved: true,
        governance: { reconciled: true, revocation: { completed: true, revoked: true } }
      }
    });
    expect(agentWorkspace.unshareWorkspace).toHaveBeenCalledOnce();
    const finalState = await governance.describe();
    expect(finalState.incompleteUnshares).toEqual([]);
    expect(finalState.shareGrants).toEqual([]);
  });

  it("does not mutate the ACL when the durable unshare intent cannot be written", async () => {
    const { agentWorkspace, context, governance } = await governedFixture();
    authorizeShare(context);
    await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });
    context.workspaceGovernanceRegistry = {
      ...governance,
      async recordIncompleteUnshare() {
        throw new Error("fixture intent persistence failure");
      }
    };

    const response = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.unshare",
      input: shareInput({ idempotencyKey: "unshare:intent-write-failure" }),
      context
    });

    expect(response).toMatchObject({ status: 503, payload: { ok: false, accessRemoved: false } });
    expect(agentWorkspace.unshareWorkspace).not.toHaveBeenCalled();
    expect((await governance.describe()).shareGrants).toHaveLength(1);
    expect((await governance.describe()).incompleteUnshares).toEqual([]);
  });

  it("restarts an in-progress ACL stage idempotently after interruption and converges", async () => {
    const { agentWorkspace, context, governance, userDataPath } = await governedFixture();
    authorizeShare(context);
    await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });
    const aclRecipients = new Set(["workspace-target"]);
    let actualAclRemovals = 0;
    let interruptAfterMutation = true;
    agentWorkspace.unshareWorkspace.mockImplementation((_workspaceId, targetWorkspaceId) => {
      if (aclRecipients.delete(targetWorkspaceId)) actualAclRemovals += 1;
      if (interruptAfterMutation) {
        interruptAfterMutation = false;
        throw new Error("fixture process interruption after ACL mutation");
      }
      return { ok: true, workspace: { workspaceId: targetWorkspaceId } };
    });
    const input = shareInput({ idempotencyKey: "unshare:acl-restart" });

    const interrupted = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.unshare",
      input,
      context
    });
    expect(interrupted).toMatchObject({ status: 500, payload: { ok: false, accessRemoved: false } });
    expect(actualAclRemovals).toBe(1);
    expect((await governance.describe()).incompleteUnshares[0]?.stage).toBe("acl_removal_in_progress");

    const restartedGovernance = createWorkspaceGovernanceRegistry({ userDataPath });
    const restarted = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.unshare",
      input,
      context: { ...context, workspaceGovernanceRegistry: restartedGovernance }
    });
    expect(restarted).toMatchObject({ status: 200, payload: { ok: true, governance: { reconciled: true } } });
    expect(actualAclRemovals).toBe(1);
    expect((await restartedGovernance.describe()).incompleteUnshares).toEqual([]);
    expect((await restartedGovernance.describe()).shareGrants).toEqual([]);
  });

  it("serializes concurrent duplicate unshare requests without stage regression or lost grants", async () => {
    const { agentWorkspace, context, governance, userDataPath } = await governedFixture();
    authorizeShare(context);
    await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });
    const aclRecipients = new Set(["workspace-target"]);
    let actualAclRemovals = 0;
    agentWorkspace.unshareWorkspace.mockImplementation((_workspaceId, targetWorkspaceId) => {
      if (aclRecipients.delete(targetWorkspaceId)) actualAclRemovals += 1;
      return { ok: true, workspace: { workspaceId: targetWorkspaceId } };
    });
    const input = shareInput({ idempotencyKey: "unshare:concurrent-duplicate" });

    const responses = await Promise.all([
      executeAgentWorkspaceManagementOperation({ operationId: "agent_workspaces.unshare", input, context }),
      executeAgentWorkspaceManagementOperation({ operationId: "agent_workspaces.unshare", input, context })
    ]);

    expect(responses.every((response) => response.status === 200 && response.payload.ok === true)).toBe(true);
    expect(actualAclRemovals).toBe(1);
    const restarted = createWorkspaceGovernanceRegistry({ userDataPath });
    const state = await restarted.describe();
    expect(state.incompleteUnshares).toEqual([]);
    expect(state.shareGrants).toEqual([]);
    expect(state.auditEvents.filter((event) => event.eventType === "workspace_governance.unshare_intent_persisted")).toHaveLength(1);
    expect(state.auditEvents.filter((event) => event.eventType === "workspace_governance.unshare_reconciled")).toHaveLength(1);
  });

  it("compensates the grant when the ACL mutation fails", async () => {
    const { context, governance } = await governedFixture({ shareThrows: true });
    authorizeShare(context);
    const response = await executeAgentWorkspaceManagementOperation({
      operationId: "agent_workspaces.share",
      input: shareInput(),
      context
    });

    expect(response).toMatchObject({
      status: 400,
      payload: {
        ok: false,
        governance: { granted: true, compensated: true }
      }
    });
    const afterFailure = await governance.describe();
    expect(afterFailure.shareGrants).toEqual([]);
    expect(afterFailure.auditEvents.at(-1)).toMatchObject({
      eventType: "workspace_governance.share_revoked",
      payload: { reason: "workspace_share_mutation_failed", revokedCount: 1 }
    });
  });

  it("rejects replayed and cross-workspace approval facts before ACL mutation", async () => {
    for (const approvalPatch of [
      { status: "completed" },
      { workspaceId: "workspace-other" },
      { grantId: "grant-other" },
      { policyRevision: { grantPolicyRevision: 3, governancePolicyRevision: 2 } }
    ]) {
      const { agentWorkspace, context } = await governedFixture();
      authorizeShare(context, approvalPatch);
      const response = await executeAgentWorkspaceManagementOperation({
        operationId: "agent_workspaces.share",
        input: shareInput(),
        context
      });
      expect(response.status).toBe(403);
      expect(agentWorkspace.shareWorkspace).not.toHaveBeenCalled();
    }
  });
});
