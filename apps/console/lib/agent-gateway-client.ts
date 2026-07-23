import { getJson, postJson } from "@lico/ui-console/bridge-http";
import type {
  AgentGatewayCallRequest,
  AgentGatewayCallResponse,
} from "./types";

export type {
  AgentGatewayCallRequest,
  AgentGatewayCallResponse,
} from "./types";

export function callAgentGateway(payload: AgentGatewayCallRequest) {
  return postJson<AgentGatewayCallResponse>("/api/agent-gateway/call", payload);
}
