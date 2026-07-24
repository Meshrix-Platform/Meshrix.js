import { getJson } from "@meshrix/ui-console/bridge-http";
import type { AgentRegistryResponse } from "./types";

export function listAgents() {
  return getJson<AgentRegistryResponse>("/api/agents");
}
