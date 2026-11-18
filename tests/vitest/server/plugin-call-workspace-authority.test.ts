import { describe, expect, it } from "vitest";

import { createPluginCallProjection } from "../../../packages/server-runtime/src/composition/plugin-call-context.ts";

function projectedAuthority({ requestedWorkspaceId, allowedWorkspaceIds }: Record<string, any>) : any {
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
      __meshrixToolRuntimeAuthorization: {
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

describe("plugin call-bound workspace authority", () : any => {
  it("projects only the requested workspace when the current grant allows it", () : any => {
    expect(projectedAuthority({
      requestedWorkspaceId: "workspace-a",
      allowedWorkspaceIds: ["workspace-a", "workspace-b"]
    })).toEqual({ workspaceRef: "workspace-a", authorized: true });
  });

  it("denies a cross-workspace request without projecting grant workspace inventory", () : any => {
    const authority: any = projectedAuthority({
      requestedWorkspaceId: "workspace-c",
      allowedWorkspaceIds: ["workspace-a", "workspace-b"]
    });

    expect(authority).toEqual({ workspaceRef: "workspace-c", authorized: false });
    expect(authority).not.toHaveProperty("allowedWorkspaceIds");
  });

  it("projects tenant identity only as an irreversible reference", () : any => {
    const projection: any = createPluginCallProjection({
      input: { workspaceId: "workspace-a" },
      authSession: { user: { subjectId: "subject-fixture", tenantId: "tenant-fixture" } }
    });

    expect(projection.auth.tenantRef).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(projection.auth.tenantRef).not.toBe("tenant-fixture");
  });

  it("projects only the bounded active HTTP request count for plugin scheduling", () : any => {
    const projection: any = createPluginCallProjection({
      request: { __meshrixActiveRequestCount: 4 }
    });

    expect(projection.concurrency).toEqual({ activeHttpRequests: 4 });
    expect(createPluginCallProjection({
      request: { __meshrixActiveRequestCount: -1 }
    }).concurrency).toEqual({ activeHttpRequests: 0 });
  });

  it("derives an irreversible tenant boundary for tool grants without tenant metadata", () : any => {
    const projection: any = createPluginCallProjection({
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

  it("projects only the current immutable approval binding", () : any => {
    const bindingDigest: any = "a".repeat(64);
    const projection: any = createPluginCallProjection({
      input: { workspaceId: "workspace-a", proposalRef: "proposal-a" },
      request: {
        __meshrixToolRuntimeAuthorization: {
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
