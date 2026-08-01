import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
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

function eventQuery(params: AgentSyncEventParams = {}) : any {
  const query: any = new URLSearchParams();
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
  const suffix: any = query.toString();
  return suffix ? `?${suffix}` : "";
}

export function getAgentSyncConfig() : any {
  return getJson<{ config: AgentSyncConfig }>("/api/agent-sync/config");
}

export function saveAgentSyncConfig(config: Partial<AgentSyncConfig>) : any {
  return postJson<{ config: AgentSyncConfig }>(
    "/api/agent-sync/config",
    { config },
    { safetyConfirm: true },
  );
}

export function publishAgentSync(payload: AgentSyncPublishRequest) : any {
  return postJson<Record<string, unknown>>("/api/agent-sync/publish", payload);
}

export function subscribeAgentSync(params: AgentSyncEventParams = {}) : any {
  return getJson<EventSubscriptionResponse>(`/api/agent-sync/events${eventQuery(params)}`);
}
