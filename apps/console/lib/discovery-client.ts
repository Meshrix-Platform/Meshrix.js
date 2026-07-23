import { getJson, postJson } from "@lico/ui-console/bridge-http";
import type {
  DiscoveryClientsResponse,
  DiscoveryConfig,
  DiscoveryConfigResponse,
} from "./types";

export function getDiscoveryConfig() {
  return getJson<DiscoveryConfigResponse>("/api/discovery/config");
}

export function saveDiscoveryConfig(config: DiscoveryConfig) {
  return postJson<DiscoveryConfigResponse>(
    "/api/discovery/config",
    { value: config },
    { safetyConfirm: true },
  );
}

export function getDiscoveryClients() {
  return getJson<DiscoveryClientsResponse>("/api/discovery/clients");
}
