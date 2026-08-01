import { getJson } from "@meshrix/ui-console/bridge-http";
import type { AgentRegistryResponse } from "./types";

export function listAgents() : any {
  return getJson<AgentRegistryResponse>("/api/agents");
}
