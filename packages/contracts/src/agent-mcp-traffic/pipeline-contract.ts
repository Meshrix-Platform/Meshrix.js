import { type TrafficModel } from "./traffic-model.ts";
import { assertTrafficModel } from "./traffic-model.ts";

export const AGENT_MCP_GATEWAY_PIPELINE_SCHEMA_VERSION = "v0.0.1:agent-mcp-traffic:pipeline-1";
export const AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION = "v0.0.1:agent-mcp-traffic:descriptor-1";

export interface AgentMcpOperationDescriptor {
  readonly schemaVersion: typeof AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION;
  readonly operationId: string;
  readonly trafficModel: TrafficModel;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertAgentMcpOperationDescriptor(value: unknown): AgentMcpOperationDescriptor {
  if (!isPlainObject(value)) {
    throw new Error("agent_mcp_operation_descriptor_invalid");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "operationId" || keys[1] !== "schemaVersion" || keys[2] !== "trafficModel") {
    throw new Error("agent_mcp_operation_descriptor_closed_schema");
  }
  if (value.schemaVersion !== AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error("agent_mcp_operation_descriptor_schema_version");
  }
  if (typeof value.operationId !== "string" || value.operationId.length === 0) {
    throw new Error("agent_mcp_operation_descriptor_operation_id_required");
  }
  const trafficModel = assertTrafficModel(value.trafficModel);
  return Object.freeze({
    schemaVersion: AGENT_MCP_OPERATION_DESCRIPTOR_SCHEMA_VERSION,
    operationId: value.operationId,
    trafficModel
  });
}

export const AGENT_MCP_GATEWAY_STAGES = Object.freeze([
  "downstream_gateway",
  "optional_workspace_application",
  "upstream_gateway"
] as const);

export const AGENT_MCP_MANDATORY_GATEWAY_STAGES = Object.freeze([
  "downstream_gateway",
  "upstream_gateway"
] as const);

export const AGENT_MCP_RETURN_STAGES = Object.freeze([
  "upstream_response",
  "optional_application_response",
  "downstream_response"
] as const);

export const GATEWAY_TRANSIT_ZERO_WORKSPACE_ACTIONS = Object.freeze([
  "resolve_workspace",
  "create_workspace_state",
  "read_workspace_state",
  "mutate_workspace_state",
  "materialize_workspace",
  "cache_workspace",
  "checkpoint_workspace"
] as const);

export interface GatewayReturnPath {
  readonly upstreamGatewayGeneration: string;
  readonly downstreamGatewayGeneration: string;
}

export function assertMandatoryGatewayStageOrder(executed: readonly string[]): void {
  const downstream = executed.indexOf("downstream_gateway");
  const upstream = executed.indexOf("upstream_gateway");
  if (downstream < 0 || upstream < 0) {
    throw new Error("GATEWAY_STAGE_ORDER_VIOLATION: both Gateway stages are mandatory.");
  }
  if (downstream >= upstream) {
    throw new Error("GATEWAY_STAGE_ORDER_VIOLATION: downstream Gateway must precede upstream Gateway.");
  }
}

export function assertWorkspaceApplicationStagePosition(executed: readonly string[]): void {
  assertMandatoryGatewayStageOrder(executed);
  const application = executed.indexOf("workspace_application");
  if (application >= 0) {
    const downstream = executed.indexOf("downstream_gateway");
    const upstream = executed.indexOf("upstream_gateway");
    if (application <= downstream || application >= upstream) {
      throw new Error("GATEWAY_STAGE_ORDER_VIOLATION: the application stage must sit between the Gateways.");
    }
  }
}

export function assertDirectTransitZeroWorkspaceTouch(executed: readonly string[]): void {
  if (executed.includes("workspace_application") || executed.some((stage) => stage.startsWith("workspace_"))) {
    throw new Error("GATEWAY_TRANSIT_WORKSPACE_TOUCH_DENIED: direct transit never touches Workspace state.");
  }
}

export function assertReturnPathMirrorsAdmittedGenerations(
  downstreamGeneration: string,
  upstreamGeneration: string,
  returnPath: GatewayReturnPath
): void {
  if (
    returnPath.upstreamGatewayGeneration !== upstreamGeneration ||
    returnPath.downstreamGatewayGeneration !== downstreamGeneration
  ) {
    throw new Error("GATEWAY_RETURN_PATH_VIOLATION: the return path must mirror the admitted generations.");
  }
}
