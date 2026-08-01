import { describe, expect, it, vi } from "vitest";

import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import {
  STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
  createStrategyManagementProvider
} from "../../../packages/server-runtime/src/composition/strategy-management-provider.ts";

const STRATEGY_OPERATION_IDS: any = SERVER_API_OPERATIONS
  .filter((operation?: any) : any => operation.id.startsWith("strategy."))
  .map((operation?: any) : any => operation.id)
  .sort();

function stableDecision(value?: any) : any {
  const { decisionId, createdAt, ...semantic } = value;
  return semantic;
}

function createProvider(overrides: Record<string, any> = {}) : any {
  let sequence: any = 0;
  return createStrategyManagementProvider({
    createDecisionId: (policyType?: any) : any => `${policyType}-${++sequence}`,
    now: () : any => "2026-01-01T00:00:00.000Z",
    ...overrides
  });
}

describe("strategy management provider", () : any => {
  it("publishes only the six read-only preview capabilities", () : any => {
    const provider: any = createProvider();

    expect(provider.describe()).toEqual({
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
      capabilities: STRATEGY_OPERATION_IDS
    });
    expect(Object.keys(provider).sort()).toEqual([
      "describe",
      "evaluateAgentPolicy",
      "evaluateQueuePolicy",
      "evaluateRoutePolicy",
      "evaluateToolPolicy",
      "evaluateWorkflowPolicy",
      "protocolVersion"
    ].sort());
  });

  it("requires explicit policy identities and does not fabricate optional policy values", () : any => {
    const provider: any = createProvider();

    expect(() : any => provider.evaluateWorkflowPolicy({})).toThrow("workflowId");
    expect(() : any => provider.evaluateAgentPolicy({})).toThrow("roleId");
    expect(() : any => provider.evaluateRoutePolicy({})).toThrow("routeId");
    expect(() : any => provider.evaluateQueuePolicy({ queueDefinitionId: "queue.jobs" })).toThrow("operationId");

    const queueDecision: any = provider.evaluateQueuePolicy({
      queueDefinitionId: "queue.jobs",
      operationId: "jobs.create"
    });
    expect(queueDecision).not.toHaveProperty("priority");
    expect(queueDecision).not.toHaveProperty("maxAttempts");
    expect(queueDecision).not.toHaveProperty("backpressureStrategy");
    expect(queueDecision).not.toHaveProperty("policyVersion");
  });

  it("normalizes equivalent input while preserving semantic changes", () : any => {
    const provider: any = createProvider();

    const workflow: any = stableDecision(provider.evaluateWorkflowPolicy({
      workflowId: "workflow-a",
      risk: "repair_write"
    }));
    const equivalent: any = stableDecision(provider.evaluateWorkflowPolicy({
      workflowId: "  workflow-a  ",
      risk: " repair_write "
    }));
    const changed: any = stableDecision(provider.evaluateWorkflowPolicy({
      workflowId: "workflow-a",
      risk: "read_only"
    }));

    expect(equivalent).toEqual(workflow);
    expect(changed).not.toEqual(workflow);
    expect(workflow.effect).toBe("require_confirmation");
    expect(changed.effect).toBe("allow");
  });

  it("uses Operation Permission once and exposes only the bounded public tool decision", async () : Promise<any> => {
    const preview: any = vi.fn(async () : Promise<any> => ({
      allowed: false,
      effect: "deny",
      toolId: "meshrix.jobs.delete",
      reasonCode: "missing_required_scope",
      redactedReason: "Required authorization is unavailable.",
      missingScopes: ["jobs:write", "jobs:write"],
      missingToolsets: ["jobs"],
      evaluatedLayers: ["grant", "governance"],
      governancePolicyRevision: {
        protocolVersion: `policy-${"x".repeat(400)}`,
        revision: 7,
        updatedAt: "2026-01-01T00:00:00.000Z",
        subject: { id: "nested-private-subject" },
        policyBody: { private: true }
      },
      grantId: "internal-grant",
      profileId: "internal-profile",
      subject: { type: "user", id: "internal-subject" },
      effectivePolicySnapshot: { internal: true },
      context: { secret: "internal" }
    }));
    const provider: any = createProvider({
      getOperationPermissionPlatform: () : any => ({ policyEngine: { preview } })
    });

    const decision: any = await provider.evaluateToolPolicy({
      toolId: "  meshrix.jobs.delete  ",
      grantId: "grant-reference"
    });

    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith({
      toolId: "meshrix.jobs.delete",
      grantId: "grant-reference"
    });
    expect(decision).toMatchObject({
      policyType: "tool-policy",
      allowed: false,
      effect: "deny",
      toolId: "meshrix.jobs.delete",
      reasonCode: "missing_required_scope",
      missingScopes: ["jobs:write"],
      governancePolicyRevision: {
        protocolVersion: `policy-${"x".repeat(249)}`,
        revision: 7,
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    });
    for (const privateField of ["grantId", "profileId", "subject", "effectivePolicySnapshot", "context"]) {
      expect(decision).not.toHaveProperty(privateField);
    }
    expect(decision.governancePolicyRevision).not.toHaveProperty("subject");
    expect(decision.governancePolicyRevision).not.toHaveProperty("policyBody");
    expect(decision.governancePolicyRevision.protocolVersion).toHaveLength(256);
  });

  it("bounds public tool-decision lists and scalar text", async () : Promise<any> => {
    const provider: any = createProvider({
      getOperationPermissionPlatform: () : any => ({
        policyEngine: {
          preview: async () : Promise<any> => ({
            effect: "deny",
            reasonCode: "r".repeat(400),
            redactedReason: "m".repeat(400),
            missingScopes: Array.from({ length: 30 }, (_?: any, index?: any) : any => `scope-${String(index).padStart(2, "0")}`),
            missingToolsets: ["t".repeat(400)],
            evaluatedLayers: Array.from({ length: 30 }, (_?: any, index?: any) : any => `layer-${String(index).padStart(2, "0")}`)
          })
        }
      })
    });

    const decision: any = await provider.evaluateToolPolicy({ toolId: "meshrix.jobs.delete" });

    expect(decision.reasonCode).toHaveLength(256);
    expect(decision.redactedReason).toHaveLength(256);
    expect(decision.missingScopes).toHaveLength(16);
    expect(decision.evaluatedLayers).toHaveLength(16);
    expect(decision.missingToolsets).toHaveLength(1);
    expect(decision.missingToolsets[0]).toHaveLength(256);
  });

  it("returns a bounded denial when Operation Permission preview is unavailable", async () : Promise<any> => {
    const decision: any = await createProvider().evaluateToolPolicy({ toolId: "meshrix.jobs.delete" });

    expect(decision).toMatchObject({
      policyType: "tool-policy",
      allowed: false,
      effect: "deny",
      reasonCode: "authorization_provider_unavailable"
    });
  });
});
