import {
  assertCallerCannotOverrideTrafficModel,
  assertPipelineStageOrder,
  assertReturnPathMirrorsAdmittedGenerations,
  createDownstreamGatewayEnvelope,
  createUpstreamGatewayEnvelope,
  type AgentMcpOperationDescriptor,
  type GatewayStageResult,
  type TrafficModel,
  type WorkspaceApplicationEnvelope,
} from "@meshrix/contracts/agent-mcp-traffic";
import type { GatewayChannelExecutionResult } from "@meshrix/contracts/plugins/gateway-channel-contract";
import type { GatewayChannelRouter, PinnedGatewayChannel } from "./gateway-channel-router.ts";

export interface AgentMcpPipelineRequest {
  readonly descriptor: AgentMcpOperationDescriptor;
  readonly callerInput?: Readonly<Record<string, unknown>>;
  readonly refs: Readonly<Record<string, unknown>>;
  readonly applicationContext?: unknown;
  readonly executeOperation: (input: Readonly<{
    applicationOutput: unknown;
    downstreamPin: PinnedGatewayChannel;
    upstreamPin: PinnedGatewayChannel;
  }>) => Promise<unknown>;
}

export interface WorkspaceApplicationStage {
  execute(input: Readonly<{
    descriptor: AgentMcpOperationDescriptor;
    callerInput: Readonly<Record<string, unknown>>;
    downstreamGeneration: string;
    applicationContext?: unknown;
  }>): Promise<Readonly<{
    envelope: WorkspaceApplicationEnvelope;
    result: GatewayStageResult;
    output?: unknown;
  }>>;
}

export interface AgentMcpPipelineResult {
  readonly trafficModel: TrafficModel;
  readonly downstream: GatewayChannelExecutionResult;
  readonly application: GatewayStageResult | null;
  readonly upstream: GatewayChannelExecutionResult;
  readonly downstreamPin: PinnedGatewayChannel;
  readonly upstreamPin: PinnedGatewayChannel;
  readonly applicationOutput: unknown;
  readonly operationOutput: unknown;
  readonly returnPath: Readonly<{
    upstreamGatewayGeneration: string;
    downstreamGatewayGeneration: string;
  }>;
}

function stageResult(
  stage: "downstream" | "upstream",
  trafficModel: TrafficModel,
  result: GatewayChannelExecutionResult,
  generation: number,
): GatewayStageResult {
  return Object.freeze({
    stage,
    trafficModel,
    envelopeRef: result.envelopeRef ?? `${stage}:${generation}`,
    status: result.status === "degraded" || result.status === "shed" || result.status === "timeout"
      || result.status === "cancelled" || result.status === "failed" ? result.status : "admitted",
    normalizedOutcomeRef: result.normalizedOutcomeRef ?? null,
    errorRef: result.errorRef ?? null,
    generationRef: String(generation),
  });
}

function requireAdmission(result: GatewayStageResult): void {
  if (result.status !== "admitted") throw new Error(result.errorRef || `gateway_${result.stage}_${result.status}`);
}

export function createAgentMcpGatewayPipeline(input: Readonly<{
  router: GatewayChannelRouter;
  workspaceApplication: WorkspaceApplicationStage;
}>): Readonly<{ execute(request: AgentMcpPipelineRequest): Promise<AgentMcpPipelineResult> }> {
  return Object.freeze({
    async execute(request): Promise<AgentMcpPipelineResult> {
      const callerInput = request.callerInput ?? Object.freeze({});
      const trafficModel = assertCallerCannotOverrideTrafficModel({ ...request.descriptor }, callerInput);
      const downstreamPin = input.router.pin("downstream", trafficModel);
      const upstreamPin = input.router.pin("upstream", trafficModel);
      const downstreamEnvelope = createDownstreamGatewayEnvelope({ ...request.refs, trafficModel });
      const downstream = await input.router.execute(downstreamPin, downstreamEnvelope);
      const downstreamStage = stageResult("downstream", trafficModel, downstream, downstreamPin.generation);
      requireAdmission(downstreamStage);

      let application: GatewayStageResult | null = null;
      let applicationOutput: unknown = null;
      if (trafficModel === "workspace_application") {
        const applied = await input.workspaceApplication.execute({
          descriptor: request.descriptor,
          callerInput,
          downstreamGeneration: String(downstreamPin.generation),
          applicationContext: request.applicationContext,
        });
        application = applied.result;
        applicationOutput = applied.output;
        requireAdmission(application);
      }

      const upstreamEnvelope = createUpstreamGatewayEnvelope({
        ...request.refs,
        trafficModel,
        sourceDownstreamGeneration: String(downstreamPin.generation),
        sourceApplicationGeneration: application?.generationRef ?? null,
      });
      const upstream = await input.router.execute(upstreamPin, upstreamEnvelope);
      const upstreamStage = stageResult("upstream", trafficModel, upstream, upstreamPin.generation);
      requireAdmission(upstreamStage);
      assertPipelineStageOrder(application
        ? [downstreamStage, application, upstreamStage]
        : [downstreamStage, upstreamStage]);

      const operationOutput = await request.executeOperation({
        applicationOutput,
        downstreamPin,
        upstreamPin,
      });
      const returnPath = Object.freeze({
        upstreamGatewayGeneration: String(upstreamPin.generation),
        downstreamGatewayGeneration: String(downstreamPin.generation),
      });
      assertReturnPathMirrorsAdmittedGenerations(
        String(downstreamPin.generation),
        String(upstreamPin.generation),
        returnPath,
      );

      return Object.freeze({
        trafficModel,
        downstream,
        application,
        upstream,
        downstreamPin,
        upstreamPin,
        applicationOutput,
        operationOutput,
        returnPath,
      });
    },
  });
}
