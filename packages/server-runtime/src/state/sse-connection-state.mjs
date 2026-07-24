import { createHash } from "node:crypto";
import { normalizeMcpProxySessionId } from "#meshrix/contracts/mcp-catalog-delivery";

export const MCP_SSE_CONNECTION_LIMITS = Object.freeze({
  total: 256,
  perRemoteAddress: 32,
  perGrant: 16,
  perPartition: 16,
  maxBufferedBytes: 64 * 1024,
  maxPendingNotifications: 8,
  maxCohortRecords: 512,
  acknowledgementTimeoutMs: 10_000
});

const HEARTBEAT_INTERVAL_MS = 15_000;
const activeSseConnections = new Set();
const connectionsByRemoteAddress = new Map();
const connectionsByGrant = new Map();
const connectionsByGrantDigest = new Map();
const connectionsByPartition = new Map();
const connectionsByProxySession = new Map();
const convergenceCohort = new Map();
const fencedProxySessions = new Map();
let heartbeatTimer = null;

function boundedIdentity(value, maxBytes = 1_024) {
  const normalized = String(value || "").trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes
    ? normalized
    : "";
}

function digestIdentity(value) {
  const normalized = boundedIdentity(value);
  return normalized ? createHash("sha256").update(normalized).digest("base64url") : "";
}

function countFor(index, key) {
  return key ? Number(index.get(key) || 0) : 0;
}

function incrementCount(index, key) {
  index.set(key, countFor(index, key) + 1);
}

function decrementCount(index, key) {
  const remaining = countFor(index, key) - 1;
  if (remaining > 0) index.set(key, remaining);
  else index.delete(key);
}

function addToSetIndex(index, key, connection) {
  if (!key) return;
  const bucket = index.get(key) || new Set();
  bucket.add(connection);
  index.set(key, bucket);
}

function removeFromSetIndex(index, key, connection) {
  if (!key) return;
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(connection);
  if (bucket.size === 0) index.delete(key);
}

function closeResponse(response) {
  try {
    if (typeof response?.destroy === "function") response.destroy();
    else response?.end?.();
  } catch {
    // The socket is already unavailable.
  }
}

function removeConnection(connection, { close = false } = {}) {
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

function cohortKey(connection, pending = connection?.pendingConvergence) {
  if (!connection?.grantIdDigest || !connection?.proxySessionId || !pending) return "";
  return createHash("sha256")
    .update(connection.grantIdDigest)
    .update(":")
    .update(connection.proxySessionId)
    .update(":")
    .update(String(pending.sourceRevision))
    .digest("base64url");
}

function proxySessionKey(grantIdDigest, proxySessionId) {
  if (!grantIdDigest || !proxySessionId) return "";
  return createHash("sha256").update(grantIdDigest).update(":").update(proxySessionId).digest("base64url");
}

function fenceProxySession(connection, pending = connection?.pendingConvergence) {
  const key = proxySessionKey(connection?.grantIdDigest, connection?.proxySessionId);
  if (!key || !pending) return;
  if (!fencedProxySessions.has(key) && fencedProxySessions.size >= MCP_SSE_CONNECTION_LIMITS.maxCohortRecords) {
    fencedProxySessions.delete(fencedProxySessions.keys().next().value);
  }
  fencedProxySessions.set(key, Object.freeze({ sourceRevision: pending.sourceRevision }));
}

function recordConvergenceOutcome(connection, outcome, pending = connection?.pendingConvergence) {
  const key = cohortKey(connection, pending);
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

function scheduleConvergenceAcknowledgement(connection, payload) {
  const change = payload?.params?.change;
  const partitionKeys = normalizePartitionKeys(change?.affectedPartitions || [])
    .filter((key) => connection.partitionKeys.includes(key));
  if (partitionKeys.length === 0 || !Number.isSafeInteger(change?.sourceRevision) ||
      !Number.isSafeInteger(change?.audienceRevision) || !boundedIdentity(change?.catalogRevision, 256)) return;
  if (connection.acknowledgementTimer) clearTimeout(connection.acknowledgementTimer);
  connection.pendingConvergence = Object.freeze({
    sourceRevision: change.sourceRevision,
    audienceRevision: change.audienceRevision,
    catalogRevision: boundedIdentity(change.catalogRevision, 256),
    partitionKeys: Object.freeze(partitionKeys)
  });
  const history = connection.pendingConvergenceHistory;
  const priorIndex = history.findIndex((entry) =>
    entry.sourceRevision === connection.pendingConvergence.sourceRevision &&
    entry.audienceRevision === connection.pendingConvergence.audienceRevision);
  if (priorIndex >= 0) history[priorIndex] = connection.pendingConvergence;
  else history.push(connection.pendingConvergence);
  while (history.length > MCP_SSE_CONNECTION_LIMITS.maxPendingNotifications) {
    recordConvergenceOutcome(connection, "fenced", history.shift());
  }
  recordConvergenceOutcome(connection, "pending", connection.pendingConvergence);
  connection.acknowledgementTimer = setTimeout(() => {
    connection.acknowledgementTimer = null;
    if (activeSseConnections.has(connection) && connection.pendingConvergence) {
      connection.fenced = true;
      fenceProxySession(connection);
      removeConnection(connection, { close: true });
    }
  }, MCP_SSE_CONNECTION_LIMITS.acknowledgementTimeoutMs);
  connection.acknowledgementTimer.unref?.();
}

function writeConnection(connection, chunk) {
  const response = connection?.response;
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
    const accepted = response.write(String(chunk));
    const bufferedBytes = Number(response.writableLength || 0);
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

function ensureHeartbeatScheduler() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const connection of [...activeSseConnections]) {
      writeConnection(connection, ":\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function capacityFailure(code) {
  return {
    ok: false,
    status: 429,
    code
  };
}

function normalizePartitionKeys(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => boundedIdentity(value, 256))
      .filter(Boolean)
  )].sort();
}

function normalizeCapabilities(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => boundedIdentity(value, 128))
      .filter(Boolean)
  )].sort();
}

/**
 * Bind opaque audience partition keys onto an active SSE connection.
 * Keys never embed raw subjects or tags.
 */
export function bindMcpSseConnectionPartitions(connection, partitionKeys = []) {
  if (!connection || !activeSseConnections.has(connection)) return false;
  const nextKeys = normalizePartitionKeys(partitionKeys);
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
} = {}) {
  const normalizedGrantId = boundedIdentity(grantId);
  const remoteAddress = boundedIdentity(request?.socket?.remoteAddress);
  const normalizedProxySessionId = normalizeMcpProxySessionId(proxySessionId);
  const normalizedCapabilities = normalizeCapabilities(negotiatedCapabilities);
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
  if (normalizedCapabilities.includes("upstream.catalog.list_changed") &&
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
  const normalizedPartitionKeys = normalizePartitionKeys(partitionKeys);
  if (normalizedPartitionKeys.some((key) =>
    (connectionsByPartition.get(key)?.size || 0) >= MCP_SSE_CONNECTION_LIMITS.perPartition)) {
    return capacityFailure("mcp_sse_partition_capacity_exceeded");
  }

  const grantIdDigest = digestIdentity(normalizedGrantId);
  if (normalizedCapabilities.includes("upstream.catalog.list_changed") &&
      fencedProxySessions.has(proxySessionKey(grantIdDigest, normalizedProxySessionId))) {
    return {
      ok: false,
      status: 409,
      code: "mcp_sse_convergence_session_fenced"
    };
  }
  const connection = {
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

  const onClose = () => removeConnection(connection);
  if (typeof request.once === "function") request.once("close", onClose);
  else request.on("close", onClose);

  return {
    ok: true,
    status: 200,
    connection,
    write: (chunk) => writeConnection(connection, chunk),
    close: () => removeConnection(connection, { close: true })
  };
}

function enqueueOrWrite(connection, message, { coalesceKey = "" } = {}) {
  if (coalesceKey && Array.isArray(connection.pendingNotifications)) {
    const pending = connection.pendingNotifications;
    const existingIndex = pending.findIndex((item) => item.coalesceKey === coalesceKey);
    if (existingIndex >= 0) {
      pending[existingIndex] = { coalesceKey, message };
    } else if (pending.length >= MCP_SSE_CONNECTION_LIMITS.maxPendingNotifications) {
      // Coalesce to newest: drop oldest, keep the new revision.
      pending.shift();
      pending.push({ coalesceKey, message });
    } else {
      pending.push({ coalesceKey, message });
    }
    const next = pending.shift();
    return writeConnection(connection, next.message);
  }
  return writeConnection(connection, message);
}

export function broadcastMcpNotification(payload, {
  grantId = "",
  includePrivate = false,
  partitionKeys = null,
  grantIdDigests = null,
  coalesceKey = ""
} = {}) {
  let delivered = 0;
  let matched = 0;
  const scopedGrantId = boundedIdentity(grantId);
  const partitionKeySet = Array.isArray(partitionKeys)
    ? new Set(normalizePartitionKeys(partitionKeys))
    : null;
  const grantDigestSet = Array.isArray(grantIdDigests)
    ? new Set(grantIdDigests.map((value) => boundedIdentity(value, 256)).filter(Boolean))
    : null;
  const candidates = new Set();

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
    if (payload?.method === "notifications/tools/list_changed" &&
        !connection.negotiatedCapabilities.includes("upstream.catalog.list_changed")) {
      continue;
    }
    let deliveredPayload = payload;
    if (payload?.method === "notifications/tools/list_changed") {
      const affected = normalizePartitionKeys(payload?.params?.change?.affectedPartitions || []);
      const scopedAffected = affected.filter((key) => connection.partitionKeys.includes(key));
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
    const message = `event: message\ndata: ${JSON.stringify(deliveredPayload)}\n\n`;
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

export function markMcpSseConnectionApplied(connection, audienceRevision = 0) {
  if (!connection || !activeSseConnections.has(connection)) return false;
  const revision = Number(audienceRevision) || 0;
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
} = {}) {
  const sessionId = normalizeMcpProxySessionId(proxySessionId);
  const normalizedGrantId = boundedIdentity(grantId);
  const keys = normalizePartitionKeys(partitionKeys);
  let applied = 0;
  for (const connection of connectionsByProxySession.get(sessionId) || []) {
    const pending = connection.pendingConvergence;
    if (!pending || connection.grantId !== normalizedGrantId) continue;
    const normalizedCatalogRevision = boundedIdentity(catalogRevision, 256);
    const acknowledged = connection.pendingConvergenceHistory.find((entry) =>
      entry.sourceRevision === sourceRevision &&
      entry.audienceRevision === audienceRevision &&
      entry.catalogRevision === normalizedCatalogRevision &&
      entry.partitionKeys.length === keys.length &&
      entry.partitionKeys.every((key, index) => key === keys[index]));
    if (!acknowledged) continue;
    if (connection.acknowledgementTimer) clearTimeout(connection.acknowledgementTimer);
    connection.acknowledgementTimer = null;
    const remaining = [];
    for (const cohortEntry of connection.pendingConvergenceHistory) {
      if (cohortEntry.sourceRevision <= sourceRevision &&
          cohortEntry.audienceRevision <= audienceRevision &&
          cohortEntry.partitionKeys.length === keys.length &&
          cohortEntry.partitionKeys.every((key, index) => key === keys[index])) {
        recordConvergenceOutcome(connection, "applied", cohortEntry);
      } else {
        remaining.push(cohortEntry);
      }
    }
    connection.pendingConvergenceHistory = remaining;
    connection.pendingConvergence = remaining.at(-1) || null;
    if (connection.pendingConvergence) {
      const latest = connection.pendingConvergence;
      connection.acknowledgementTimer = setTimeout(() => {
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

export function getMcpCatalogConvergenceCohort() {
  return Object.freeze([...convergenceCohort.values()]);
}

export function fenceMcpSseConnection(connection, { close = true } = {}) {
  if (!connection || !activeSseConnections.has(connection)) return false;
  connection.fenced = true;
  if (close) removeConnection(connection, { close: true });
  return true;
}

export function disconnectMcpSseConnectionsByGrant(grantId = "") {
  const normalizedGrantId = boundedIdentity(grantId);
  if (!normalizedGrantId) return Object.freeze({ disconnectedConnectionCount: 0 });
  let disconnected = 0;
  for (const connection of [...activeSseConnections]) {
    if (connection.grantId !== normalizedGrantId) continue;
    if (removeConnection(connection, { close: true })) disconnected += 1;
  }
  return Object.freeze({ disconnectedConnectionCount: disconnected });
}

export function getMcpSseConnectionState() {
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
export function resetMcpSseConnectionStateForTests() {
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
