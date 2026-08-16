import { describe, expect, it, vi } from "vitest";

import { AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION } from "@meshrix/contracts/agent-mcp-traffic";
import type { GatewayChannel, GatewayDirection } from "@meshrix/contracts/plugins/gateway-channel-contract";
import { createAgentMcpGatewayPipeline } from "../../packages/server-runtime/src/composition/agent-mcp-gateway-pipeline.ts";
import { createGatewayChannelRouter } from "../../packages/server-runtime/src/composition/gateway-channel-router.ts";
import { activatePlugin } from "../../plugins/model-gateway/runtime.mjs";

const REFS = Object.freeze({
  operationId: "model_gateway.call",
  subjectRef: "subject:fixture",
  targetRef: "service:model-gateway",
  resourceRefs: ["model:model-one"],
  inputRefs: ["input:fixture"],
  policyRef: "policy:allow",
  approvalBinding: "approval:none",
  idempotencyKey: "fixture-call-one",
  deadlineMs: 1_000,
  cancellationRef: null,
  streamingMode: "none",
  traceRefs: ["trace:fixture"],
  evidenceRefs: ["evidence:fixture"],
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
    execute: async () => {
      order.push(direction);
      return Object.freeze({ status: "admitted", envelopeRef: direction });
    },
  });
}

describe("Model Gateway adapter boundary", () => {
  it("calls the configured standalone service only after both mandatory Gateway stages", async () => {
    const order: string[] = [];
    const workspace = vi.fn();
    const serviceRequest = vi.fn(async (request) => {
      order.push("standalone_service");
      expect(request.serviceRef).toBe("service.model-gateway");
      expect(request.operationRef).toBe("model_gateway.call");
      return Object.freeze({ ok: true, status: 200, data: Object.freeze({ resultRef: "result:fixture" }) });
    });
    const runtime = await activatePlugin({
      manifest: { id: "model-gateway" },
      context: {
        configuration: { enabled: true, serviceRef: "service.model-gateway", timeoutMs: 1_000 },
      },
    });
    const operation = runtime.contributions.operations["model_gateway.call"];
    const pipeline = createAgentMcpGatewayPipeline({
      router: createGatewayChannelRouter({
        downstream: channel("downstream", order),
        upstream: channel("upstream", order),
      }),
      workspaceApplication: { execute: workspace },
    });

    const result = await pipeline.execute({
      descriptor: Object.freeze({
        schemaVersion: AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
        operationId: "model_gateway.call",
        trafficModel: "gateway_transit",
      }),
      callerInput: Object.freeze({ workspaceId: "ignored", modelRef: "model-one" }),
      refs: REFS,
      executeOperation: async () => operation.execute({
        input: {
          modelRef: "model-one",
          providerRef: "provider-one",
          inputRefs: ["input:fixture"],
          idempotencyKey: "fixture-call-one",
          deadlineMs: 1_000,
          stream: false,
        },
        call: {
          auth: { authenticated: true },
          governance: { authorized: true, current: true, revoked: false },
        },
        host: { externalService: { request: serviceRequest } },
      }),
    });

    expect(order).toEqual(["downstream", "upstream", "standalone_service"]);
    expect(workspace).not.toHaveBeenCalled();
    expect(serviceRequest).toHaveBeenCalledOnce();
    expect(result.operationOutput).toMatchObject({ statusCode: 200, body: { resultRef: "result:fixture" } });
    await runtime.close();
  });

  it("keeps the adapter inert when disabled", async () => {
    const runtime = await activatePlugin({ manifest: { id: "model-gateway" }, context: {} });
    expect(runtime.contributions.operations).toEqual({});
    expect(runtime.contributions.routes).toEqual({});
    expect(runtime.contributions.mcpTools).toEqual({});
    await runtime.close();
  });
});
