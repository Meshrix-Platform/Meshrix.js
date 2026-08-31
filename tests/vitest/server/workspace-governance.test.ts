import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceGovernanceRegistry,
  normalizeWorkspaceGovernancePolicy,
  WORKSPACE_GOVERNANCE_PROTOCOL_VERSION
} from "../../../packages/agents/src/workspace-governance/index.ts";
import { PLATFORM_CONSOLE_OPERATION_DEFINITIONS } from "../../../packages/contracts/src/operations/platform-console-operation-definitions.ts";
import { executeWorkspaceGovernanceOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/runtime-admin-executors.ts";

async function withRegistry(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-governance-extra-"));
  const registry: any = createWorkspaceGovernanceRegistry({ userDataPath });
  try {
    await testCase({ registry, userDataPath });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function canonicalApproval(overrides: Record<string, any> = {}) : any {
  const binding: Record<string, any> = {
    actorId: "analyst-a",
    operationId: "agent_workspaces.share",
    workspaceId: "workspace-alpha",
    targetWorkspaceId: "workspace-beta",
    grantId: "grant-alpha",
    policyRevision: { grantPolicyRevision: 7, governancePolicyRevision: 3 }
  };
  return {
    approvalBinding: binding,
    approvalFact: {
      pendingOperationId: "pending-share-alpha",
      status: "approved",
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...binding,
      ...overrides
    }
  };
}

describe("workspace governance normalization and binding", () : any => {
  it("normalizes an explicitly bound policy without inventing configuration", () : any => {
    const normalized: any = normalizeWorkspaceGovernancePolicy({
      workspaceId: "  ws-1  ",
      organizationId: " org-1 ",
      projectId: "",
      dataClass: "not-a-class",
      copyPolicy: "invalid-copy-policy",
      ownerSubjectIds: ["owner-a", "owner-a", " "],
      allowedSubjectIds: ["allowed-a", "allowed-a"],
      externalCollaboratorIds: ["external-a", "external-a"],
      allowedActions: ["read", "read", ""],
      retention: {
        ttlDays: "14",
        retainUntil: "",
        disposalAction: "",
        archiveBeforeDispose: false
      },
      legalHold: {
        enabled: true,
        holdIds: ["hold-a", "hold-a", ""],
        reason: " litigation ",
        retainUntilReleased: false
      },
      metadata: {
        notes: "kept"
      }
    });

    expect(normalized).toMatchObject({
      protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
      workspaceId: "ws-1",
      organizationId: "org-1",
      projectId: "",
      dataClass: "internal",
      copyPolicy: "sameProject",
      ownerSubjectIds: ["owner-a"],
      allowedSubjectIds: ["allowed-a"],
      externalCollaboratorIds: ["external-a"],
      allowedActions: ["read"],
      retention: {
        policyId: "default",
        ttlDays: 14,
        retainUntil: "",
        disposalAction: "review",
        archiveBeforeDispose: false
      },
      legalHold: {
        enabled: true,
        holdIds: ["hold-a"],
        reason: "litigation",
        retainUntilReleased: false
      },
      metadata: {
        notes: "kept"
      }
    });

  });

  it("rejects missing, aliased, non-string, and malformed workspace bindings", () : any => {
    for (const input of [
      {},
      { workspace: "workspace-alpha" },
      { workspaceId: 42 },
      { workspaceId: "   " },
      { workspaceId: "workspace-\u0000alpha" }
    ]) {
      expect(() : any => normalizeWorkspaceGovernancePolicy(input)).toThrow(
        expect.objectContaining({ code: "workspace_binding_invalid" })
      );
    }
  });
});

describe("workspace governance registry CRUD and persistence", () : any => {
  it("creates policies, records audit events, and reloads persisted state", async () : Promise<any> => {
    await withRegistry(async ({ registry, userDataPath }: Record<string, any>) : Promise<any> => {
      const created: any = await registry.upsertPolicy({
          workspaceId: "workspace-alpha",
          organizationId: "org-alpha",
          projectId: "project-alpha",
          dataClass: "confidential",
          allowedSubjectIds: ["analyst-a"],
          ownerSubjectIds: ["owner-a"],
          allowedActions: ["discover", "read", "copy", "share", "export", "delete"],
          copyPolicy: "withApproval",
          exportAllowed: false,
          checkoutAllowed: false,
          retention: {
            policyId: "ret-1",
            retainUntil: "2026-01-01T00:00:00.000Z",
            disposalAction: "review"
          },
          legalHold: {
            enabled: false
          }
      });

      expect(created.protocolVersion).toBe(WORKSPACE_GOVERNANCE_PROTOCOL_VERSION);
      expect(created.policy).toMatchObject({
        workspaceId: "workspace-alpha",
        organizationId: "org-alpha",
        projectId: "project-alpha",
        dataClass: "confidential",
        copyPolicy: "withApproval"
      });
      expect(created.audit).toMatchObject({
        eventType: "workspace_governance.policy.upserted",
        workspaceId: "workspace-alpha"
      });

      const described: any = await registry.describe();
      expect(described).toMatchObject({
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        policies: [
          expect.objectContaining({
            workspaceId: "workspace-alpha",
            organizationId: "org-alpha"
          })
        ]
      });
      expect(described.auditEvents).toHaveLength(1);

      const persisted: any = createWorkspaceGovernanceRegistry({ userDataPath });
      const reloaded: any = await persisted.describe();
      expect(reloaded.policies).toHaveLength(1);
      expect(reloaded.policies[0]).toMatchObject({
        workspaceId: "workspace-alpha",
        projectId: "project-alpha",
        dataClass: "confidential"
      });
      expect(reloaded.auditEvents[0]).toMatchObject({
        eventType: "workspace_governance.policy.upserted",
        workspaceId: "workspace-alpha"
      });
    });
  });
});

describe("workspace governance permission checks", () : any => {
  it("allows and denies actions based on subject scope, clearance, approval, and legal hold", async () : Promise<any> => {
    await withRegistry(async ({ registry }: Record<string, any>) : Promise<any> => {
      await registry.upsertPolicy({
          workspaceId: "workspace-alpha",
          organizationId: "org-alpha",
          projectId: "project-alpha",
          dataClass: "confidential",
          ownerSubjectIds: ["owner-a"],
          allowedSubjectIds: ["analyst-a"],
          externalCollaboratorIds: ["external-a"],
          allowedActions: ["discover", "read", "cite", "copy", "share", "delete", "export", "checkout", "retention.dispose"],
          copyPolicy: "withApproval",
          exportAllowed: false,
          checkoutAllowed: false,
          retention: {
            policyId: "ret-1",
            retainUntil: "2025-01-01T00:00:00.000Z",
            disposalAction: "review"
          },
          legalHold: {
            enabled: true
          }
      });

      const allowed: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "read",
        subject: {
          subjectId: "analyst-a",
          organizationId: "org-alpha",
          clearance: "confidential"
        },
        now: "2024-12-31T00:00:00.000Z"
      });
      expect(allowed.allowed).toBe(true);
      expect(allowed.reasons).toEqual([]);

      const deniedByScope: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "read",
        subject: {
          subjectId: "intruder-a",
          organizationId: "org-alpha",
          clearance: "secret"
        }
      });
      expect(deniedByScope.allowed).toBe(false);
      expect(deniedByScope.reasons).toContain("subject_not_allowed");

      const deniedByClearance: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "read",
        subject: {
          subjectId: "analyst-a",
          organizationId: "org-alpha",
          clearance: "internal"
        }
      });
      expect(deniedByClearance.allowed).toBe(false);
      expect(deniedByClearance.reasons).toContain("insufficient_data_class_clearance");

      const deniedByExport: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "export",
        subject: {
          subjectId: "analyst-a",
          organizationId: "org-alpha",
          clearance: "secret"
        }
      });
      expect(deniedByExport.allowed).toBe(false);
      expect(deniedByExport.reasons).toContain("export_not_allowed");

      const deniedByHold: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "delete",
        subject: {
          subjectId: "owner-a",
          organizationId: "org-alpha",
          clearance: "secret"
        }
      });
      expect(deniedByHold.allowed).toBe(false);
      expect(deniedByHold.reasons).toContain("legal_hold_blocks_destructive_action");

      const deniedByApproval: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "copy",
        targetWorkspaceId: "workspace-beta",
        targetProjectId: "project-beta",
        subject: {
          subjectId: "analyst-a",
          organizationId: "org-alpha",
          clearance: "confidential"
        }
      });
      expect(deniedByApproval.allowed).toBe(false);
      expect(deniedByApproval.reasons).toContain("copy_requires_approval");

      const callerClaimedApproval: any = await registry.evaluate({
        workspaceId: "workspace-alpha",
        action: "copy",
        targetWorkspaceId: "workspace-beta",
        targetProjectId: "project-beta",
        approvals: ["approval-1"],
        subject: {
          subjectId: "analyst-a",
          organizationId: "org-alpha",
          clearance: "confidential"
        }
      });
      expect(callerClaimedApproval.allowed).toBe(false);
      expect(callerClaimedApproval.reasons).toContain("copy_requires_approval");
    });
  });
});

describe("workspace governance share grants", () : any => {
  it("creates grants only when policy allows them and keeps denied requests ephemeral", async () : Promise<any> => {
    await withRegistry(async ({ registry, userDataPath }: Record<string, any>) : Promise<any> => {
      await registry.upsertPolicy({
          workspaceId: "workspace-alpha",
          organizationId: "org-alpha",
          projectId: "project-alpha",
          dataClass: "restricted",
          ownerSubjectIds: ["owner-a"],
          allowedSubjectIds: ["analyst-a"],
          externalCollaboratorIds: ["external-a"],
          allowedActions: ["discover", "read", "cite", "share"],
          copyPolicy: "withApproval",
          exportAllowed: false,
          checkoutAllowed: false
      });

      const denied: any = await registry.createShareGrant({
        workspaceId: "workspace-alpha",
        action: "share",
        targetWorkspaceId: "workspace-beta",
        targetProjectId: "project-beta",
        subject: {
          subjectId: "intruder-a",
          organizationId: "org-alpha",
          clearance: "restricted"
        }
      });
      expect(denied.granted).toBe(false);
      expect(denied.evaluation.allowed).toBe(false);
      expect(denied.evaluation.reasons).toContain("subject_not_allowed");

      const granted: any = await registry.createShareGrant({
        workspaceId: "workspace-alpha",
        action: "share",
        targetWorkspaceId: "workspace-beta",
        targetProjectId: "project-beta",
        granteeId: "analyst-b",
        actions: ["read", "cite"],
        expiresAt: "2026-12-31T00:00:00.000Z",
        subject: {
          subjectId: "analyst-a",
          organizationId: "org-alpha",
          clearance: "restricted"
        }
      }, canonicalApproval());

      expect(granted).toMatchObject({
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        granted: true,
        shareGrant: {
          workspaceId: "workspace-alpha",
          organizationId: "org-alpha",
          projectId: "project-alpha",
          granteeId: "analyst-b",
          targetWorkspaceId: "workspace-beta",
          actions: ["read", "cite"],
          dataClass: "restricted",
          expiresAt: "2026-12-31T00:00:00.000Z"
        },
        audit: {
          eventType: "workspace_governance.share_granted",
          workspaceId: "workspace-alpha"
        }
      });

      const described: any = await registry.describe();
      expect(described.shareGrants).toHaveLength(1);
      expect(described.auditEvents.map((event?: any) : any => event.eventType)).toEqual([
        "workspace_governance.policy.upserted",
        "workspace_governance.share_granted"
      ]);

      const persisted: any = createWorkspaceGovernanceRegistry({ userDataPath });
      const reloaded: any = await persisted.describe();
      expect(reloaded.shareGrants).toHaveLength(1);
      expect(reloaded.shareGrants[0]).toMatchObject({
        workspaceId: "workspace-alpha",
        granteeId: "analyst-b",
        targetWorkspaceId: "workspace-beta"
      });

      const revoked: any = await persisted.revokeShareGrants({
        workspaceId: "workspace-alpha",
        targetWorkspaceId: "workspace-beta",
        granteeId: "analyst-b",
        actorId: "analyst-a",
        reason: "access_removed"
      });
      expect(revoked).toMatchObject({
        revoked: true,
        revokedCount: 1,
        audit: {
          eventType: "workspace_governance.share_revoked",
          workspaceId: "workspace-alpha"
        }
      });
      const afterRevoke: any = await persisted.describe();
      expect(afterRevoke.shareGrants).toEqual([]);
      expect(afterRevoke.auditEvents.at(-1)).toMatchObject({
        eventType: "workspace_governance.share_revoked",
        payload: { revokedCount: 1 }
      });
    });
  });

  it("rejects stale, replayed, and cross-bound Operation Permission approval facts", async () : Promise<any> => {
    await withRegistry(async ({ registry }: Record<string, any>) : Promise<any> => {
      await registry.upsertPolicy({
        workspaceId: "workspace-alpha",
        organizationId: "org-alpha",
        projectId: "project-alpha",
        dataClass: "restricted",
        allowedSubjectIds: ["analyst-a"],
        allowedActions: ["share"],
        copyPolicy: "withApproval"
      });
      const input: Record<string, any> = {
        workspaceId: "workspace-alpha",
        targetWorkspaceId: "workspace-beta",
        targetProjectId: "project-beta",
        subject: { subjectId: "analyst-a", organizationId: "org-alpha", clearance: "restricted" }
      };
      const cases: any[] = [
        [canonicalApproval({ expiresAt: "2020-01-01T00:00:00.000Z" }), "approval_stale"],
        [canonicalApproval({ status: "completed" }), "approval_replayed"],
        [canonicalApproval({ targetWorkspaceId: "workspace-other" }), "approval_binding_mismatch"],
        [canonicalApproval({ policyRevision: { grantPolicyRevision: 6, governancePolicyRevision: 3 } }), "approval_policy_revision_mismatch"]
      ];
      for (const [approval, reason] of cases) {
        const denied: any = await registry.createShareGrant(input, approval);
        expect(denied.granted).toBe(false);
        expect(denied.evaluation.reasons).toContain(reason);
      }
      expect((await registry.describe()).shareGrants).toEqual([]);
    });
  });

  it("accepts an explicitly bound current unversioned approval snapshot", async () : Promise<any> => {
    await withRegistry(async ({ registry }: Record<string, any>) : Promise<any> => {
      await registry.upsertPolicy({
        workspaceId: "workspace-alpha",
        organizationId: "org-alpha",
        projectId: "project-alpha",
        dataClass: "restricted",
        allowedSubjectIds: ["analyst-a"],
        allowedActions: ["share"],
        copyPolicy: "withApproval"
      });
      const approval: any = canonicalApproval();
      approval.approvalBinding.policyRevision = { grantPolicyRevision: 0, governancePolicyRevision: 0 };
      approval.approvalFact.policyRevision = { grantPolicyRevision: 0, governancePolicyRevision: 0 };
      const result: any = await registry.createShareGrant({
        workspaceId: "workspace-alpha",
        targetWorkspaceId: "workspace-beta",
        targetProjectId: "project-beta",
        subject: { subjectId: "analyst-a", organizationId: "org-alpha", clearance: "restricted" }
      }, approval);
      expect(result.granted).toBe(true);
    });
  });
});

describe("workspace governance invalid input boundaries", () : any => {
  it("rejects missing source and target bindings without persisting audit state", async () : Promise<any> => {
    await withRegistry(async ({ registry }: Record<string, any>) : Promise<any> => {
      await expect(registry.evaluate({
        action: "read",
        subject: {
          subjectId: "subject-a",
          organizationId: "org-alpha",
          clearance: "internal"
        }
      })).rejects.toMatchObject({ code: "workspace_binding_invalid" });

      await expect(registry.createShareGrant({
        targetWorkspaceId: "workspace-beta",
        subject: {
          subjectId: "subject-a",
          organizationId: "org-alpha",
          clearance: "internal"
        }
      })).rejects.toMatchObject({ code: "workspace_binding_invalid" });

      await expect(registry.createShareGrant({
        workspaceId: "workspace-alpha",
        subject: {
          subjectId: "subject-a",
          organizationId: "org-alpha",
          clearance: "internal"
        }
      })).rejects.toMatchObject({ code: "workspace_binding_invalid" });

      await expect(registry.upsertPolicy({
        policy: { workspaceId: "workspace-alpha" }
      })).rejects.toMatchObject({ code: "workspace_binding_invalid" });

      await expect(registry.recordIncompleteUnshare({
        workspaceId: "workspace-alpha",
        targetWorkspaceId: 42,
        idempotencyKey: "unshare-alpha"
      })).rejects.toMatchObject({ code: "workspace_binding_invalid" });

      const missingRevocation: any = await registry.revokeShareGrants({
        shareGrantId: "missing-grant"
      });
      expect(missingRevocation).toMatchObject({
        revoked: false,
        revokedCount: 0,
        audit: null
      });

      const described: any = await registry.describe();
      expect(described).toMatchObject({
        protocolVersion: WORKSPACE_GOVERNANCE_PROTOCOL_VERSION,
        policies: [],
        shareGrants: []
      });
      expect(described.auditEvents).toEqual([]);
    });
  });
});

describe("workspace governance protocol binding boundaries", () : any => {
  it("declares source and target bindings in the public operation contracts", () : any => {
    const operations: Map<string, any> = new Map(
      PLATFORM_CONSOLE_OPERATION_DEFINITIONS.map((operation?: any) : any => [operation.id, operation])
    );
    expect(operations.get("workspace_governance.policy.set")?.inputSchema?.required).toEqual(["workspaceId"]);
    expect(operations.get("workspace_governance.evaluate")?.inputSchema?.required).toEqual(["workspaceId"]);
    expect(operations.get("workspace_governance.share_grant")?.inputSchema?.required).toEqual([
      "workspaceId",
      "targetWorkspaceId"
    ]);
  });

  it("rejects invalid bindings before a governance provider method can run", async () : Promise<any> => {
    const calls: string[] = [];
    const context: Record<string, any> = {
      workspaceGovernanceRegistry: {
        describe: async () : Promise<any> => {
          calls.push("describe");
          return { policies: [] };
        },
        upsertPolicy: async () : Promise<any> => {
          calls.push("upsertPolicy");
          return {};
        },
        evaluate: async () : Promise<any> => {
          calls.push("evaluate");
          return {};
        },
        createShareGrant: async () : Promise<any> => {
          calls.push("createShareGrant");
          return {};
        }
      }
    };
    const cases: any[] = [
      ["workspace_governance.policy.set", { workspace: "workspace-alpha" }],
      ["workspace_governance.evaluate", { workspaceId: "   " }],
      ["workspace_governance.share_grant", { workspaceId: "workspace-alpha" }]
    ];
    for (const [operationId, input] of cases) {
      const response: any = await executeWorkspaceGovernanceOperation({ operationId, input, context });
      expect(response).toMatchObject({
        status: 400,
        payload: { error: { code: "workspace_binding_invalid" } }
      });
    }
    expect(calls).toEqual([]);

    const overview: any = await executeWorkspaceGovernanceOperation({
      operationId: "workspace_governance.describe",
      input: {},
      context
    });
    expect(overview.status).toBe(200);
    expect(calls).toEqual(["describe"]);
  });
});
