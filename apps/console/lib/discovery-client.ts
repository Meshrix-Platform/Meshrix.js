import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  DiscoveryClientsResponse,
  DiscoveryConfig,
  DiscoveryConfigResponse,
} from "./types";

export function getDiscoveryConfig() : any {
  return getJson<DiscoveryConfigResponse>("/api/discovery/config");
}

export function saveDiscoveryConfig(config: DiscoveryConfig) : any {
  return postJson<DiscoveryConfigResponse>(
    "/api/discovery/config",
    { value: config },
    { safetyConfirm: true },
  );
}

export function getDiscoveryClients() : any {
  return getJson<DiscoveryClientsResponse>("/api/discovery/clients");
}
