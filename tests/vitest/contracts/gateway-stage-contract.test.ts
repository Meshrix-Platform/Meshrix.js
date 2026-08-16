import { describe, expect, it } from "vitest";

import {
  AGENT_MCP_MAX_BOUNDED_REFS,
  AGENT_MCP_STAGE_ORDER,
  AGENT_MCP_TRANSIT_STAGE_ORDER,
  GATEWAY_STAGE_RESULT_STATUSES,
  createDownstreamGatewayEnvelope,
  createUpstreamGatewayEnvelope,
  isGatewayStageResultStatus
} from "@meshrix/contracts/agent-mcp-traffic";

function refs(trafficModel: string, inputRefs: readonly string[]): Record<string, unknown> {
  return {
    operationId: "op.read",
    subjectRef: "subject-1",
    targetRef: "target-1",
    resourceRefs: ["res-1"],
    inputRefs,
    policyRef: "policy-1",
    approvalBinding: "approval-1",
    idempotencyKey: "idem-1",
    deadlineMs: 60_000,
    cancellationRef: "cancel-1",
    streamingMode: "sse",
    traceRefs: ["trace-1"],
    evidenceRefs: ["evidence-1"],
    trafficModel
  };
}

describe("Gateway envelope contract", () => {
  it("produces immutable envelopes carrying common operation and control references", () => {
    for (const trafficModel of ["workspace_application", "gateway_transit"]) {
      const downstream = createDownstreamGatewayEnvelope(refs(trafficModel, ["in-1"]));
      expect(Object.isFrozen(downstream)).toBe(true);
      expect(Object.isFrozen(downstream.refs.inputRefs)).toBe(true);
      expect(downstream.refs).toMatchObject({
        operationId: "op.read",
        subjectRef: "subject-1",
        targetRef: "target-1",
        policyRef: "policy-1",
        approvalBinding: "approval-1",
        idempotencyKey: "idem-1",
        cancellationRef: "cancel-1",
        streamingMode: "sse",
        traceRefs: ["trace-1"],
        evidenceRefs: ["evidence-1"]
      });
    }
  });

  it("bounds input, trace, and evidence references", () => {
    const overflow = Array.from({ length: AGENT_MCP_MAX_BOUNDED_REFS + 1 }, () => "in");
    expect(() => createDownstreamGatewayEnvelope(refs("gateway_transit", overflow)))
      .toThrow("agent_mcp_envelope_input_refs_bounded");
  });

  it("mirrors pinned upstream and downstream generations on the return path", () => {
    const upstream = createUpstreamGatewayEnvelope({
      ...refs("workspace_application", ["in-1"]),
      sourceDownstreamGeneration: "gen-down-7",
      sourceApplicationGeneration: "gen-app-7"
    });
    expect(upstream.sourceDownstreamGeneration).toBe("gen-down-7");
    expect(upstream.sourceApplicationGeneration).toBe("gen-app-7");

    const transit = createUpstreamGatewayEnvelope({
      ...refs("gateway_transit", ["in-1"]),
      sourceDownstreamGeneration: "gen-down-8",
      sourceApplicationGeneration: null
    });
    expect(transit.sourceApplicationGeneration).toBeNull();
    expect(() => createUpstreamGatewayEnvelope({
      ...refs("gateway_transit", ["in-1"]),
      sourceApplicationGeneration: null
    })).toThrow("agent_mcp_upstream_envelope_source_generation_required");
  });

  it("fixes the stage order and normalized result statuses", () => {
    expect(AGENT_MCP_STAGE_ORDER).toEqual([
      "downstream",
      "workspace_application",
      "upstream"
    ]);
    expect(AGENT_MCP_TRANSIT_STAGE_ORDER).toEqual(["downstream", "upstream"]);
    expect(GATEWAY_STAGE_RESULT_STATUSES).toEqual([
      "admitted",
      "degraded",
      "shed",
      "timeout",
      "cancelled",
      "failed"
    ]);
    expect(isGatewayStageResultStatus("shed")).toBe(true);
    expect(isGatewayStageResultStatus("redirected")).toBe(false);
  });
});
