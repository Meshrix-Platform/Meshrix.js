import type { ConsoleAuthSummary } from "../auth-types";
import type { AgentConfigState, AgentSelectorState, AgentSettings } from "./agent";
import type { DiscoveryClientsResponse, DiscoveryConfigResponse, FeatureRuntimeSummary, RuntimeInfoResponse } from "./runtime";
import type { MaintenanceAgentSummary } from "./maintenance";
import type { SplitJobListResponse } from "./split";
import type { ReadinessBaselineStatus } from "./production-health";
export type ServerConsoleState = {
  server: RuntimeInfoResponse["server"];
  runtime: RuntimeInfoResponse["runtime"];
  settings: {
    path: string;
    value: AgentSettings;
  };
  agentSelector?: AgentSelectorState;
  agentConfigs?: AgentConfigState;
  discovery: DiscoveryConfigResponse;
  auth?: ConsoleAuthSummary | null;
  maintenanceAgent?: MaintenanceAgentSummary | null;
  storage: RuntimeInfoResponse["storage"];
  readinessBaseline?: ReadinessBaselineStatus | null;
  jobs: SplitJobListResponse;
  clients: DiscoveryClientsResponse;
  features?: FeatureRuntimeSummary | null;
};
