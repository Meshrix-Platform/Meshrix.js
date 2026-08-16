import { describe, expect, it } from "vitest";

import {
  TRAFFIC_MODELS,
  TRAFFIC_MODEL_FORBIDDEN_INFERENCE_SOURCES,
  TRAFFIC_MODEL_SELECTS_ONLY_MIDDLE_STAGE,
  TRAFFIC_MODEL_NEVER_SELECTS_GATEWAY_STAGES,
  assertAgentMcpOperationDescriptor,
  classifyTrafficModel,
  assertPipelineStageOrder,
  assertTrafficModelsCovered,
  createDownstreamGatewayEnvelope,
  createUpstreamGatewayEnvelope,
  createWorkspaceApplicationEnvelope
} from "@meshrix/contracts/agent-mcp-traffic";

function refs(trafficModel: string): Record<string, unknown> {
  return {
    operationId: "op.read",
    subjectRef: "subject-1",
    targetRef: "target-1",
    resourceRefs: ["res-1"],
    inputRefs: ["in-1"],
    policyRef: "policy-1",
    approvalBinding: "approval-1",
    idempotencyKey: "idem-1",
    deadlineMs: 60_000,
    cancellationRef: null,
    streamingMode: "none",
    traceRefs: [],
    evidenceRefs: [],
    trafficModel
  };
}

describe("Agent MCP trafficModel classification", () => {
  it("is a required closed enum selecting only the middle stage", () => {
    expect(TRAFFIC_MODELS).toEqual(["workspace_application", "gateway_transit"]);
    expect(classifyTrafficModel({ trafficModel: "workspace_application" }))
      .toBe("workspace_application");
    expect(classifyTrafficModel({ trafficModel: "gateway_transit" }))
      .toBe("gateway_transit");
    expect(TRAFFIC_MODEL_SELECTS_ONLY_MIDDLE_STAGE).toBe(true);
    expect(TRAFFIC_MODEL_NEVER_SELECTS_GATEWAY_STAGES).toBe(true);
  });

  it("fails on missing, unknown, or caller-override classification", () => {
    expect(() => classifyTrafficModel({})).toThrow("traffic_model_required_or_unknown");
    expect(() => classifyTrafficModel({ trafficModel: "direct" }))
      .toThrow("traffic_model_required_or_unknown");
    expect(() => classifyTrafficModel({ trafficModel: "gateway_transit", callerTrafficModel: "workspace_application" }))
      .toThrow("traffic_model_conflict");
    expect(() => classifyTrafficModel(undefined)).toThrow("traffic_model_missing");
  });

  it("never infers classification from url, tool name, payload, workspace, or health", () => {
    expect(TRAFFIC_MODEL_FORBIDDEN_INFERENCE_SOURCES).toEqual(
      expect.arrayContaining([
        "url",
        "tool_name",
        "payload_shape",
        "workspace_id",
        "runtime_health"
      ])
    );
  });

  it("freezes descriptors without a caller-override field", () => {
    const descriptor = assertAgentMcpOperationDescriptor({
      schemaVersion: "v0.0.1:agent-mcp-traffic:descriptor-1",
      operationId: "op.write",
      trafficModel: "workspace_application"
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(descriptor.trafficModel).toBe("workspace_application");
  });
});

describe("Mandatory dual-Gateway pipeline", () => {
  it("traverses downstream then upstream for both traffic models", () => {
    for (const trafficModel of TRAFFIC_MODELS) {
      const downstream = createDownstreamGatewayEnvelope(refs(trafficModel));
      const upstream = createUpstreamGatewayEnvelope({
        ...refs(trafficModel),
        sourceDownstreamGeneration: "gen-1",
        sourceApplicationGeneration: trafficModel === "workspace_application" ? "app-gen-1" : null
      });
      expect(downstream.stage).toBe("downstream");
      expect(upstream.stage).toBe("upstream");
      expect(downstream.refs.trafficModel).toBe(trafficModel);
      expect(upstream.refs.trafficModel).toBe(trafficModel);

      const middle = trafficModel === "workspace_application"
        ? [{ stage: "workspace_application", trafficModel, envelopeRef: "w-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: "app-gen-1" }]
        : [];
      assertPipelineStageOrder([
        { stage: "downstream", trafficModel, envelopeRef: "d-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: "gen-1" },
        ...middle,
        { stage: "upstream", trafficModel, envelopeRef: "u-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: "gen-1" }
      ]);
    }
  });

  it("admits the Workspace application stage only for workspace_application", () => {
    expect(() => createWorkspaceApplicationEnvelope({
      trafficModel: "gateway_transit",
      operationId: "op.read",
      subjectRef: "subject-1",
      workingSetId: "ws-1",
      cacheScope: "private",
      resourceRefs: []
    })).toThrow("workspace_application_traffic_model_required");

    const envelope = createWorkspaceApplicationEnvelope({
      trafficModel: "workspace_application",
      operationId: "op.read",
      subjectRef: "subject-1",
      workingSetId: "ws-1",
      cursorRef: "cursor-1",
      changeSetRef: null,
      cacheScope: "private",
      resourceRefs: ["res-1"]
    });
    expect(envelope.stage).toBe("workspace_application");
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it("rejects pipelines that bypass either Gateway or carry a transit Workspace stage", () => {
    expect(() => assertPipelineStageOrder([
      { stage: "workspace_application", trafficModel: "workspace_application", envelopeRef: "w-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: null },
      { stage: "upstream", trafficModel: "workspace_application", envelopeRef: "u-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: null }
    ])).toThrow("agent_mcp_pipeline_gateway_order_invalid");

    expect(() => assertPipelineStageOrder([
      { stage: "downstream", trafficModel: "gateway_transit", envelopeRef: "d-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: null },
      { stage: "workspace_application", trafficModel: "gateway_transit", envelopeRef: "w-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: null },
      { stage: "upstream", trafficModel: "gateway_transit", envelopeRef: "u-1", status: "admitted", normalizedOutcomeRef: null, errorRef: null, generationRef: null }
    ])).toThrow("agent_mcp_pipeline_transit_has_no_workspace_stage");
  });

  it("requires every channel to cover both traffic models", () => {
    expect(() => assertTrafficModelsCovered(["workspace_application"])).toThrow(
      "agent_mcp_traffic_models_incomplete"
    );
    assertTrafficModelsCovered([...TRAFFIC_MODELS]);
  });
});
