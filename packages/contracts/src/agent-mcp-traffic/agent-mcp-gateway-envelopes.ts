import type { TrafficModel } from "./traffic-model.ts";
import { TRAFFIC_MODELS, classifyTrafficModel } from "./traffic-model.ts";

export const AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION =
  "v0.0.1:agent-mcp-traffic:gateway-envelope-1";

export const AGENT_MCP_STAGE_ORDER = Object.freeze([
  "downstream",
  "workspace_application",
  "upstream"
] as const);

export const AGENT_MCP_TRANSIT_STAGE_ORDER = Object.freeze([
  "downstream",
  "upstream"
] as const);

export const AGENT_MCP_MAX_BOUNDED_REFS = 64;

export const GATEWAY_STAGE_RESULT_STATUSES = Object.freeze([
  "admitted",
  "degraded",
  "shed",
  "timeout",
  "cancelled",
  "failed"
] as const);

export type GatewayStageResultStatus = (typeof GATEWAY_STAGE_RESULT_STATUSES)[number];

export interface GatewayEnvelopeRefs {
  readonly operationId: string;
  readonly subjectRef: string;
  readonly targetRef: string;
  readonly resourceRefs: readonly string[];
  readonly inputRefs: readonly string[];
  readonly policyRef: string;
  readonly approvalBinding: string;
  readonly idempotencyKey: string;
  readonly deadlineMs: number;
  readonly cancellationRef: string | null;
  readonly streamingMode: "none" | "text" | "sse";
  readonly traceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly trafficModel: TrafficModel;
}

export interface DownstreamGatewayEnvelope {
  readonly envelopeVersion: typeof AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION;
  readonly stage: "downstream";
  readonly refs: GatewayEnvelopeRefs;
}

export interface UpstreamGatewayEnvelope {
  readonly envelopeVersion: typeof AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION;
  readonly stage: "upstream";
  readonly refs: GatewayEnvelopeRefs;
  readonly sourceDownstreamGeneration: string;
  readonly sourceApplicationGeneration: string | null;
}

export interface WorkspaceApplicationEnvelope {
  readonly envelopeVersion: typeof AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION;
  readonly stage: "workspace_application";
  readonly trafficModel: "workspace_application";
  readonly operationId: string;
  readonly subjectRef: string;
  readonly workingSetId: string;
  readonly cursorRef: string | null;
  readonly changeSetRef: string | null;
  readonly resourceRefs: readonly string[];
  readonly cacheScope: "public" | "private";
}

export interface GatewayStageResult {
  readonly stage: "downstream" | "workspace_application" | "upstream";
  readonly trafficModel: TrafficModel;
  readonly envelopeRef: string;
  readonly status: GatewayStageResultStatus;
  readonly normalizedOutcomeRef: string | null;
  readonly errorRef: string | null;
  readonly generationRef: string | null;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireBoundedRefs(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.length > AGENT_MCP_MAX_BOUNDED_REFS) {
    throw new Error(`agent_mcp_envelope_${key}_bounded`);
  }
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`agent_mcp_envelope_${key}_invalid`);
  }
  return Object.freeze([...value]);
}

function parseEnvelopeRefs(record: Readonly<Record<string, unknown>>): GatewayEnvelopeRefs {
  for (const key of [
    "operationId",
    "subjectRef",
    "targetRef",
    "policyRef",
    "approvalBinding",
    "idempotencyKey"
  ] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(`agent_mcp_envelope_${key}_required`);
    }
  }
  if (typeof record.deadlineMs !== "number" || record.deadlineMs <= 0) {
    throw new Error("agent_mcp_envelope_deadline_out_of_bounds");
  }
  if (!["none", "text", "sse"].includes(record.streamingMode as string)) {
    throw new Error("agent_mcp_envelope_streaming_mode_invalid");
  }
  const trafficModel = classifyTrafficModel({ trafficModel: record.trafficModel });
  const cancellationRef = record.cancellationRef === null || record.cancellationRef === undefined
    ? null
    : record.cancellationRef;
  if (cancellationRef !== null && typeof cancellationRef !== "string") {
    throw new Error("agent_mcp_envelope_cancellation_ref_invalid");
  }
  return Object.freeze({
    operationId: record.operationId as string,
    subjectRef: record.subjectRef as string,
    targetRef: record.targetRef as string,
    resourceRefs: requireBoundedRefs(record.resourceRefs, "resource_refs"),
    inputRefs: requireBoundedRefs(record.inputRefs, "input_refs"),
    policyRef: record.policyRef as string,
    approvalBinding: record.approvalBinding as string,
    idempotencyKey: record.idempotencyKey as string,
    deadlineMs: record.deadlineMs as number,
    cancellationRef: cancellationRef as string | null,
    streamingMode: record.streamingMode as "none" | "text" | "sse",
    traceRefs: requireBoundedRefs(record.traceRefs, "trace_refs"),
    evidenceRefs: requireBoundedRefs(record.evidenceRefs, "evidence_refs"),
    trafficModel
  });
}

export function createDownstreamGatewayEnvelope(
  input: Readonly<Record<string, unknown>>
): DownstreamGatewayEnvelope {
  if (!isPlainObject(input)) {
    throw new Error("agent_mcp_downstream_envelope_invalid");
  }
  return Object.freeze({
    envelopeVersion: AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION,
    stage: "downstream",
    refs: parseEnvelopeRefs(input)
  });
}

export function createUpstreamGatewayEnvelope(
  input: Readonly<Record<string, unknown>>
): UpstreamGatewayEnvelope {
  if (!isPlainObject(input)) {
    throw new Error("agent_mcp_upstream_envelope_invalid");
  }
  if (typeof input.sourceDownstreamGeneration !== "string"
      || input.sourceDownstreamGeneration.length === 0) {
    throw new Error("agent_mcp_upstream_envelope_source_generation_required");
  }
  const sourceApplicationGeneration = input.sourceApplicationGeneration === null
    || input.sourceApplicationGeneration === undefined
    ? null
    : input.sourceApplicationGeneration;
  if (sourceApplicationGeneration !== null && typeof sourceApplicationGeneration !== "string") {
    throw new Error("agent_mcp_upstream_envelope_source_application_invalid");
  }
  return Object.freeze({
    envelopeVersion: AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION,
    stage: "upstream",
    refs: parseEnvelopeRefs(input),
    sourceDownstreamGeneration: input.sourceDownstreamGeneration as string,
    sourceApplicationGeneration: sourceApplicationGeneration as string | null
  });
}

export function createWorkspaceApplicationEnvelope(
  input: Readonly<Record<string, unknown>>
): WorkspaceApplicationEnvelope {
  if (!isPlainObject(input)) {
    throw new Error("agent_mcp_workspace_envelope_invalid");
  }
  if (input.trafficModel !== "workspace_application") {
    throw new Error("workspace_application_traffic_model_required");
  }
  for (const key of ["operationId", "subjectRef", "workingSetId"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new Error(`agent_mcp_workspace_envelope_${key}_required`);
    }
  }
  if (!["public", "private"].includes(input.cacheScope as string)) {
    throw new Error("agent_mcp_workspace_envelope_cache_scope_invalid");
  }
  return Object.freeze({
    envelopeVersion: AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION,
    stage: "workspace_application",
    trafficModel: "workspace_application",
    operationId: input.operationId as string,
    subjectRef: input.subjectRef as string,
    workingSetId: input.workingSetId as string,
    cursorRef: (input.cursorRef as string | null | undefined) ?? null,
    changeSetRef: (input.changeSetRef as string | null | undefined) ?? null,
    resourceRefs: requireBoundedRefs(input.resourceRefs, "resource_refs"),
    cacheScope: input.cacheScope as "public" | "private"
  });
}

export function assertPipelineStageOrder(stages: readonly GatewayStageResult[]): void {
  if (stages.length < 2) {
    throw new Error("agent_mcp_pipeline_requires_both_gateways");
  }
  const first = stages[0];
  const last = stages[stages.length - 1];
  if (first.stage !== "downstream" || last.stage !== "upstream") {
    throw new Error("agent_mcp_pipeline_gateway_order_invalid");
  }
  const trafficModel = first.trafficModel;
  if (stages.some((stage) => stage.trafficModel !== trafficModel)) {
    throw new Error("agent_mcp_pipeline_traffic_model_mismatch");
  }
  const middle = stages.slice(1, -1);
  if (trafficModel === "workspace_application") {
    if (middle.length !== 1 || middle[0].stage !== "workspace_application") {
      throw new Error("agent_mcp_pipeline_workspace_stage_required");
    }
  } else {
    if (middle.length !== 0) {
      throw new Error("agent_mcp_pipeline_transit_has_no_workspace_stage");
    }
  }
}

export function isGatewayStageResultStatus(value: unknown): value is GatewayStageResultStatus {
  return typeof value === "string"
    && (GATEWAY_STAGE_RESULT_STATUSES as readonly string[]).includes(value);
}

export function assertTrafficModelsCovered(models: readonly TrafficModel[]): void {
  for (const expected of TRAFFIC_MODELS) {
    if (!models.includes(expected)) {
      throw new Error("agent_mcp_traffic_models_incomplete");
    }
  }
}
