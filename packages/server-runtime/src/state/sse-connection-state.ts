import { createHash } from "node:crypto";
import { normalizeMcpProxySessionId } from "#meshrix/contracts/mcp-catalog-delivery";

export const MCP_SSE_CONNECTION_LIMITS: Readonly<Record<string, any>> = Object.freeze({
  total: 256,
  perRemoteAddress: 32,
  perGrant: 16,
  perPartition: 16,
  maxBufferedBytes: 64 * 1024,
  maxPendingNotifications: 8,
  maxCohortRecords: 512,
  acknowledgementTimeoutMs: 10_000
});

const HEARTBEAT_INTERVAL_MS: any = 15_000;
const activeSseConnections: any = new Set<any>();
const connectionsByRemoteAddress: any = new Map<any, any>();
const connectionsByGrant: any = new Map<any, any>();
const connectionsByGrantDigest: any = new Map<any, any>();
const connectionsByPartition: any = new Map<any, any>();
const connectionsByProxySession: any = new Map<any, any>();
const convergenceCohort: any = new Map<any, any>();
const fencedProxySessions: any = new Map<any, any>();
let heartbeatTimer: any = null;

function boundedIdentity(value?: any, maxBytes: any = 1_024) : any {
  const normalized: any = String(value || "").trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes
    ? normalized
    : "";
}

function digestIdentity(value?: any) : any {
  const normalized: any = boundedIdentity(value);
  return normalized ? createHash("sha256").update(normalized).digest("base64url") : "";
}

function countFor(index?: any, key?: any) : any {
  return key ? Number(index.get(key) || 0) : 0;
}

function incrementCount(index?: any, key?: any) : any {
  index.set(key, countFor(index, key) + 1);
}

function decrementCount(index?: any, key?: any) : any {
  const remaining: any = countFor(index, key) - 1;
  if (remaining > 0) index.set(key, remaining);
  else index.delete(key);
}

function addToSetIndex(index?: any, key?: any, connection?: any) : any {
  if (!key) return;
  const bucket: any = index.get(key) || new Set<any>();
  bucket.add(connection);
  index.set(key, bucket);
}

function removeFromSetIndex(index?: any, key?: any, connection?: any) : any {
  if (!key) return;
  const bucket: any = index.get(key);
  if (!bucket) return;
  bucket.delete(connection);
  if (bucket.size === 0) index.delete(key);
}

function closeResponse(response?: any) : any {
  try {
    if (typeof response?.destroy === "function") response.destroy();
    else response?.end?.();
  } catch {
    // The socket is already unavailable.
  }
}

function removeConnection(connection?: any, { close = false }: Record<string, any> = {}) : any {
  if (!connection || !activeSseConnections.delete(connection)) return false;
  decrementCount(connectionsByRemoteAddress, connection.remoteAddress);
  decrementCount(connectionsByGrant, connection.grantId);
  removeFromSetIndex(connectionsByGrantDigest, connection.grantIdDigest, connection);
  removeFromSetIndex(connectionsByProxySession, connection.proxySessionId, connection);
  for (const partitionKey of connection.partitionKeys || []) {
    removeFromSetIndex(connectionsByPartition, partitionKey, connection);
  }
  if (connection.acknowledgementTimer) {
    clearTimeout(connection.acknowledgementTimer);
    connection.acknowledgementTimer = null;
  }
  if (connection.pendingConvergenceHistory?.length > 0) {
    for (const pending of connection.pendingConvergenceHistory) {
      recordConvergenceOutcome(connection, close ? "fenced" : "disconnected", pending);
    }
  }
  if (activeSseConnections.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (close) closeResponse(connection.response);
  return true;
}

function cohortKey(connection?: any, pending: any = connection?.pendingConvergence) : any {
  if (!connection?.grantIdDigest || !connection?.proxySessionId || !pending) return "";
  return createHash("sha256")
    .update(connection.grantIdDigest)
    .update(":")
    .update(connection.proxySessionId)
    .update(":")
    .update(String(pending.sourceRevision))
    .digest("base64url");
}

function proxySessionKey(grantIdDigest?: any, proxySessionId?: any) : any {
  if (!grantIdDigest || !proxySessionId) return "";
  return createHash("sha256").update(grantIdDigest).update(":").update(proxySessionId).digest("base64url");
}

function fenceProxySession(connection?: any, pending: any = connection?.pendingConvergence) : any {
  const key: any = proxySessionKey(connection?.grantIdDigest, connection?.proxySessionId);
  if (!key || !pending) return;
  if (!fencedProxySessions.has(key) && fencedProxySessions.size >= MCP_SSE_CONNECTION_LIMITS.maxCohortRecords) {
    fencedProxySessions.delete(fencedProxySessions.keys().next().value);
  }
  fencedProxySessions.set(key, Object.freeze({ sourceRevision: pending.sourceRevision }));
}

function recordConvergenceOutcome(connection?: any, outcome?: any, pending: any = connection?.pendingConvergence) : any {
  const key: any = cohortKey(connection, pending);
  if (!key || !["pending", "applied", "disconnected", "fenced"].includes(outcome)) return;
  if (!convergenceCohort.has(key) && convergenceCohort.size >= MCP_SSE_CONNECTION_LIMITS.maxCohortRecords) {
    convergenceCohort.delete(convergenceCohort.keys().next().value);
  }
  convergenceCohort.set(key, Object.freeze({
    outcome,
    sourceRevision: pending.sourceRevision,
    audienceRevision: pending.audienceRevision,
    catalogRevision: pending.catalogRevision,
    partitionCount: pending.partitionKeys.length
  }));
}

function scheduleConvergenceAcknowledgement(connection?: any, payload?: any) : any {
  const change: any = payload?.params?.change;
  const partitionKeys: any = normalizePartitionKeys(change?.affectedPartitions || [])
    .filter((key?: any) : any => connection.partitionKeys.includes(key));
  if (partitionKeys.length === 0 || !Number.isSafeInteger(change?.sourceRevision) ||
      !Number.isSafeInteger(change?.audienceRevision) || !boundedIdentity(change?.catalogRevision, 256)) return;
  if (connection.acknowledgementTimer) clearTimeout(connection.acknowledgementTimer);
  connection.pendingConvergence = Object.freeze({
    sourceRevision: change.sourceRevision,
    audienceRevision: change.audienceRevision,
    catalogRevision: boundedIdentity(change.catalogRevision, 256),
    partitionKeys: Object.freeze(partitionKeys)
  });
  const history: any = connection.pendingConvergenceHistory;
  const priorIndex: any = history.findIndex((entry?: any) : any =>
    entry.sourceRevision === connection.pendingConvergence.sourceRevision &&
    entry.audienceRevision === connection.pendingConvergence.audienceRevision);
  if (priorIndex >= 0) history[priorIndex] = connection.pendingConvergence;
  else history.push(connection.pendingConvergence);
  while (history.length > MCP_SSE_CONNECTION_LIMITS.maxPendingNotifications) {
    recordConvergenceOutcome(connection, "fenced", history.shift());
  }
  recordConvergenceOutcome(connection, "pending", connection.pendingConvergence);
  connection.acknowledgementTimer = setTimeout(() : any => {
    connection.acknowledgementTimer = null;
    if (activeSseConnections.has(connection) && connection.pendingConvergence) {
      connection.fenced = true;
      fenceProxySession(connection);
      removeConnection(connection, { close: true });
    }
  }, MCP_SSE_CONNECTION_LIMITS.acknowledgementTimeoutMs);
  connection.acknowledgementTimer.unref?.();
}

function writeConnection(connection?: any, chunk?: any) : any {
  const response: any = connection?.response;
  if (
    !connection ||
    !activeSseConnections.has(connection) ||
    response?.destroyed === true ||
    response?.writableEnded === true
  ) {
    removeConnection(connection);
    return false;
  }
  try {
    const accepted: any = response.write(String(chunk));
    const bufferedBytes: any = Number(response.writableLength || 0);
    if (accepted === false || bufferedBytes > MCP_SSE_CONNECTION_LIMITS.maxBufferedBytes) {
      removeConnection(connection, { close: true });
      return false;
    }
    return true;
  } catch {
    removeConnection(connection, { close: true });
    return false;
  }
}

function ensureHeartbeatScheduler() : any {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() : any => {
    for (const connection of [...activeSseConnections]) {
      writeConnection(connection, ":\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function capacityFailure(code?: any) : any {
  return {
    ok: false,
    status: 429,
    code
  };
}

function normalizePartitionKeys(values: any = []) : any {
  return [...new Set<any>(
    (Array.isArray(values) ? values : [values])
      .map((value?: any) : any => boundedIdentity(value, 256))
      .filter(Boolean)
  )].sort();
}

function normalizeCapabilities(values: any = []) : any {
  return [...new Set<any>(
    (Array.isArray(values) ? values : [values])
      .map((value?: any) : any => boundedIdentity(value, 128))
      .filter(Boolean)
  )].sort();
}

/**
 * Bind opaque audience partition keys onto an active SSE connection.
 * Keys never embed raw subjects or tags.
 */
export function bindMcpSseConnectionPartitions(connection?: any, partitionKeys: any = []) : any {
  if (!connection || !activeSseConnections.has(connection)) return false;
  const nextKeys: any = normalizePartitionKeys(partitionKeys);
  for (const key of connection.partitionKeys || []) {
    removeFromSetIndex(connectionsByPartition, key, connection);
  }
  connection.partitionKeys = Object.freeze(nextKeys);
  for (const key of nextKeys) {
    addToSetIndex(connectionsByPartition, key, connection);
  }
  return true;
}

export function registerMcpSseConnection({
  request,
  response,
  grantId = "",
  grant = null,
  privateOnly = true,
  partitionKeys = [],
  negotiatedCapabilities = [],
  proxySessionId = ""
}: Record<string, any> = {}) : any {
  const normalizedGrantId: any = boundedIdentity(grantId);
  const remoteAddress: any = boundedIdentity(request?.socket?.remoteAddress);
  const normalizedProxySessionId: any = normalizeMcpProxySessionId(proxySessionId);
  const normalizedCapabilities: any = normalizeCapabilities(negotiatedCapabilities);
  if (
    !normalizedGrantId ||
    !remoteAddress ||
    typeof response?.write !== "function" ||
    (typeof request?.once !== "function" && typeof request?.on !== "function")
  ) {
    return {
      ok: false,
      status: 503,
      code: "mcp_sse_registration_invalid"
    };
  }
  if (normalizedCapabilities.includes("notifications/tools/list_changed") &&
      !normalizedProxySessionId) {
    return {
      ok: false,
      status: 400,
      code: "mcp_sse_convergence_session_required"
    };
  }
  if (activeSseConnections.size >= MCP_SSE_CONNECTION_LIMITS.total) {
    return capacityFailure("mcp_sse_total_capacity_exceeded");
  }
  if (
    countFor(connectionsByRemoteAddress, remoteAddress) >=
      MCP_SSE_CONNECTION_LIMITS.perRemoteAddress
  ) {
    return capacityFailure("mcp_sse_remote_capacity_exceeded");
  }
  if (countFor(connectionsByGrant, normalizedGrantId) >= MCP_SSE_CONNECTION_LIMITS.perGrant) {
    return capacityFailure("mcp_sse_grant_capacity_exceeded");
  }
  const normalizedPartitionKeys: any = normalizePartitionKeys(partitionKeys);
  if (normalizedPartitionKeys.some((key?: any) : any =>
    (connectionsByPartition.get(key)?.size || 0) >= MCP_SSE_CONNECTION_LIMITS.perPartition)) {
    return capacityFailure("mcp_sse_partition_capacity_exceeded");
  }

  const grantIdDigest: any = digestIdentity(normalizedGrantId);
  if (normalizedCapabilities.includes("notifications/tools/list_changed") &&
      fencedProxySessions.has(proxySessionKey(grantIdDigest, normalizedProxySessionId))) {
    return {
      ok: false,
      status: 409,
      code: "mcp_sse_convergence_session_fenced"
    };
  }
  const connection: Record<string, any> = {
    response,
    remoteAddress,
    grantId: normalizedGrantId,
    grantIdDigest,
    proxySessionId: normalizedProxySessionId,
    grant,
    privateOnly: privateOnly !== false,
    negotiatedCapabilities: Object.freeze(normalizedCapabilities),
    partitionKeys: Object.freeze([]),
    pendingNotifications: [],
    pendingConvergenceHistory: [],
    appliedAudienceRevision: 0,
    fenced: false
  };
  activeSseConnections.add(connection);
  incrementCount(connectionsByRemoteAddress, remoteAddress);
  incrementCount(connectionsByGrant, normalizedGrantId);
  addToSetIndex(connectionsByGrantDigest, grantIdDigest, connection);
  addToSetIndex(connectionsByProxySession, connection.proxySessionId, connection);
  bindMcpSseConnectionPartitions(connection, normalizedPartitionKeys);
  ensureHeartbeatScheduler();

  const onClose: any = () : any => removeConnection(connection);
  if (typeof request.once === "function") request.once("close", onClose);
  else request.on("close", onClose);

  return {
    ok: true,
    status: 200,
    connection,
    write: (chunk?: any) : any => writeConnection(connection, chunk),
    close: () : any => removeConnection(connection, { close: true })
  };
}

function enqueueOrWrite(connection?: any, message?: any, { coalesceKey = "" }: Record<string, any> = {}) : any {
  if (coalesceKey && Array.isArray(connection.pendingNotifications)) {
    const pending: any = connection.pendingNotifications;
    const existingIndex: any = pending.findIndex((item?: any) : any => item.coalesceKey === coalesceKey);
    if (existingIndex >= 0) {
      pending[existingIndex] = { coalesceKey, message };
    } else if (pending.length >= MCP_SSE_CONNECTION_LIMITS.maxPendingNotifications) {
      // Coalesce to newest: drop oldest, keep the new revision.
      pending.shift();
      pending.push({ coalesceKey, message });
    } else {
      pending.push({ coalesceKey, message });
    }
    const next: any = pending.shift();
    return writeConnection(connection, next.message);
  }
  return writeConnection(connection, message);
}

export function broadcastMcpNotification(payload?: any, {
  grantId = "",
  includePrivate = false,
  partitionKeys = null,
  grantIdDigests = null,
  coalesceKey = ""
}: Record<string, any> = {}) : any {
  let delivered: any = 0;
  let matched: any = 0;
  const scopedGrantId: any = boundedIdentity(grantId);
  const partitionKeySet: any = Array.isArray(partitionKeys)
    ? new Set<any>(normalizePartitionKeys(partitionKeys))
    : null;
  const grantDigestSet: any = Array.isArray(grantIdDigests)
    ? new Set<any>(grantIdDigests.map((value?: any) : any => boundedIdentity(value, 256)).filter(Boolean))
    : null;
  const candidates: any = new Set<any>();

  if (partitionKeySet && partitionKeySet.size > 0) {
    for (const key of partitionKeySet) {
      for (const connection of connectionsByPartition.get(key) || []) {
        candidates.add(connection);
      }
    }
  }
  if (grantDigestSet && grantDigestSet.size > 0) {
    for (const digest of grantDigestSet) {
      for (const connection of connectionsByGrantDigest.get(digest) || []) {
        candidates.add(connection);
      }
    }
  }
  if ((!partitionKeySet || partitionKeySet.size === 0) && (!grantDigestSet || grantDigestSet.size === 0)) {
    for (const connection of activeSseConnections) {
      candidates.add(connection);
    }
  }

  for (const connection of candidates) {
    if (scopedGrantId && connection.grantId !== scopedGrantId) continue;
    if (!scopedGrantId && !includePrivate && connection.privateOnly === true &&
        !(partitionKeySet?.size > 0 || grantDigestSet?.size > 0)) {
      continue;
    }
    if (payload?.method && !connection.negotiatedCapabilities.includes(payload.method)) {
      continue;
    }
    let deliveredPayload: any = payload;
    if (payload?.method === "notifications/tools/list_changed") {
      const affected: any = normalizePartitionKeys(payload?.params?.change?.affectedPartitions || []);
      const scopedAffected: any = affected.filter((key?: any) : any => connection.partitionKeys.includes(key));
      if (affected.length > 0 && scopedAffected.length === 0) continue;
      deliveredPayload = {
        ...payload,
        params: {
          ...(payload.params || {}),
          change: {
            ...(payload.params?.change || {}),
            affectedPartitions: scopedAffected
          }
        }
      };
    }
    const message: any = `event: message\ndata: ${JSON.stringify(deliveredPayload)}\n\n`;
    matched += 1;
    if (enqueueOrWrite(connection, message, { coalesceKey })) {
      delivered += 1;
      if (deliveredPayload?.method === "notifications/tools/list_changed") {
        scheduleConvergenceAcknowledgement(connection, deliveredPayload);
      }
    }
  }
  return {
    activeConnectionCount: activeSseConnections.size,
    matchedConnectionCount: matched,
    deliveredConnectionCount: delivered,
    partitionMatchCount: partitionKeySet?.size || 0,
    grantDigestMatchCount: grantDigestSet?.size || 0
  };
}

export function markMcpSseConnectionApplied(connection?: any, audienceRevision: any = 0) : any {
  if (!connection || !activeSseConnections.has(connection)) return false;
  const revision: any = Number(audienceRevision) || 0;
  if (revision < Number(connection.appliedAudienceRevision || 0)) return false;
  connection.appliedAudienceRevision = revision;
  connection.fenced = false;
  return true;
}

export function acknowledgeMcpCatalogConvergence({
  grantId = "",
  proxySessionId = "",
  sourceRevision = -1,
  audienceRevision = -1,
  catalogRevision = "",
  partitionKeys = []
}: Record<string, any> = {}) : any {
  const sessionId: any = normalizeMcpProxySessionId(proxySessionId);
  const normalizedGrantId: any = boundedIdentity(grantId);
  const keys: any = normalizePartitionKeys(partitionKeys);
  let applied: any = 0;
  for (const connection of connectionsByProxySession.get(sessionId) || []) {
    const pending: any = connection.pendingConvergence;
    if (!pending || connection.grantId !== normalizedGrantId) continue;
    const normalizedCatalogRevision: any = boundedIdentity(catalogRevision, 256);
    const acknowledged: any = connection.pendingConvergenceHistory.find((entry?: any) : any =>
      entry.sourceRevision === sourceRevision &&
      entry.audienceRevision === audienceRevision &&
      entry.catalogRevision === normalizedCatalogRevision &&
      entry.partitionKeys.length === keys.length &&
      entry.partitionKeys.every((key?: any, index?: any) : any => key === keys[index]));
    if (!acknowledged) continue;
    if (connection.acknowledgementTimer) clearTimeout(connection.acknowledgementTimer);
    connection.acknowledgementTimer = null;
    const remaining: any[] = [];
    for (const cohortEntry of connection.pendingConvergenceHistory) {
      if (cohortEntry.sourceRevision <= sourceRevision &&
          cohortEntry.audienceRevision <= audienceRevision &&
          cohortEntry.partitionKeys.length === keys.length &&
          cohortEntry.partitionKeys.every((key?: any, index?: any) : any => key === keys[index])) {
        recordConvergenceOutcome(connection, "applied", cohortEntry);
      } else {
        remaining.push(cohortEntry);
      }
    }
    connection.pendingConvergenceHistory = remaining;
    connection.pendingConvergence = remaining.at(-1) || null;
    if (connection.pendingConvergence) {
      const latest: any = connection.pendingConvergence;
      connection.acknowledgementTimer = setTimeout(() : any => {
        connection.acknowledgementTimer = null;
        if (activeSseConnections.has(connection) && connection.pendingConvergence === latest) {
          connection.fenced = true;
          fenceProxySession(connection, latest);
          removeConnection(connection, { close: true });
        }
      }, MCP_SSE_CONNECTION_LIMITS.acknowledgementTimeoutMs);
      connection.acknowledgementTimer.unref?.();
    }
    connection.appliedAudienceRevision = audienceRevision;
    connection.fenced = false;
    applied += 1;
  }
  return Object.freeze({ ok: applied > 0, appliedConnectionCount: applied });
}

export function getMcpCatalogConvergenceCohort() : any {
  return Object.freeze([...convergenceCohort.values()]);
}

export function fenceMcpSseConnection(connection?: any, { close = true }: Record<string, any> = {}) : any {
  if (!connection || !activeSseConnections.has(connection)) return false;
  connection.fenced = true;
  if (close) removeConnection(connection, { close: true });
  return true;
}

export function disconnectMcpSseConnectionsByGrant(grantId: any = "") : any {
  const normalizedGrantId: any = boundedIdentity(grantId);
  if (!normalizedGrantId) return Object.freeze({ disconnectedConnectionCount: 0 });
  let disconnected: any = 0;
  for (const connection of [...activeSseConnections]) {
    if (connection.grantId !== normalizedGrantId) continue;
    if (removeConnection(connection, { close: true })) disconnected += 1;
  }
  return Object.freeze({ disconnectedConnectionCount: disconnected });
}

export function getMcpSseConnectionState() : any {
  return {
    activeConnectionCount: activeSseConnections.size,
    heartbeatSchedulerActive: heartbeatTimer !== null,
    remoteAddressCount: connectionsByRemoteAddress.size,
    grantCount: connectionsByGrant.size,
    grantDigestCount: connectionsByGrantDigest.size,
    partitionCount: connectionsByPartition.size,
    cohortRecordCount: convergenceCohort.size
  };
}

/** Test helper: reset in-memory SSE indexes. */
export function resetMcpSseConnectionStateForTests() : any {
  for (const connection of [...activeSseConnections]) {
    removeConnection(connection, { close: true });
  }
  connectionsByRemoteAddress.clear();
  connectionsByGrant.clear();
  connectionsByGrantDigest.clear();
  connectionsByPartition.clear();
  connectionsByProxySession.clear();
  convergenceCohort.clear();
  fencedProxySessions.clear();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
