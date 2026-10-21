import { createHash } from "node:crypto";
import { createMcpCatalogInvalidation } from "#meshrix/contracts/mcp-catalog-delivery";

const EMPTY_DELIVERY: Readonly<Record<string, any>> = Object.freeze({
  activeConnectionCount: 0,
  matchedConnectionCount: 0,
  deliveredConnectionCount: 0,
  matchedGatewaySubscriptionCount: 0,
  deliveredGatewaySubscriptionCount: 0
});

let notificationBroadcaster: any = null;
let sseConnectionRegistrar: any = null;
let catalogConvergenceAcknowledger: any = null;
let grantConnectionDisconnector: any = null;
const gatewaySubscriptions = new Set<any>();
const grantSessions = new Map<string, Set<() => void>>();

/** Protocol sessions retire with their authorization, including sessions without
 * an open notification socket. No timer is used as a substitute for revocation. */
export function registerMcpGrantSession(grantId: string, close: () => void): () => void {
  if (!grantId) return () => {};
  let sessions = grantSessions.get(grantId);
  if (!sessions) { sessions = new Set(); grantSessions.set(grantId, sessions); }
  sessions.add(close);
  return () => {
    sessions.delete(close);
    if (sessions.size === 0) grantSessions.delete(grantId);
  };
}

export function disconnectMcpGrantSessions(grantId: string): void {
  for (const close of [...(grantSessions.get(grantId) ?? [])]) close();
}

const EVENT_TYPE_BY_NOTIFICATION_METHOD: Readonly<Record<string, string>> = Object.freeze({
  "notifications/tools/list_changed": "tools/list_changed",
  "notifications/resources/list_changed": "resources/list_changed",
  "notifications/prompts/list_changed": "prompts/list_changed",
  "notifications/resources/updated": "resource/updated",
  "notifications/meshrix/gateway/state_changed": "gateway/state_changed"
});

function grantDigest(value?: any) : string {
  const grantId: any = String(value || "").trim();
  return grantId ? createHash("sha256").update(grantId).digest("base64url") : "";
}

function normalizedStrings(values?: any) : string[] {
  return [...new Set<string>(
    (Array.isArray(values) ? values : [])
      .map((value?: any) : string => String(value || "").trim())
      .filter(Boolean)
  )];
}

function grantPartitionMap(value?: any) : Map<string, string[]> {
  if (value instanceof Map) {
    return new Map<string, string[]>([...value.entries()].map(([digest, partitions]: any[]): [string, string[]] => [
      String(digest || "").trim(), normalizedStrings(partitions)
    ]).filter(([digest]) => Boolean(digest)));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map<string, string[]>(Object.entries(value)
    .map(([digest, partitions]) => [String(digest || "").trim(), normalizedStrings(partitions)] as [string, string[]])
    .filter(([digest]) => Boolean(digest)));
}

export function configureMcpNotificationBus({
  broadcastNotification = null,
  registerSseConnection = null,
  acknowledgeCatalogConvergence = null,
  disconnectGrantConnections = null
}: Record<string, any> = {}) : any {
  notificationBroadcaster = typeof broadcastNotification === "function" ? broadcastNotification : null;
  sseConnectionRegistrar = typeof registerSseConnection === "function" ? registerSseConnection : null;
  catalogConvergenceAcknowledger = typeof acknowledgeCatalogConvergence === "function"
    ? acknowledgeCatalogConvergence
    : null;
  grantConnectionDisconnector = typeof disconnectGrantConnections === "function"
    ? disconnectGrantConnections
    : null;
  return {
    broadcastConfigured: Boolean(notificationBroadcaster),
    sseConfigured: Boolean(sseConnectionRegistrar),
    acknowledgementConfigured: Boolean(catalogConvergenceAcknowledger),
    disconnectConfigured: Boolean(grantConnectionDisconnector)
  };
}

/**
 * Register a kernel-backed downstream subscription. The retained notification
 * port only forwards a matched generic event; the gateway owns partitioning
 * and the adapter owns per-delivery re-authorization.
 */
export function registerMcpGatewaySubscription({
  methods = [],
  grantId = "",
  publish = null
}: Record<string, any> = {}) : any {
  if (typeof publish !== "function") return () => {};
  const entry: any = {
    methods: new Set(Array.isArray(methods) ? methods.map(String) : []),
    grantId: String(grantId || "").trim(),
    publish
  };
  gatewaySubscriptions.add(entry);
  return () => gatewaySubscriptions.delete(entry);
}

function gatewayEventFromNotification(payload?: any) : any {
  const method: any = typeof payload?.method === "string" ? payload.method : "";
  const type: any = EVENT_TYPE_BY_NOTIFICATION_METHOD[method];
  if (!type) return null;
  const params: any = payload?.params && typeof payload.params === "object" && !Array.isArray(payload.params)
    ? payload.params
    : {};
  const change: any = params.change && typeof params.change === "object" && !Array.isArray(params.change)
    ? params.change
    : {};
  return {
    type,
    revision: String(change.catalogRevision ?? change.audienceRevision ?? change.sourceRevision ?? params.revision ?? "notification"),
    payload: params
  };
}

function publishConfiguredGatewaySubscription(payload?: any, options: Record<string, any> = {}) : any {
  const event: any = gatewayEventFromNotification(payload);
  if (!event) return { matchedGatewaySubscriptionCount: 0, deliveredGatewaySubscriptionCount: 0 };
  const scopedGrantId: any = String(options.grantId || "").trim();
  const targetGrantDigests: any = new Set<any>(normalizedStrings(options.grantIdDigests));
  const affectedPartitions: any = normalizedStrings(options.partitionKeys);
  const partitionsByGrant: any = grantPartitionMap(options.grantPartitions);
  let matched = 0;
  let delivered = 0;
  for (const subscription of [...gatewaySubscriptions]) {
    const subscriptionGrantId: any = String(subscription.grantId || "").trim();
    const subscriptionDigest: any = grantDigest(subscriptionGrantId);
    if (scopedGrantId) {
      if (subscriptionGrantId !== scopedGrantId) continue;
    } else if (targetGrantDigests.size > 0 || affectedPartitions.length > 0) {
      if (!subscriptionDigest || !targetGrantDigests.has(subscriptionDigest)) continue;
    }
    if (subscription.methods.size > 0 && !subscription.methods.has(String(payload.method))) continue;
    matched += 1;
    try {
      let deliveredEvent: any = event;
      if (event.type === "tools/list_changed" && affectedPartitions.length > 0) {
        const grantPartitions: any[] = partitionsByGrant.get(subscriptionDigest) || [];
        const visiblePartitions: any = grantPartitions.length > 0
          ? affectedPartitions.filter((partition?: any) : any => grantPartitions.includes(partition))
          : [];
        deliveredEvent = {
          ...event,
          payload: {
            ...event.payload,
            change: {
              ...(event.payload?.change || {}),
              affectedPartitions: visiblePartitions
            }
          }
        };
      }
      subscription.publish(deliveredEvent);
      delivered += 1;
    } catch {
      gatewaySubscriptions.delete(subscription);
    }
  }
  return {
    matchedGatewaySubscriptionCount: matched,
    deliveredGatewaySubscriptionCount: delivered
  };
}

export function disconnectConfiguredMcpGrantConnections(grantId: any = "") : any {
  if (!grantConnectionDisconnector) return { disconnectedConnectionCount: 0 };
  const result: any = grantConnectionDisconnector(grantId);
  return result && typeof result === "object"
    ? result
    : { disconnectedConnectionCount: 0 };
}

export function acknowledgeConfiguredMcpCatalogConvergence(input: Record<string, any> = {}) : any {
  if (!catalogConvergenceAcknowledger) {
    return { ok: false, appliedConnectionCount: 0 };
  }
  const result: any = catalogConvergenceAcknowledger(input);
  return result && typeof result === "object"
    ? result
    : { ok: false, appliedConnectionCount: 0 };
}

export function broadcastConfiguredMcpNotification(payload?: any, options: Record<string, any> = {}) : any {
  const retained: any = notificationBroadcaster
    ? notificationBroadcaster(payload, options)
    : { ...EMPTY_DELIVERY };
  return {
    ...EMPTY_DELIVERY,
    ...(retained && typeof retained === "object" ? retained : {}),
    ...publishConfiguredGatewaySubscription(payload, options)
  };
}

export function registerConfiguredMcpSubscription(connection: Record<string, any> = {}) : any {
  if (!sseConnectionRegistrar) return null;
  return sseConnectionRegistrar(connection);
}

function jsonRpcNotification(method?: any, params: Record<string, any> = {}) : any {
  return { jsonrpc: "2.0", method, params };
}

export function broadcastMcpToolListChanged({
  grantId = "",
  reasonCode = "tool_list_changed",
  includePrivate = true,
  partitionKeys = null,
  grantIdDigests = null,
  grantPartitions = null,
  sourceRevision = null,
  catalogRevision = null,
  audienceRevision = null,
  coalesceKey = ""
}: Record<string, any> = {}) : any {
  const scopedGrantId: any = String(grantId || "").trim();
  const revisionChain: Record<string, any> = {};
  if (Number.isSafeInteger(sourceRevision) && sourceRevision >= 0) revisionChain.sourceRevision = sourceRevision;
  if (catalogRevision !== null && catalogRevision !== undefined && String(catalogRevision).trim()) {
    revisionChain.catalogRevision = String(catalogRevision).trim();
  }
  if (Number.isSafeInteger(audienceRevision) && audienceRevision >= 0) revisionChain.audienceRevision = audienceRevision;
  const change: any = createMcpCatalogInvalidation({
    reasonCode: String(reasonCode || "tool_list_changed"),
    ...revisionChain,
    affectedPartitions: Array.isArray(partitionKeys) ? partitionKeys : []
  });
  const delivery: any = broadcastConfiguredMcpNotification(jsonRpcNotification("notifications/tools/list_changed", { change }), {
    grantId: scopedGrantId,
    includePrivate,
    partitionKeys,
    grantIdDigests,
    grantPartitions,
    coalesceKey: coalesceKey || (revisionChain.audienceRevision !== undefined ? `audience:${revisionChain.audienceRevision}` : "")
  });
  return {
    ok: true,
    notification: "notifications/tools/list_changed",
    grantId: scopedGrantId,
    reasonCode: change.reasonCode || "tool_list_changed",
    ...revisionChain,
    ...delivery
  };
}

export function broadcastAudienceCatalogInvalidation({
  sourceRevision = null,
  catalogRevision = "",
  audienceRevision = null,
  affectedPartitions = [],
  partitions = null,
  previousPartitions = null,
  reasonCode = "upstream_audiences_published"
}: Record<string, any> = {}) : any {
  const partitionKeys: any = [...new Set<any>(
    (Array.isArray(affectedPartitions) ? affectedPartitions : [])
      .map((value?: any) : any => String(value || "").trim())
      .filter(Boolean)
  )].sort();
  const grantIdDigests: any[] = [];
  const grantPartitions: any = new Map<any, any>();
  const current: any = partitions instanceof Map ? partitions : new Map<any, any>(partitions || []);
  const previous: any = previousPartitions instanceof Map
    ? previousPartitions
    : new Map<any, any>(previousPartitions || []);
  for (const key of partitionKeys) {
    const part: any = current.get(key) || previous.get(key);
    const digest: any = String(part?.grantIdDigest || "").trim();
    if (digest) {
      grantIdDigests.push(digest);
      const keys: any = grantPartitions.get(digest) || [];
      keys.push(key);
      grantPartitions.set(digest, keys);
    }
  }
  return broadcastMcpToolListChanged({
    reasonCode,
    includePrivate: true,
    partitionKeys,
    grantIdDigests: [...new Set<any>(grantIdDigests)],
    grantPartitions,
    sourceRevision,
    catalogRevision,
    audienceRevision,
    coalesceKey: Number.isSafeInteger(audienceRevision) ? `audience:${audienceRevision}` : ""
  });
}
