/*
 * Connector Working View: authorization-partitioned confirmed and optimistic
 * Resource state, bounded Inbox/Outbox, private weighted caches, acknowledgement,
 * and explicit resynchronization. Handles, Cursors, and cache entries are lookup
 * facts, never authority. This module does not apply Core Change Sets or execute
 * Effect Commands.
 */

import {
  SERVICE_COLLABORATION_CORE_STATE_GENERATION,
  SERVICE_COLLABORATION_LIMITS,
  SERVICE_COLLABORATION_LOOKUP_FACTS,
  SERVICE_COLLABORATION_PROTOCOL_VERSION,
  SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  assertCommitTurn,
  assertObserveCacheHit,
  containsForbiddenKeys,
  createEditView,
  createObserveResponse,
  lookupFactIsAuthority,
  parseAcknowledge,
  parseCollaborationMessage,
  parseCommitRequest,
  parseObserveResponse,
  parseOpenResponse,
  parseResourceUpdatedNotification,
  parseResyncResponse,
  parseSubscribeRequest
} from "@meshrix/contracts/service-collaboration-contract";

export const CONNECTOR_WORKING_VIEW_OWNED_MODULE: any =
  "packages/protocols/mcp/adapter/gateway-installer/connector-working-view.ts";
export const CONNECTOR_WORKING_VIEW_SCHEMA_VERSION: any = "v0.0.1:connector-working-view:state-1";
export const CONNECTOR_WORKING_VIEW_REPORT_SCHEMA_VERSION: any = "v0.0.1:connector-working-view:report-1";
export const CONNECTOR_WORKING_VIEW_JSONRPC_VERSION: any = "2.0";
export const CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED: any = false;
export const CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON: any = "owner_profile_not_authorized";

export const CONNECTOR_WORKING_VIEW_LIMITS: any = Object.freeze({
  maxInboxCount: SERVICE_COLLABORATION_LIMITS.maxDeltaPage,
  maxOutboxCount: SERVICE_COLLABORATION_LIMITS.maxHistoryEntries,
  maxInboxBytes: SERVICE_COLLABORATION_LIMITS.maxChangeSetBytes,
  maxOutboxBytes: SERVICE_COLLABORATION_LIMITS.maxChangeSetBytes,
  maxCacheEntries: SERVICE_COLLABORATION_LIMITS.maxResourceLinks,
  maxCacheWeight: SERVICE_COLLABORATION_LIMITS.maxSnapshotBytes,
  maxHistoryEntries: SERVICE_COLLABORATION_LIMITS.maxHistoryEntries,
  maxSubscriptions: SERVICE_COLLABORATION_LIMITS.maxSubscriptions,
  maxEntitiesPerWorkingSet: SERVICE_COLLABORATION_LIMITS.maxEntitiesPerWorkingSet
});

const KIND_TO_METHOD: any = Object.freeze({
  "open-request": "meshrix/collaboration/open",
  "open-response": "meshrix/collaboration/open",
  "observe-request": "meshrix/collaboration/observe",
  "observe-response": "meshrix/collaboration/observe",
  "commit-request": "meshrix/collaboration/commit",
  acknowledge: "meshrix/collaboration/acknowledge",
  "subscribe-request": SERVICE_COLLABORATION_SUBSCRIBE_METHOD,
  "resource-updated": SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD,
  "rebase-request": "meshrix/collaboration/rebase",
  "rebase-response": "meshrix/collaboration/rebase",
  "resync-request": "meshrix/collaboration/resync",
  "resync-response": "meshrix/collaboration/resync",
  "effect-command": "meshrix/collaboration/effect",
  fallback: "tools/call"
});

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value?: any, expected?: any) : any {
  if (!isPlainObject(value)) return false;
  const keys: any = Object.keys(value).sort();
  return keys.length === expected.length && expected.every((key?: any, index?: any) : any => key === keys[index]);
}

function messageBytes(value?: any) : any {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cloneJson(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

function positiveLimit(value?: any, fallback?: any) : any {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function connectorLookupFactIsAuthority(factName?: any) : any {
  if (factName && !SERVICE_COLLABORATION_LOOKUP_FACTS.includes(factName)) return false;
  return lookupFactIsAuthority(factName);
}

export function collaborationMethodFor(kind?: any) : any {
  return KIND_TO_METHOD[kind] || "";
}

export function isNotificationKind(kind?: any) : any {
  return kind === "resource-updated";
}

export function parseConnectorMcpEnvelope(value?: any) : any {
  if (!isPlainObject(value) || value.jsonrpc !== CONNECTOR_WORKING_VIEW_JSONRPC_VERSION) return null;
  if (containsForbiddenKeys(value)) return null;
  const notification: any = !Object.prototype.hasOwnProperty.call(value, "id");
  const expected: any = notification
    ? ["jsonrpc", "method", "params"].sort()
    : ["id", "jsonrpc", "method", "params"].sort();
  if (!hasExactKeys(value, expected)) return null;
  if (notification && value.method !== SERVICE_COLLABORATION_RESOURCE_UPDATED_METHOD) return null;
  if (!notification && typeof value.id !== "string") return null;
  if (typeof value.method !== "string" || !value.method) return null;
  const params: any = parseCollaborationMessage(value.params);
  if (!params) return null;
  const expectedMethod: any = collaborationMethodFor(params.kind);
  if (!expectedMethod || expectedMethod !== value.method) return null;
  if (params.kind === "edit-view") return null;
  return Object.freeze({
    jsonrpc: CONNECTOR_WORKING_VIEW_JSONRPC_VERSION,
    ...(notification ? {} : { id: value.id }),
    method: value.method,
    params
  });
}

export function projectConnectorMcpEnvelope({
  id = "connector-1",
  message
}: Record<string, any> = {}) : any {
  const params: any = parseCollaborationMessage(message);
  if (!params) return null;
  if (params.kind === "edit-view") {
    return Object.freeze({
      local: true,
      envelope: null,
      kind: "edit-view",
      protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
      coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION
    });
  }
  const method: any = collaborationMethodFor(params.kind);
  if (!method) return null;
  const envelope: any = isNotificationKind(params.kind)
    ? { jsonrpc: CONNECTOR_WORKING_VIEW_JSONRPC_VERSION, method, params }
    : { jsonrpc: CONNECTOR_WORKING_VIEW_JSONRPC_VERSION, id, method, params };
  const parsed: any = parseConnectorMcpEnvelope(envelope);
  return parsed ? Object.freeze({ local: false, envelope: parsed, kind: params.kind }) : null;
}

function createBoundedQueue({ maxCount, maxBytes }: Record<string, any>) : any {
  const items: any[] = [];
  let bytes: any = 0;

  function unacknowledged() : any {
    return items.filter((item?: any) : any => item.acknowledged !== true);
  }

  return {
    snapshot() : any {
      const pending: any = unacknowledged();
      return Object.freeze({
        count: items.length,
        bytes,
        unacknowledged: pending.length
      });
    },
    list() : any {
      return items.map((item?: any) : any => cloneJson(item));
    },
    tryPush(item?: any) : any {
      const size: any = Number(item?.byteLength || 0);
      const pending: any = unacknowledged();
      if (items.length >= maxCount || bytes + size > maxBytes) {
        return Object.freeze({
          ok: false,
          outcome: "backpressure",
          dropped: 0,
          unacknowledged: pending.length
        });
      }
      items.push(item);
      bytes += size;
      return Object.freeze({ ok: true, outcome: "accepted", dropped: 0, unacknowledged: pending.length + 1 });
    },
    acknowledgeMatching(predicate?: any) : any {
      let removed: any = 0;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index]) !== true) continue;
        bytes -= items[index].byteLength;
        items.splice(index, 1);
        removed += 1;
      }
      return removed;
    },
    markAcknowledged(predicate?: any) : any {
      let marked: any = 0;
      for (const item of items) {
        if (item.acknowledged === true || predicate(item) !== true) continue;
        item.acknowledged = true;
        marked += 1;
      }
      return marked;
    },
    compactAcknowledged() : any {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index].acknowledged !== true) continue;
        bytes -= items[index].byteLength;
        items.splice(index, 1);
      }
    },
    clear() : any {
      items.length = 0;
      bytes = 0;
    }
  };
}

function createPartition({ grantLookup, budgets }: Record<string, any>) : any {
  const cache: any = new Map<any, any>();
  const handles: any = new Map<any, any>();
  const uriByEntity: any = new Map<any, any>();
  const inbox: any = createBoundedQueue({
    maxCount: budgets.maxInboxCount,
    maxBytes: budgets.maxInboxBytes
  });
  const outbox: any = createBoundedQueue({
    maxCount: budgets.maxOutboxCount,
    maxBytes: budgets.maxOutboxBytes
  });

  const state: any = {
    grantLookup,
    workingSetId: "",
    confirmedHead: 0,
    optimisticHead: 0,
    dirtyEntityIds: [],
    omittedUnchanged: true,
    catalogRevision: "",
    schemaRevision: "",
    lastEmittedSchemaRevision: "",
    cursor: null,
    cacheHint: { ttlMs: 0, cacheScope: "private" },
    acknowledgements: [],
    history: [],
    subscriptions: 0,
    forceMiss: false,
    cancelled: false,
    confirmedResources: new Map<any, any>(),
    cache,
    handles,
    uriByEntity,
    inbox,
    outbox
  };

  function cacheWeight() : any {
    let weight: any = 0;
    for (const entry of cache.values()) weight += entry.weight;
    return weight;
  }

  function evictExpired(now?: any) : any {
    for (const [uri, entry] of [...cache.entries()]) {
      if (entry.invalidated === true) {
        cache.delete(uri);
        continue;
      }
      if (entry.ttlMs > 0 && now - entry.storedAtMs > entry.ttlMs) cache.delete(uri);
    }
    while (cache.size > budgets.maxCacheEntries || cacheWeight() > budgets.maxCacheWeight) {
      const oldest: any = [...cache.entries()].sort((left?: any, right?: any) : any => (
        left[1].storedAtMs - right[1].storedAtMs
      ))[0];
      if (!oldest) break;
      cache.delete(oldest[0]);
    }
  }

  function putCache(link?: any, extras: Record<string, any> = {}, now?: any) : any {
    if (!link || link.cacheHint?.cacheScope !== "private") return false;
    const record: any = {
      uri: link.uri,
      head: link.head,
      ttlMs: link.cacheHint.ttlMs,
      cacheScope: "private",
      catalogRevision: extras.catalogRevision || state.catalogRevision,
      schemaRevision: extras.schemaRevision || state.schemaRevision,
      storedAtMs: now,
      invalidated: false
    };
    record.weight = messageBytes({
      uri: record.uri,
      head: record.head,
      catalogRevision: record.catalogRevision,
      schemaRevision: record.schemaRevision,
      ttlMs: record.ttlMs,
      cacheScope: record.cacheScope
    });
    cache.set(link.uri, record);
    evictExpired(now);
    return cache.has(link.uri);
  }

  return {
    state,
    cacheWeight,
    evictExpired,
    putCache,
    inbox,
    outbox
  };
}

function emptyCounters() : any {
  return {
    remoteReads: 0,
    cacheHits: 0,
    cacheMisses: 0,
    schemaModelContextBytes: 0,
    catalogModelContextBytes: 0,
    modelContextBytes: 0,
    cacheWeight: 0,
    inboxCount: 0,
    outboxCount: 0,
    unacknowledgedChanges: 0,
    partitionCount: 0,
    authorizationReResolved: 0,
    changeSetApplyCalls: 0,
    effectCommandExecutions: 0,
    droppedUnacknowledgedChanges: 0
  };
}

export function createConnectorWorkingView({
  grantLookup = "gr.wv.1",
  principalLookup = "prin.wv.1",
  nowMs = Date.now,
  budgets = {}
}: Record<string, any> = {}) : any {
  void principalLookup;
  const limits: any = {
    maxInboxCount: positiveLimit(budgets.maxInboxCount, CONNECTOR_WORKING_VIEW_LIMITS.maxInboxCount),
    maxOutboxCount: positiveLimit(budgets.maxOutboxCount, CONNECTOR_WORKING_VIEW_LIMITS.maxOutboxCount),
    maxInboxBytes: positiveLimit(budgets.maxInboxBytes, CONNECTOR_WORKING_VIEW_LIMITS.maxInboxBytes),
    maxOutboxBytes: positiveLimit(budgets.maxOutboxBytes, CONNECTOR_WORKING_VIEW_LIMITS.maxOutboxBytes),
    maxCacheEntries: positiveLimit(budgets.maxCacheEntries, CONNECTOR_WORKING_VIEW_LIMITS.maxCacheEntries),
    maxCacheWeight: positiveLimit(budgets.maxCacheWeight, CONNECTOR_WORKING_VIEW_LIMITS.maxCacheWeight),
    maxHistoryEntries: positiveLimit(budgets.maxHistoryEntries, CONNECTOR_WORKING_VIEW_LIMITS.maxHistoryEntries),
    maxSubscriptions: positiveLimit(budgets.maxSubscriptions, CONNECTOR_WORKING_VIEW_LIMITS.maxSubscriptions)
  };
  const partitions: any = new Map<any, any>();
  const counters: any = emptyCounters();
  let currentGrant: any = String(grantLookup || "").trim();
  let cancelled: any = false;

  function reResolve(nextGrant: any = currentGrant) : any {
    const resolved: any = String(nextGrant || "").trim();
    if (!resolved) return Object.freeze({ authorizationReResolved: false, partitionPresent: false });
    currentGrant = resolved;
    counters.authorizationReResolved += 1;
    const partition: any = partitions.get(currentGrant);
    return Object.freeze({
      authorizationReResolved: true,
      partitionPresent: Boolean(partition)
    });
  }

  function currentPartition() : any {
    return partitions.get(currentGrant) || null;
  }

  function requirePartition() : any {
    const resolved: any = reResolve(currentGrant);
    if (resolved.authorizationReResolved !== true) return null;
    if (cancelled === true) return null;
    return currentPartition();
  }

  function refreshCounters() : any {
    let cacheWeight: any = 0;
    let inboxCount: any = 0;
    let outboxCount: any = 0;
    let unacknowledged: any = 0;
    for (const partition of partitions.values()) {
      cacheWeight += partition.cacheWeight();
      const inbox: any = partition.inbox.snapshot();
      const outbox: any = partition.outbox.snapshot();
      inboxCount += inbox.count;
      outboxCount += outbox.count;
      unacknowledged += outbox.unacknowledged + inbox.unacknowledged;
    }
    counters.cacheWeight = cacheWeight;
    counters.inboxCount = inboxCount;
    counters.outboxCount = outboxCount;
    counters.unacknowledgedChanges = unacknowledged;
    counters.partitionCount = partitions.size;
    return counters;
  }

  function bindOpen(partition?: any, opened?: any, now?: any) : any {
    const state: any = partition.state;
    state.workingSetId = opened.workingSetId;
    state.confirmedHead = opened.head;
    state.optimisticHead = opened.head;
    state.cursor = opened.cursor;
    state.cacheHint = opened.cacheHint;
    state.handles.clear();
    state.uriByEntity.clear();
    state.confirmedResources.clear();
    state.cache.clear();
    for (const handle of opened.handles) {
      state.handles.set(handle.handle, handle.entityId);
    }
    for (let index = 0; index < opened.entityIds.length; index += 1) {
      const entityId: any = opened.entityIds[index];
      const link: any = opened.resourceLinks.find((entry?: any) : any => (
        String(entry.uri || "").endsWith(`/${entityId}`)
      )) || opened.resourceLinks[index];
      if (!link) continue;
      state.uriByEntity.set(entityId, link.uri);
      state.confirmedResources.set(link.uri, { uri: link.uri, head: link.head, entityId });
      partition.putCache(link, {}, now);
    }
    state.forceMiss = false;
  }

  function ingestObserve(partition?: any, observed?: any, now?: any, { countRemote = true }: Record<string, any> = {}) : any {
    if (countRemote === true) counters.remoteReads += 1;
    const state: any = partition.state;
    if (state.workingSetId && observed.workingSetId !== state.workingSetId) {
      return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    }
    state.workingSetId = observed.workingSetId;
    state.confirmedHead = observed.head;
    state.optimisticHead = Math.max(state.optimisticHead, observed.head);
    state.catalogRevision = observed.catalogRevision;
    state.schemaRevision = observed.schemaRevision;
    state.acknowledgements = [...observed.acknowledgements];
    state.history = [...observed.history].slice(-limits.maxHistoryEntries);
    if (observed.cacheHint?.cacheScope === "private") state.cacheHint = observed.cacheHint;
    for (const link of observed.resourceLinks) {
      partition.putCache(link, {
        catalogRevision: observed.catalogRevision,
        schemaRevision: observed.schemaRevision
      }, now);
    }
    state.forceMiss = false;
    if (state.lastEmittedSchemaRevision && state.lastEmittedSchemaRevision !== observed.schemaRevision) {
      counters.schemaModelContextBytes += 0;
    }
    return Object.freeze({ ok: true, outcome: "accepted", remoteReads: counters.remoteReads });
  }

  function warmEntry(partition?: any, handle?: any, now?: any) : any {
    const state: any = partition.state;
    if (state.forceMiss === true || state.cancelled === true) return null;
    if (connectorLookupFactIsAuthority("handle") || connectorLookupFactIsAuthority("cursor")) return null;
    if (connectorLookupFactIsAuthority("cachedBytes")) return null;
    const entityId: any = state.handles.get(handle);
    if (!entityId) return null;
    const uri: any = state.uriByEntity.get(entityId);
    if (!uri) return null;
    const entry: any = state.cache.get(uri);
    if (!entry || entry.invalidated === true) return null;
    if (entry.cacheScope !== "private") return null;
    if (!(entry.ttlMs > 0) || now - entry.storedAtMs > entry.ttlMs) {
      state.cache.delete(uri);
      return null;
    }
    if (!state.catalogRevision || !state.schemaRevision) return null;
    return entry;
  }

  function localObserveResponse(partition?: any, cacheHit: any = true) : any {
    const state: any = partition.state;
    const resourceLinks: any = [];
    for (const entry of state.cache.values()) {
      resourceLinks.push({
        uri: entry.uri,
        head: entry.head,
        cacheHint: { ttlMs: entry.ttlMs, cacheScope: "private" }
      });
    }
    if (resourceLinks.length === 0) {
      for (const resource of state.confirmedResources.values()) {
        resourceLinks.push({
          uri: resource.uri,
          head: resource.head,
          cacheHint: state.cacheHint
        });
      }
    }
    const response: any = createObserveResponse({
      workingSetId: state.workingSetId,
      head: state.confirmedHead,
      resourceLinks,
      catalogRevision: state.catalogRevision,
      schemaRevision: state.schemaRevision,
      acknowledgements: state.acknowledgements,
      history: state.history,
      cacheHit,
      cacheHint: state.cacheHint.cacheScope === "private"
        ? state.cacheHint
        : { ttlMs: state.cacheHint.ttlMs || 0, cacheScope: "private" }
    });
    if (cacheHit === true) {
      if (state.lastEmittedSchemaRevision === state.schemaRevision) {
        counters.schemaModelContextBytes += 0;
        counters.catalogModelContextBytes += 0;
        counters.modelContextBytes += 0;
      } else {
        state.lastEmittedSchemaRevision = state.schemaRevision;
        counters.schemaModelContextBytes += 0;
        counters.catalogModelContextBytes += 0;
        counters.modelContextBytes += 0;
      }
    }
    return response;
  }

  function acceptOpen(message?: any, now?: any) : any {
    const opened: any = parseOpenResponse(message) || parseCollaborationMessage(message);
    if (!opened || opened.kind !== "open-response") {
      return Object.freeze({ ok: false, outcome: "rejected" });
    }
    reResolve(currentGrant);
    if (cancelled === true) return Object.freeze({ ok: false, outcome: "cancelled" });
    const partition: any = createPartition({ grantLookup: currentGrant, budgets: limits });
    bindOpen(partition, opened, now);
    partitions.set(currentGrant, partition);
    counters.remoteReads += 1;
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: "accepted",
      workingSetId: opened.workingSetId,
      remoteReads: counters.remoteReads
    });
  }

  function acceptCommitAck(message?: any, now?: any) : any {
    const ack: any = parseAcknowledge(message) || parseCollaborationMessage(message);
    if (!ack || ack.kind !== "acknowledge") return Object.freeze({ ok: false, outcome: "rejected" });
    const partition: any = requirePartition();
    if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    const state: any = partition.state;
    if (ack.workingSetId !== state.workingSetId) {
      return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    }
    for (const fact of ack.invalidations) {
      const entry: any = state.cache.get(fact.resourceUri);
      if (entry) {
        entry.invalidated = true;
        state.cache.delete(fact.resourceUri);
      }
    }
    if (ack.conflicts.length === 0) {
      partition.outbox.acknowledgeMatching((item?: any) : any => item.workingSetId === ack.workingSetId);
      state.confirmedHead = ack.assignedHead;
      state.optimisticHead = Math.max(state.optimisticHead, ack.assignedHead);
      const changed: any = new Set<any>(ack.changedEntityIds);
      state.dirtyEntityIds = state.dirtyEntityIds.filter((entityId?: any) : any => !changed.has(entityId));
      state.acknowledgements = [
        ...state.acknowledgements,
        ...ack.resultFacts.map((fact?: any) : any => ({
          head: ack.assignedHead,
          changeId: fact.code
        }))
      ].slice(-limits.maxHistoryEntries);
    }
    partition.evictExpired(now);
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: "acknowledged",
      assignedHead: ack.assignedHead,
      unacknowledgedChanges: partition.outbox.snapshot().unacknowledged
    });
  }

  function acceptNotification(message?: any, now?: any) : any {
    const updated: any = parseResourceUpdatedNotification(message) || parseCollaborationMessage(message);
    if (!updated || updated.kind !== "resource-updated") {
      return Object.freeze({ ok: false, outcome: "rejected" });
    }
    const partition: any = requirePartition();
    if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    const queued: any = partition.inbox.tryPush({
      kind: "resource-updated",
      resourceUri: updated.resourceUri,
      head: updated.head,
      invalidationCodes: updated.invalidationCodes,
      acknowledged: false,
      byteLength: messageBytes({
        kind: updated.kind,
        resourceUri: updated.resourceUri,
        head: updated.head,
        invalidationCodes: updated.invalidationCodes
      })
    });
    if (queued.ok !== true) {
      partition.state.forceMiss = true;
      refreshCounters();
      return Object.freeze({
        ok: false,
        outcome: "backpressure",
        dropped: 0,
        unacknowledgedChanges: refreshCounters().unacknowledgedChanges
      });
    }
    const entry: any = partition.state.cache.get(updated.resourceUri);
    if (entry) {
      entry.invalidated = true;
      partition.state.cache.delete(updated.resourceUri);
    }
    if (updated.cursor) partition.state.cursor = updated.cursor;
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: "queued",
      dropped: 0,
      unacknowledgedChanges: partition.inbox.snapshot().unacknowledged
    });
  }

  function acceptResync(message?: any, now?: any) : any {
    const resync: any = parseResyncResponse(message) || parseCollaborationMessage(message);
    if (!resync || resync.kind !== "resync-response") {
      return Object.freeze({ ok: false, outcome: "rejected" });
    }
    const partition: any = requirePartition();
    if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    const state: any = partition.state;
    if (resync.workingSetId !== state.workingSetId) {
      return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    }
    if (["overload", "resync_required", "cancelled", "backpressure"].includes(resync.outcome)) {
      if (resync.outcome === "cancelled") state.cancelled = true;
      if (resync.outcome === "backpressure" || resync.outcome === "overload") state.forceMiss = true;
      refreshCounters();
      return Object.freeze({
        ok: true,
        outcome: resync.outcome,
        dropped: 0,
        unacknowledgedChanges: partition.outbox.snapshot().unacknowledged
      });
    }
    counters.remoteReads += 1;
    state.confirmedHead = resync.head;
    state.optimisticHead = Math.max(state.optimisticHead, resync.head);
    state.cursor = resync.cursor;
    state.forceMiss = false;
    if (resync.outcome === "snapshot-tail" && resync.snapshot) {
      for (const uri of resync.snapshot.resourceUris) {
        partition.putCache({
          uri,
          head: resync.snapshot.head,
          cacheHint: state.cacheHint.cacheScope === "private"
            ? state.cacheHint
            : { ttlMs: 60000, cacheScope: "private" }
        }, {
          catalogRevision: state.catalogRevision,
          schemaRevision: state.schemaRevision
        }, now);
      }
    }
    if (resync.outcome === "delta") {
      for (const delta of resync.deltas) {
        const uri: any = state.uriByEntity.get(delta.operation.entityId);
        if (!uri) continue;
        const existing: any = state.cache.get(uri);
        partition.putCache({
          uri,
          head: delta.head,
          cacheHint: existing
            ? { ttlMs: existing.ttlMs, cacheScope: "private" }
            : (state.cacheHint.cacheScope === "private" ? state.cacheHint : { ttlMs: 60000, cacheScope: "private" })
        }, {
          catalogRevision: state.catalogRevision,
          schemaRevision: state.schemaRevision
        }, now);
      }
    }
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: resync.outcome,
      dropped: 0,
      remoteReads: counters.remoteReads,
      unacknowledgedChanges: partition.outbox.snapshot().unacknowledged
    });
  }

  function acceptRemote(value?: any) : any {
    const now: any = nowMs();
    if (containsForbiddenKeys(value)) return Object.freeze({ ok: false, outcome: "rejected" });
    let message: any = value;
    if (value?.jsonrpc === CONNECTOR_WORKING_VIEW_JSONRPC_VERSION) {
      const envelope: any = parseConnectorMcpEnvelope(value);
      if (!envelope) return Object.freeze({ ok: false, outcome: "rejected" });
      message = envelope.params;
    }
    const parsed: any = parseCollaborationMessage(message) || message;
    if (!parsed || typeof parsed !== "object") return Object.freeze({ ok: false, outcome: "rejected" });
    if (parsed.kind === "effect-command") {
      return Object.freeze({
        ok: false,
        outcome: "effect-command-not-executed",
        effectCommandExecutions: counters.effectCommandExecutions
      });
    }
    if (parsed.kind === "open-response") return acceptOpen(parsed, now);
    if (parsed.kind === "observe-response") {
      const partition: any = requirePartition();
      if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
      const observed: any = parseObserveResponse(parsed);
      if (!observed) return Object.freeze({ ok: false, outcome: "rejected" });
      const result: any = ingestObserve(partition, observed, now, { countRemote: true });
      refreshCounters();
      return result;
    }
    if (parsed.kind === "acknowledge") return acceptCommitAck(parsed, now);
    if (parsed.kind === "resource-updated") return acceptNotification(parsed, now);
    if (parsed.kind === "resync-response") return acceptResync(parsed, now);
    if (parsed.kind === "subscribe-request") {
      const partition: any = requirePartition();
      if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
      const subscribe: any = parseSubscribeRequest(parsed);
      if (!subscribe) return Object.freeze({ ok: false, outcome: "rejected" });
      if (partition.state.subscriptions >= limits.maxSubscriptions) {
        return Object.freeze({ ok: false, outcome: "backpressure", dropped: 0 });
      }
      partition.state.subscriptions += 1;
      return Object.freeze({ ok: true, outcome: "accepted" });
    }
    return Object.freeze({ ok: false, outcome: "rejected" });
  }

  function hydrate({ open, observe, grantLookup: nextGrant }: Record<string, any> = {}) : any {
    if (nextGrant) reResolve(nextGrant);
    const opened: any = acceptOpen(open, nowMs());
    if (opened.ok !== true) return opened;
    if (observe) {
      const partition: any = currentPartition();
      const observed: any = parseObserveResponse(observe) || parseCollaborationMessage(observe);
      if (!partition || !observed || observed.kind !== "observe-response") {
        return Object.freeze({ ok: false, outcome: "rejected" });
      }
      ingestObserve(partition, observed, nowMs(), { countRemote: false });
      partition.state.lastEmittedSchemaRevision = observed.schemaRevision;
      refreshCounters();
    }
    return Object.freeze({
      ok: true,
      outcome: "hydrated",
      remoteReads: counters.remoteReads
    });
  }

  function observeLocal({ handle, cursor }: Record<string, any> = {}) : any {
    void cursor;
    const partition: any = requirePartition();
    const now: any = nowMs();
    if (!partition) {
      counters.cacheMisses += 1;
      return Object.freeze({
        ok: false,
        cacheHit: false,
        outcome: "conflict.authorization_changed",
        remoteReads: 0,
        modelContextBytes: 0,
        schemaModelContextBytes: 0,
        needsRemote: true
      });
    }
    partition.evictExpired(now);
    const resolvedHandle: any = handle || [...partition.state.handles.keys()][0];
    const entry: any = warmEntry(partition, resolvedHandle, now);
    if (!entry) {
      counters.cacheMisses += 1;
      refreshCounters();
      return Object.freeze({
        ok: true,
        cacheHit: false,
        outcome: "cache-miss",
        remoteReads: 0,
        modelContextBytes: 0,
        schemaModelContextBytes: 0,
        needsRemote: true
      });
    }
    let response: any = null;
    let cacheContract: any = "";
    try {
      response = localObserveResponse(partition, true);
      cacheContract = assertObserveCacheHit(response);
    } catch {
      counters.cacheMisses += 1;
      refreshCounters();
      return Object.freeze({
        ok: true,
        cacheHit: false,
        outcome: "cache-miss",
        remoteReads: 0,
        modelContextBytes: 0,
        schemaModelContextBytes: 0,
        needsRemote: true
      });
    }
    counters.cacheHits += 1;
    refreshCounters();
    return Object.freeze({
      ok: true,
      cacheHit: true,
      outcome: cacheContract,
      response,
      remoteReads: 0,
      modelContextBytes: 0,
      schemaModelContextBytes: 0,
      needsRemote: false
    });
  }

  function editLocal({ dirtyEntityIds = [] }: Record<string, any> = {}) : any {
    const partition: any = requirePartition();
    if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    const state: any = partition.state;
    const ids: any = Array.isArray(dirtyEntityIds) ? [...new Set<any>(dirtyEntityIds)] : [];
    state.dirtyEntityIds = ids;
    state.omittedUnchanged = true;
    const view: any = createEditView({
      workingSetId: state.workingSetId,
      head: state.confirmedHead,
      dirtyEntityIds: ids
    });
    counters.schemaModelContextBytes += 0;
    counters.modelContextBytes += 0;
    return Object.freeze({
      ok: true,
      outcome: "edited",
      view,
      omittedUnchanged: true,
      schemaModelContextBytes: 0,
      modelContextBytes: 0,
      confirmedHead: state.confirmedHead,
      changeSetApplyCalls: counters.changeSetApplyCalls
    });
  }

  function queueCommit(message?: any) : any {
    const partition: any = requirePartition();
    if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    if (partition.state.cancelled === true || cancelled === true) {
      return Object.freeze({ ok: false, outcome: "cancelled", dropped: 0 });
    }
    const parsed: any = parseCommitRequest(message) || parseCollaborationMessage(message);
    if (!parsed || parsed.kind !== "commit-request") return Object.freeze({ ok: false, outcome: "rejected" });
    try {
      assertCommitTurn(parsed);
    } catch {
      return Object.freeze({ ok: false, outcome: "rejected" });
    }
    if (parsed.workingSetId !== partition.state.workingSetId) {
      return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    }
    if (parsed.dirty === true) {
      const queued: any = partition.outbox.tryPush({
        kind: "commit-request",
        workingSetId: parsed.workingSetId,
        changeId: parsed.changeSet.changeId,
        acknowledged: false,
        byteLength: messageBytes({
          kind: parsed.kind,
          workingSetId: parsed.workingSetId,
          changeId: parsed.changeSet.changeId,
          dirty: true
        })
      });
      refreshCounters();
      if (queued.ok !== true) {
        return Object.freeze({
          ok: false,
          outcome: "backpressure",
          dropped: 0,
          unacknowledgedChanges: queued.unacknowledged,
          confirmedHead: partition.state.confirmedHead,
          changeSetApplyCalls: counters.changeSetApplyCalls
        });
      }
    }
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: parsed.dirty === true ? "queued" : "clean",
      dropped: 0,
      unacknowledgedChanges: partition.outbox.snapshot().unacknowledged,
      confirmedHead: partition.state.confirmedHead,
      changeSetApplyCalls: counters.changeSetApplyCalls
    });
  }

  function subscribe(message?: any) : any {
    return acceptRemote(message);
  }

  function drainInbox() : any {
    const partition: any = requirePartition();
    if (!partition) return Object.freeze({ ok: false, outcome: "conflict.authorization_changed" });
    partition.inbox.markAcknowledged(() : any => true);
    partition.inbox.compactAcknowledged();
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: "drained",
      unacknowledgedChanges: partition.inbox.snapshot().unacknowledged
    });
  }

  function revoke({ grantLookup: targetGrant }: Record<string, any> = {}) : any {
    const resolved: any = String(targetGrant || currentGrant || "").trim();
    reResolve(resolved);
    const partition: any = partitions.get(resolved);
    if (!partition) {
      return Object.freeze({ ok: true, outcome: "absent", purged: false });
    }
    partition.inbox.clear();
    partition.outbox.clear();
    partition.state.cache.clear();
    partition.state.handles.clear();
    partition.state.uriByEntity.clear();
    partition.state.confirmedResources.clear();
    partitions.delete(resolved);
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: "purged",
      purged: true,
      partitionPresent: partitions.has(resolved)
    });
  }

  function cancel() : any {
    cancelled = true;
    const partition: any = currentPartition();
    if (partition) partition.state.cancelled = true;
    refreshCounters();
    return Object.freeze({
      ok: true,
      outcome: "cancelled",
      dropped: 0,
      unacknowledgedChanges: counters.unacknowledgedChanges
    });
  }

  function snapshot() : any {
    refreshCounters();
    const facts: any = Object.freeze({
      schemaVersion: CONNECTOR_WORKING_VIEW_SCHEMA_VERSION,
      coreStateGeneration: SERVICE_COLLABORATION_CORE_STATE_GENERATION,
      protocolVersion: SERVICE_COLLABORATION_PROTOCOL_VERSION,
      capacityCertified: CONNECTOR_WORKING_VIEW_CAPACITY_CERTIFIED,
      nonCertificationReason: CONNECTOR_WORKING_VIEW_NON_CERTIFICATION_REASON,
      lookupFactsAreAuthority: false,
      changeSetApplyCalls: counters.changeSetApplyCalls,
      effectCommandExecutions: counters.effectCommandExecutions,
      droppedUnacknowledgedChanges: counters.droppedUnacknowledgedChanges,
      remoteReads: counters.remoteReads,
      cacheHits: counters.cacheHits,
      cacheMisses: counters.cacheMisses,
      schemaModelContextBytes: counters.schemaModelContextBytes,
      catalogModelContextBytes: counters.catalogModelContextBytes,
      modelContextBytes: counters.modelContextBytes,
      cacheWeight: counters.cacheWeight,
      inboxCount: counters.inboxCount,
      outboxCount: counters.outboxCount,
      unacknowledgedChanges: counters.unacknowledgedChanges,
      partitionCount: counters.partitionCount,
      grantReResolved: counters.authorizationReResolved > 0
    });
    if (containsForbiddenKeys(facts)) {
      throw new Error("Connector Working View snapshot must remain privacy-safe.");
    }
    return facts;
  }

  refreshCounters();
  return Object.freeze({
    schemaVersion: CONNECTOR_WORKING_VIEW_SCHEMA_VERSION,
    reResolve,
    hydrate,
    acceptRemote,
    observeLocal,
    editLocal,
    queueCommit,
    subscribe,
    drainInbox,
    revoke,
    cancel,
    projectMcp: projectConnectorMcpEnvelope,
    parseMcp: parseConnectorMcpEnvelope,
    lookupFactIsAuthority: connectorLookupFactIsAuthority,
    counters() : any {
      return Object.freeze({ ...refreshCounters() });
    },
    snapshot,
    currentGrant() : any {
      return currentGrant;
    },
    partitionPresent(targetGrant: any = currentGrant) : any {
      return partitions.has(String(targetGrant || "").trim());
    }
  });
}
