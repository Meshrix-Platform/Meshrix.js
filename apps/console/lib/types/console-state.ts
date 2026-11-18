import type { ConsoleAuthSummary } from "../auth-types";
import type { AgentSettings } from "./agent";
import type { DiscoveryClientsResponse, DiscoveryConfigResponse, FeatureRuntimeSummary, RuntimeInfoResponse } from "./runtime";
import type { SplitJobListResponse } from "./split";
import type { ReadinessBaselineStatus } from "./production-health";
export type ServerConsoleState = {
  server: RuntimeInfoResponse["server"];
  runtime: RuntimeInfoResponse["runtime"];
  settings: {
    path: string;
    value: AgentSettings;
  };
  discovery: DiscoveryConfigResponse;
  auth?: ConsoleAuthSummary | null;
  storage: RuntimeInfoResponse["storage"];
  readinessBaseline?: ReadinessBaselineStatus | null;
  jobs: SplitJobListResponse;
  clients: DiscoveryClientsResponse;
  features?: FeatureRuntimeSummary | null;
};
