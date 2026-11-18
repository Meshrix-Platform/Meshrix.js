import {
  postJson,
  type BridgeRequestOptions,
} from "@meshrix/ui-console/bridge-http";
import type { EventSubscriptionResponse } from "./types";

export type ServerEventSubscriptionParams = {
  cursor?: number;
  topic?: string;
  timeoutMs?: number;
  includeSnapshot?: boolean;
};

function eventQuery(params: ServerEventSubscriptionParams = {}) : any {
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

export function subscribeEvents(
  params: ServerEventSubscriptionParams = {},
  options: BridgeRequestOptions = {},
) : any {
  return postJson<EventSubscriptionResponse>(`/api/events${eventQuery(params)}`, undefined, options);
}
