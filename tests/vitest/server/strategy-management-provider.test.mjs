import { describe, expect, it, vi } from "vitest";

import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import {
  STRATEGY_MANAGEMENT_PROTOCOL_VERSION,
  createStrategyManagementProvider
} from "../../../packages/server-runtime/src/composition/strategy-management-provider.mjs";

const STRATEGY_OPERATION_IDS = SERVER_API_OPERATIONS
  .filter((operation) => operation.id.startsWith("strategy."))
  .map((operation) => operation.id)
  .sort();

function stableDecision(value) {
  const { decisionId, createdAt, ...semantic } = value;
  return semantic;
}

function createProvider(overrides = {}) {
  let sequence = 0;
  return createStrategyManagementProvider({
    createDecisionId: (policyType) => `${policyType}-${++sequence}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides
  });
}

describe("strategy management provider", () => {
  it("publishes only the six read-only preview capabilities", () => {
    const provider = createProvider();

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

  it("requires explicit policy identities and does not fabricate optional policy values", () => {
    const provider = createProvider();

    expect(() => provider.evaluateWorkflowPolicy({})).toThrow("workflowId");
    expect(() => provider.evaluateAgentPolicy({})).toThrow("roleId");
    expect(() => provider.evaluateRoutePolicy({})).toThrow("routeId");
    expect(() => provider.evaluateQueuePolicy({ queueDefinitionId: "queue.jobs" })).toThrow("operationId");

    const queueDecision = provider.evaluateQueuePolicy({
      queueDefinitionId: "queue.jobs",
      operationId: "jobs.create"
    });
    expect(queueDecision).not.toHaveProperty("priority");
    expect(queueDecision).not.toHaveProperty("maxAttempts");
    expect(queueDecision).not.toHaveProperty("backpressureStrategy");
    expect(queueDecision).not.toHaveProperty("policyVersion");
  });

  it("normalizes equivalent input while preserving semantic changes", () => {
    const provider = createProvider();

    const workflow = stableDecision(provider.evaluateWorkflowPolicy({
      workflowId: "workflow-a",
      risk: "repair_write"
    }));
    const equivalent = stableDecision(provider.evaluateWorkflowPolicy({
      workflowId: "  workflow-a  ",
      risk: " repair_write "
    }));
    const changed = stableDecision(provider.evaluateWorkflowPolicy({
      workflowId: "workflow-a",
      risk: "read_only"
    }));

    expect(equivalent).toEqual(workflow);
    expect(changed).not.toEqual(workflow);
    expect(workflow.effect).toBe("require_confirmation");
    expect(changed.effect).toBe("allow");
  });

  it("uses Operation Permission once and exposes only the bounded public tool decision", async () => {
    const preview = vi.fn(async () => ({
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
    const provider = createProvider({
      getOperationPermissionPlatform: () => ({ policyEngine: { preview } })
    });

    const decision = await provider.evaluateToolPolicy({
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

  it("bounds public tool-decision lists and scalar text", async () => {
    const provider = createProvider({
      getOperationPermissionPlatform: () => ({
        policyEngine: {
          preview: async () => ({
            effect: "deny",
            reasonCode: "r".repeat(400),
            redactedReason: "m".repeat(400),
            missingScopes: Array.from({ length: 30 }, (_, index) => `scope-${String(index).padStart(2, "0")}`),
            missingToolsets: ["t".repeat(400)],
            evaluatedLayers: Array.from({ length: 30 }, (_, index) => `layer-${String(index).padStart(2, "0")}`)
          })
        }
      })
    });

    const decision = await provider.evaluateToolPolicy({ toolId: "meshrix.jobs.delete" });

    expect(decision.reasonCode).toHaveLength(256);
    expect(decision.redactedReason).toHaveLength(256);
    expect(decision.missingScopes).toHaveLength(16);
    expect(decision.evaluatedLayers).toHaveLength(16);
    expect(decision.missingToolsets).toHaveLength(1);
    expect(decision.missingToolsets[0]).toHaveLength(256);
  });

  it("returns a bounded denial when Operation Permission preview is unavailable", async () => {
    const decision = await createProvider().evaluateToolPolicy({ toolId: "meshrix.jobs.delete" });

    expect(decision).toMatchObject({
      policyType: "tool-policy",
      allowed: false,
      effect: "deny",
      reasonCode: "authorization_provider_unavailable"
    });
  });
});
