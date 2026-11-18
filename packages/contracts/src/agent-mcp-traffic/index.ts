export {
  TRAFFIC_MODEL_DESCRIPTOR_FIELD,
  TRAFFIC_MODEL_SCHEMA_VERSION,
  TRAFFIC_MODELS,
  TRAFFIC_MODEL_VALUES,
  TRAFFIC_MODEL_CALLER_OVERRIDE_FORBIDDEN,
  TRAFFIC_MODEL_INFERENCE_FORBIDDEN,
  TRAFFIC_MODEL_SELECTS_ONLY_MIDDLE_STAGE,
  TRAFFIC_MODEL_NEVER_SELECTS_GATEWAY_STAGES,
  TRAFFIC_MODEL_REJECTED_ERROR,
  TRAFFIC_MODEL_OVERRIDE_FIELDS,
  TRAFFIC_MODEL_FORBIDDEN_INFERENCE_SOURCES,
  TRAFFIC_MODEL_ERROR_CODES,
  normalizeTrafficModel,
  isTrafficModel,
  assertTrafficModel,
  requireTrafficModel,
  classifyTrafficModel,
  denyTrafficModelOverride,
  assertCallerCannotOverrideTrafficModel,
  assertNoTrafficModelConflict
} from "./traffic-model.ts";
export type { TrafficModel, TrafficModelErrorCode } from "./traffic-model.ts";

export {
  AGENT_MCP_GATEWAY_ENVELOPE_SCHEMA_VERSION,
  AGENT_MCP_STAGE_ORDER,
  AGENT_MCP_TRANSIT_STAGE_ORDER,
  AGENT_MCP_MAX_BOUNDED_REFS,
  GATEWAY_STAGE_RESULT_STATUSES,
  createDownstreamGatewayEnvelope,
  createUpstreamGatewayEnvelope,
  createWorkspaceApplicationEnvelope,
  assertPipelineStageOrder,
  assertTrafficModelsCovered,
  isGatewayStageResultStatus
} from "./agent-mcp-gateway-envelopes.ts";
export type {
  GatewayEnvelopeRefs,
  DownstreamGatewayEnvelope,
  UpstreamGatewayEnvelope,
  WorkspaceApplicationEnvelope,
  GatewayStageResult,
  GatewayStageResultStatus
} from "./agent-mcp-gateway-envelopes.ts";

export {
  AGENT_MCP_GATEWAY_PIPELINE_SCHEMA_VERSION,
  AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
  AGENT_MCP_GATEWAY_STAGES,
  AGENT_MCP_MANDATORY_GATEWAY_STAGES,
  AGENT_MCP_RETURN_STAGES,
  GATEWAY_TRANSIT_ZERO_WORKSPACE_ACTIONS,
  assertAgentMcpOperationDescriptor,
  assertMandatoryGatewayStageOrder,
  assertWorkspaceApplicationStagePosition,
  assertDirectTransitZeroWorkspaceTouch,
  assertReturnPathMirrorsAdmittedGenerations
} from "./pipeline-contract.ts";
export type { AgentMcpOperationDescriptor, GatewayReturnPath } from "./pipeline-contract.ts";
