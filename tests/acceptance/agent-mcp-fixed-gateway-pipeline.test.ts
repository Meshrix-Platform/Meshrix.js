import { describe, expect, it, vi } from "vitest";

import {
  AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
  createWorkspaceApplicationEnvelope,
  type AgentMcpOperationDescriptor,
} from "@meshrix/contracts/agent-mcp-traffic";
import type { GatewayChannel, GatewayDirection } from "@meshrix/contracts/plugins/gateway-channel-contract";
import { createAgentMcpGatewayPipeline } from "../../packages/server-runtime/src/composition/agent-mcp-gateway-pipeline.ts";
import { createGatewayChannelRouter } from "../../packages/server-runtime/src/composition/gateway-channel-router.ts";

const REFS = Object.freeze({
  operationId: "documents.update",
  subjectRef: "subject:operator",
  targetRef: "service:documents",
  resourceRefs: ["resource:document"],
  inputRefs: ["input:request"],
  policyRef: "policy:allow",
  approvalBinding: "approval:none",
  idempotencyKey: "request:1",
  deadlineMs: 1_000,
  cancellationRef: null,
  streamingMode: "none",
  traceRefs: ["trace:1"],
  evidenceRefs: ["evidence:1"],
});

function channel(direction: GatewayDirection, order: string[]): GatewayChannel {
  return Object.freeze({
    channelId: `meshrix.built-in.${direction}`,
    direction,
    kind: "built_in",
    trafficModels: ["workspace_application", "gateway_transit"],
    externalAdapter: null,
    capabilities: Object.freeze({
      loadDistribution: "bounded",
      maxConcurrency: 8,
      maxRatePerSecond: 64,
      circuitBreaker: true,
      overloadShedding: true,
      timeoutMs: 1_000,
      cancellation: true,
      streaming: true,
      backpressure: true,
      degradation: "stable_transport",
    }),
    accepts: () => true,
    execute: async (envelope: unknown) => {
      const stage = (envelope as { stage: string }).stage;
      order.push(stage);
      return Object.freeze({ status: "admitted", envelopeRef: stage, normalizedOutcomeRef: `${stage}:ok` });
    },
  });
}

function descriptor(trafficModel: AgentMcpOperationDescriptor["trafficModel"]): AgentMcpOperationDescriptor {
  return Object.freeze({
    schemaVersion: AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
    operationId: REFS.operationId,
    trafficModel,
  });
}

describe("canonical Agent MCP Gateway pipeline", () => {
  it("runs both mandatory Gateways around the Workspace application stage", async () => {
    const order: string[] = [];
    const workspace = vi.fn(async () => {
      order.push("workspace_application");
      return Object.freeze({
        envelope: createWorkspaceApplicationEnvelope({
          trafficModel: "workspace_application",
          operationId: REFS.operationId,
          subjectRef: REFS.subjectRef,
          workingSetId: "working-set:1",
          cursorRef: null,
          changeSetRef: "change-set:1",
          resourceRefs: REFS.resourceRefs,
          cacheScope: "private",
        }),
        result: Object.freeze({
          stage: "workspace_application" as const,
          trafficModel: "workspace_application" as const,
          envelopeRef: "workspace:1",
          status: "admitted" as const,
          normalizedOutcomeRef: "workspace:ok",
          errorRef: null,
          generationRef: "workspace-generation:1",
        }),
      });
    });
    const router = createGatewayChannelRouter({
      downstream: channel("downstream", order),
      upstream: channel("upstream", order),
    });
    const pipeline = createAgentMcpGatewayPipeline({ router, workspaceApplication: { execute: workspace } });

    const executeOperation = vi.fn(async () => {
      order.push("operation_effect");
      return Object.freeze({ ok: true });
    });
    const result = await pipeline.execute({
      descriptor: descriptor("workspace_application"),
      refs: REFS,
      executeOperation,
    });

    expect(order).toEqual(["downstream", "workspace_application", "upstream", "operation_effect"]);
    expect(result.trafficModel).toBe("workspace_application");
    expect(workspace).toHaveBeenCalledOnce();
    expect(executeOperation).toHaveBeenCalledOnce();
    expect(result.returnPath).toEqual({
      upstreamGatewayGeneration: "0",
      downstreamGatewayGeneration: "0",
    });
  });

  it("stops after a downstream rejection", async () => {
    const upstreamCalls: string[] = [];
    const upstream = channel("upstream", upstreamCalls);
    const downstream = Object.freeze({
      ...channel("downstream", []),
      execute: async () => Object.freeze({ status: "shed", errorRef: "gateway_overloaded" }),
    });
    const workspace = vi.fn();
    const executeOperation = vi.fn();
    const pipeline = createAgentMcpGatewayPipeline({
      router: createGatewayChannelRouter({ downstream, upstream }),
      workspaceApplication: { execute: workspace },
    });

    await expect(pipeline.execute({
      descriptor: descriptor("workspace_application"),
      refs: REFS,
      executeOperation,
    }))
      .rejects.toThrow("gateway_overloaded");
    expect(workspace).not.toHaveBeenCalled();
    expect(upstreamCalls).toEqual([]);
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("bypasses every Workspace action for gateway transit and executes only after both Gateways", async () => {
    const order: string[] = [];
    const workspace = vi.fn();
    const executeOperation = vi.fn(async ({ applicationOutput }) => {
      order.push("operation_effect");
      expect(applicationOutput).toBeNull();
      return Object.freeze({ ok: true });
    });
    const pipeline = createAgentMcpGatewayPipeline({
      router: createGatewayChannelRouter({
        downstream: channel("downstream", order),
        upstream: channel("upstream", order),
      }),
      workspaceApplication: { execute: workspace },
    });

    await pipeline.execute({
      descriptor: descriptor("gateway_transit"),
      callerInput: { workspaceId: "non-authoritative" },
      refs: REFS,
      executeOperation,
    });

    expect(order).toEqual(["downstream", "upstream", "operation_effect"]);
    expect(workspace).not.toHaveBeenCalled();
    expect(executeOperation).toHaveBeenCalledOnce();
  });
});
