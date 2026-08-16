import type { TrafficModel } from "../agent-mcp-traffic/traffic-model.ts";
import { GATEWAY_TRANSIT_ZERO_WORKSPACE_ACTIONS } from "../agent-mcp-traffic/pipeline-contract.ts";

export const DIRECT_TRANSIT_CONTRACT_VERSION = "v0.0.1:gateway-transit:direct-1";

export const DIRECT_TRANSIT_FORBIDDEN_DESCRIPTOR_FIELDS = Object.freeze([
  "workspaceId",
  "workspaceRef",
  "workspaceSelector"
] as const);

export const DIRECT_TRANSIT_FORBIDDEN_WORKSPACE_ACTIONS = GATEWAY_TRANSIT_ZERO_WORKSPACE_ACTIONS;

export function assertGatewayTransitDescriptorHasNoWorkspaceBinding(
  trafficModel: TrafficModel,
  descriptor: Record<string, unknown>
): void {
  if (trafficModel !== "gateway_transit") return;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("GATEWAY_TRANSIT_DESCRIPTOR_REJECTED: descriptor must be an object.");
  }
  for (const field of DIRECT_TRANSIT_FORBIDDEN_DESCRIPTOR_FIELDS) {
    if (field in descriptor && descriptor[field] !== undefined && descriptor[field] !== null && descriptor[field] !== "") {
      throw new Error(`GATEWAY_TRANSIT_DESCRIPTOR_REJECTED: ${field} is forbidden on direct transit.`);
    }
  }
}

export function assertDirectTransitNeverResolvesWorkspace(
  executedWorkspaceActions: readonly string[]
): void {
  for (const action of executedWorkspaceActions) {
    if (DIRECT_TRANSIT_FORBIDDEN_WORKSPACE_ACTIONS.includes(action as (typeof DIRECT_TRANSIT_FORBIDDEN_WORKSPACE_ACTIONS)[number])) {
      throw new Error(`GATEWAY_TRANSIT_WORKSPACE_TOUCH_DENIED: ${action} is forbidden on direct transit.`);
    }
  }
}
