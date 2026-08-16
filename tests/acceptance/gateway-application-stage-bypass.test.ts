import { describe, expect, it, vi } from "vitest";

import { AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION } from "@meshrix/contracts/agent-mcp-traffic";
import type { GatewayChannel, GatewayDirection } from "@meshrix/contracts/plugins/gateway-channel-contract";
import { createAgentMcpGatewayPipeline } from "../../packages/server-runtime/src/composition/agent-mcp-gateway-pipeline.ts";
import { createGatewayChannelRouter } from "../../packages/server-runtime/src/composition/gateway-channel-router.ts";

function channel(direction: GatewayDirection, calls: string[]): GatewayChannel {
  return Object.freeze({
    channelId: `built-in:${direction}`,
    direction,
    kind: "built_in",
    trafficModels: ["workspace_application", "gateway_transit"],
    externalAdapter: null,
    capabilities: Object.freeze({
      loadDistribution: "bounded", maxConcurrency: 4, maxRatePerSecond: 16,
      circuitBreaker: true, overloadShedding: true, timeoutMs: 500,
      cancellation: true, streaming: true, backpressure: true, degradation: "stable_transport",
    }),
    accepts: () => true,
    execute: async () => {
      calls.push(direction);
      return Object.freeze({ status: "admitted", envelopeRef: direction });
    },
  });
}

const REFS = Object.freeze({
  operationId: "services.invoke", subjectRef: "subject:1", targetRef: "service:1",
  resourceRefs: [], inputRefs: [], policyRef: "policy:1", approvalBinding: "approval:none",
  idempotencyKey: "request:1", deadlineMs: 500, cancellationRef: null, streamingMode: "none",
  traceRefs: [], evidenceRefs: [],
});

describe("gateway_transit application bypass", () => {
  it("still traverses both Gateways and performs zero Workspace work", async () => {
    const calls: string[] = [];
    const workspace = vi.fn();
    const pipeline = createAgentMcpGatewayPipeline({
      router: createGatewayChannelRouter({
        downstream: channel("downstream", calls), upstream: channel("upstream", calls),
      }),
      workspaceApplication: { execute: workspace },
    });
    const result = await pipeline.execute({
      descriptor: Object.freeze({
        schemaVersion: AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
        operationId: REFS.operationId,
        trafficModel: "gateway_transit",
      }),
      callerInput: Object.freeze({ workspaceId: "forged-non-authoritative" }),
      refs: REFS,
      executeOperation: async () => {
        calls.push("operation_effect");
        return Object.freeze({ ok: true });
      },
    });

    expect(calls).toEqual(["downstream", "upstream", "operation_effect"]);
    expect(workspace).not.toHaveBeenCalled();
    expect(result.application).toBeNull();
  });

  it("rejects caller trafficModel overrides before either Gateway", async () => {
    const calls: string[] = [];
    const pipeline = createAgentMcpGatewayPipeline({
      router: createGatewayChannelRouter({
        downstream: channel("downstream", calls), upstream: channel("upstream", calls),
      }),
      workspaceApplication: { execute: vi.fn() },
    });

    await expect(pipeline.execute({
      descriptor: Object.freeze({
        schemaVersion: AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
        operationId: REFS.operationId,
        trafficModel: "gateway_transit",
      }),
      callerInput: Object.freeze({ trafficModel: "workspace_application" }),
      refs: REFS,
      executeOperation: vi.fn(),
    })).rejects.toThrow(/callers cannot supply or override trafficModel/u);
    expect(calls).toEqual([]);
  });
});
