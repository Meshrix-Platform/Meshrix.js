import { describe, expect, it } from "vitest";

import { createPluginCallProjection } from "../../../packages/server-runtime/src/composition/plugin-call-context.mjs";

function projectedAuthority({ requestedWorkspaceId, allowedWorkspaceIds }) {
  return createPluginCallProjection({
    operation: { id: "sample_plugin.workspace.connect" },
    input: { workspaceId: requestedWorkspaceId },
    authSession: {
      user: {
        roleId: "tool-grant",
        subjectId: "grant-subject",
        tenantId: "tenant-fixture",
        allowedWorkspaceIds
      }
    },
    request: {
      __licoToolRuntimeAuthorization: {
        ok: true,
        grant: {
          id: "grant-1",
          allowedWorkspaceIds,
          metadata: { policyRevision: "policy-1" }
        },
        policy: {
          decisionId: "decision-1",
          governancePolicyRevision: { revision: "policy-1" }
        }
      }
    }
  }).workspaceAuthority;
}

describe("plugin call-bound workspace authority", () => {
  it("projects only the requested workspace when the current grant allows it", () => {
    expect(projectedAuthority({
      requestedWorkspaceId: "workspace-a",
      allowedWorkspaceIds: ["workspace-a", "workspace-b"]
    })).toEqual({ workspaceRef: "workspace-a", authorized: true });
  });

  it("denies a cross-workspace request without projecting grant workspace inventory", () => {
    const authority = projectedAuthority({
      requestedWorkspaceId: "workspace-c",
      allowedWorkspaceIds: ["workspace-a", "workspace-b"]
    });

    expect(authority).toEqual({ workspaceRef: "workspace-c", authorized: false });
    expect(authority).not.toHaveProperty("allowedWorkspaceIds");
  });

  it("projects tenant identity only as an irreversible reference", () => {
    const projection = createPluginCallProjection({
      input: { workspaceId: "workspace-a" },
      authSession: { user: { subjectId: "subject-fixture", tenantId: "tenant-fixture" } }
    });

    expect(projection.auth.tenantRef).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(projection.auth.tenantRef).not.toBe("tenant-fixture");
  });

  it("projects only the bounded active HTTP request count for plugin scheduling", () => {
    const projection = createPluginCallProjection({
      request: { __licoActiveRequestCount: 4 }
    });

    expect(projection.concurrency).toEqual({ activeHttpRequests: 4 });
    expect(createPluginCallProjection({
      request: { __licoActiveRequestCount: -1 }
    }).concurrency).toEqual({ activeHttpRequests: 0 });
  });

  it("derives an irreversible tenant boundary for tool grants without tenant metadata", () => {
    const projection = createPluginCallProjection({
      authSession: {
        user: {
          type: "tool-grant",
          roleId: "tool-grant",
          subjectId: "grant-subject"
        }
      }
    });

    expect(projection.auth.subjectRef).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(projection.auth.tenantRef).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(projection.auth.tenantRef).not.toContain("grant-subject");
  });

  it("projects only the current immutable approval binding", () => {
    const bindingDigest = "a".repeat(64);
    const projection = createPluginCallProjection({
      input: { workspaceId: "workspace-a", proposalRef: "proposal-a" },
      request: {
        __licoToolRuntimeAuthorization: {
          approvedPendingOperation: {
            pendingOperationId: "pending-a",
            operationId: "sample_plugin.output.approve",
            actorId: "approver-a",
            status: "approved",
            current: true,
            expiresAt: "2099-01-01T00:00:00.000Z",
            originalInput: { protected: "must-not-project" },
            requiredApproval: { protected: "must-not-project" },
            operationBinding: {
              bindingDigest,
              resource: {
                workspaceId: "workspace-a",
                proposalRef: "proposal-a",
                previewDigest: "b".repeat(64),
                outputDigest: "c".repeat(64),
                policyDigest: "d".repeat(64)
              },
              policyRevision: { grantPolicyRevision: 3, governancePolicyRevision: 4 }
            }
          }
        }
      }
    });

    expect(projection.approval).toEqual({
      approvalRef: "pending-a",
      operationId: "sample_plugin.output.approve",
      actorRef: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/u),
      status: "approved",
      current: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      binding: {
        workspaceId: "workspace-a",
        proposalRef: "proposal-a",
        previewDigest: "b".repeat(64),
        outputDigest: "c".repeat(64),
        policyDigest: "d".repeat(64),
        policyRevision: { grantPolicyRevision: 3, governancePolicyRevision: 4 },
        bindingDigest
      }
    });
    expect(JSON.stringify(projection)).not.toContain("must-not-project");
  });
});
