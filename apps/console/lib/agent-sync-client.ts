import { getJson, postJson } from "@lico/ui-console/bridge-http";
import type {
  AgentSyncConfig,
  AgentSyncPublishRequest,
  EventSubscriptionResponse,
} from "./types";

export type AgentSyncEventParams = {
  cursor?: number;
  topic?: string;
  timeoutMs?: number;
  includeSnapshot?: boolean;
};

function eventQuery(params: AgentSyncEventParams = {}) {
  const query = new URLSearchParams();
  if (params.cursor !== undefined) {
    query.set("cursor", String(params.cursor));
  }
  if (params.topic) {
    query.set("topic", params.topic);
  }
  if (params.timeoutMs !== undefined) {
    query.set("timeoutMs", String(params.timeoutMs));
  }
  if (params.includeSnapshot !== undefined) {
    query.set("includeSnapshot", params.includeSnapshot ? "1" : "0");
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export function getAgentSyncConfig() {
  return getJson<{ config: AgentSyncConfig }>("/api/agent-sync/config");
}

export function saveAgentSyncConfig(config: Partial<AgentSyncConfig>) {
  return postJson<{ config: AgentSyncConfig }>(
    "/api/agent-sync/config",
    { config },
    { safetyConfirm: true },
  );
}

export function publishAgentSync(payload: AgentSyncPublishRequest) {
  return postJson<Record<string, unknown>>("/api/agent-sync/publish", payload);
}

export function subscribeAgentSync(params: AgentSyncEventParams = {}) {
  return getJson<EventSubscriptionResponse>(`/api/agent-sync/events${eventQuery(params)}`);
}
