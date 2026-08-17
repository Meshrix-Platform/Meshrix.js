import { createHash } from "node:crypto";
import { normalizeMcpProxySessionId } from "#meshrix/contracts/mcp-catalog-delivery";

interface SseLimits {
  total: number;
  perRemoteAddress: number;
  perGrant: number;
  perPartition: number;
  maxBufferedBytes: number;
  maxPendingNotifications: number;
  maxCohortRecords: number;
  acknowledgementTimeoutMs: number;
}
interface SseResponse {
  destroyed?: boolean;
  writableEnded?: boolean;
  writableLength?: number;
  write(chunk: string): boolean;
  destroy?(): void;
  end?(): void;
}
interface SseRequest {
  socket?: { remoteAddress?: string };
  once?(event: string, listener: () => void): void;
  on?(event: string, listener: () => void): void;
}
interface PendingConvergence {
  sourceRevision: number;
  audienceRevision: number;
  catalogRevision: string;
  partitionKeys: readonly string[];
}
interface PendingNotification {
  coalesceKey: string;
  message: string;
}
interface SseConnection {
  response: SseResponse;
  remoteAddress: string;
  grantId: string;
  grantIdDigest: string;
  proxySessionId: string;
  grant: unknown;
  privateOnly: boolean;
  negotiatedCapabilities: readonly string[];
  partitionKeys: readonly string[];
  pendingNotifications: PendingNotification[];
  pendingConvergenceHistory: PendingConvergence[];
  pendingConvergence?: PendingConvergence | null;
  acknowledgementTimer?: NodeJS.Timeout | null;
  appliedAudienceRevision: number;
  fenced: boolean;
}
type ConnectionIndex = Map<string, Set<SseConnection>>;
type JsonRecord = Record<string, unknown>;
type ConvergenceOutcome = "pending" | "applied" | "disconnected" | "fenced";
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export const MCP_SSE_CONNECTION_LIMITS: Readonly<SseLimits> = Object.freeze({
  total: 256,
  perRemoteAddress: 32,
  perGrant: 16,
  perPartition: 16,
  maxBufferedBytes: 64 * 1024,
  maxPendingNotifications: 8,
  maxCohortRecords: 512,
  acknowledgementTimeoutMs: 10_000,
});

const HEARTBEAT_INTERVAL_MS = 15_000;
const activeSseConnections = new Set<SseConnection>();
const connectionsByRemoteAddress = new Map<string, number>();
const connectionsByGrant = new Map<string, number>();
const connectionsByGrantDigest: ConnectionIndex = new Map();
const connectionsByPartition: ConnectionIndex = new Map();
const connectionsByProxySession: ConnectionIndex = new Map();
const convergenceCohort = new Map<string, Readonly<JsonRecord>>();
const fencedProxySessions = new Map<
  string,
  Readonly<{ sourceRevision: number }>
>();
let heartbeatTimer: NodeJS.Timeout | null = null;

function boundedIdentity(value?: unknown, maxBytes = 1_024): string {
  const normalized = String(value || "").trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= maxBytes
    ? normalized
    : "";
}

function digestIdentity(value?: unknown): string {
  const normalized = boundedIdentity(value);
  return normalized
    ? createHash("sha256").update(normalized).digest("base64url")
    : "";
}

function countFor(index: Map<string, number>, key: string): number {
  return key ? Number(index.get(key) || 0) : 0;
}

function incrementCount(index: Map<string, number>, key: string): void {
  index.set(key, countFor(index, key) + 1);
}

function decrementCount(index: Map<string, number>, key: string): void {
  const remaining = countFor(index, key) - 1;
  if (remaining > 0) index.set(key, remaining);
  else index.delete(key);
}

function addToSetIndex(
  index: ConnectionIndex,
  key: string,
  connection: SseConnection,
): void {
  if (!key) return;
  const bucket = index.get(key) || new Set<SseConnection>();
  bucket.add(connection);
  index.set(key, bucket);
}

function removeFromSetIndex(
  index: ConnectionIndex,
  key: string,
  connection: SseConnection,
): void {
  if (!key) return;
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(connection);
  if (bucket.size === 0) index.delete(key);
}

function closeResponse(response?: SseResponse): void {
  try {
    if (typeof response?.destroy === "function") response.destroy();
    else response?.end?.();
  } catch {
    // The socket is already unavailable.
  }
}

function removeConnection(
  connection: SseConnection | null | undefined,
  { close = false }: { close?: boolean } = {},
): boolean {
  if (!connection || !activeSseConnections.delete(connection)) return false;
  decrementCount(connectionsByRemoteAddress, connection.remoteAddress);
  decrementCount(connectionsByGrant, connection.grantId);
  removeFromSetIndex(
    connectionsByGrantDigest,
    connection.grantIdDigest,
    connection,
  );
  removeFromSetIndex(
    connectionsByProxySession,
    connection.proxySessionId,
    connection,
  );
  for (const partitionKey of connection.partitionKeys || []) {
    removeFromSetIndex(connectionsByPartition, partitionKey, connection);
  }
  if (connection.acknowledgementTimer) {
    clearTimeout(connection.acknowledgementTimer);
    connection.acknowledgementTimer = null;
  }
  if (connection.pendingConvergenceHistory?.length > 0) {
    for (const pending of connection.pendingConvergenceHistory) {
      recordConvergenceOutcome(
        connection,
        close ? "fenced" : "disconnected",
        pending,
      );
    }
  }
  if (activeSseConnections.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (close) closeResponse(connection.response);
  return true;
}

function cohortKey(
  connection?: SseConnection,
  pending:
    PendingConvergence | null | undefined = connection?.pendingConvergence,
): string {
  if (!connection?.grantIdDigest || !connection?.proxySessionId || !pending)
    return "";
  return createHash("sha256")
    .update(connection.grantIdDigest)
    .update(":")
    .update(connection.proxySessionId)
    .update(":")
    .update(String(pending.sourceRevision))
    .digest("base64url");
}

function proxySessionKey(
  grantIdDigest?: string,
  proxySessionId?: string,
): string {
  if (!grantIdDigest || !proxySessionId) return "";
  return createHash("sha256")
    .update(grantIdDigest)
    .update(":")
    .update(proxySessionId)
    .digest("base64url");
}

function fenceProxySession(
  connection?: SseConnection,
  pending:
    PendingConvergence | null | undefined = connection?.pendingConvergence,
): void {
  const key = proxySessionKey(
    connection?.grantIdDigest,
    connection?.proxySessionId,
  );
  if (!key || !pending) return;
  if (
    !fencedProxySessions.has(key) &&
    fencedProxySessions.size >= MCP_SSE_CONNECTION_LIMITS.maxCohortRecords
  ) {
    const oldestKey = fencedProxySessions.keys().next().value;
    if (oldestKey) fencedProxySessions.delete(oldestKey);
  }
  fencedProxySessions.set(
    key,
    Object.freeze({ sourceRevision: pending.sourceRevision }),
  );
}

function recordConvergenceOutcome(
  connection: SseConnection | undefined,
  outcome: ConvergenceOutcome,
  pending:
    PendingConvergence | null | undefined = connection?.pendingConvergence,
): void {
  const key = cohortKey(connection, pending);
  if (
    !key ||
    !pending ||
    !["pending", "applied", "disconnected", "fenced"].includes(outcome)
  )
    return;
  if (
    !convergenceCohort.has(key) &&
    convergenceCohort.size >= MCP_SSE_CONNECTION_LIMITS.maxCohortRecords
  ) {
    const oldestKey = convergenceCohort.keys().next().value;
    if (oldestKey) convergenceCohort.delete(oldestKey);
  }
  convergenceCohort.set(
    key,
    Object.freeze({
      outcome,
      sourceRevision: pending.sourceRevision,
      audienceRevision: pending.audienceRevision,
      catalogRevision: pending.catalogRevision,
      partitionCount: pending.partitionKeys.length,
    }),
  );
}

function scheduleConvergenceAcknowledgement(
  connection: SseConnection,
  payload: unknown,
): void {
  const params = record(record(payload)?.params);
  const change = record(params?.change);
  const partitionKeys = normalizePartitionKeys(
    change?.affectedPartitions || [],
  ).filter((key) => connection.partitionKeys.includes(key));
  if (
    partitionKeys.length === 0 ||
    !Number.isSafeInteger(change?.sourceRevision) ||
    !Number.isSafeInteger(change?.audienceRevision) ||
    !boundedIdentity(change?.catalogRevision, 256)
  )
    return;
  if (connection.acknowledgementTimer)
    clearTimeout(connection.acknowledgementTimer);
  const pending: PendingConvergence = Object.freeze({
    sourceRevision: Number(change?.sourceRevision),
    audienceRevision: Number(change?.audienceRevision),
    catalogRevision: boundedIdentity(change?.catalogRevision, 256),
    partitionKeys: Object.freeze(partitionKeys),
  });
  connection.pendingConvergence = pending;
  const history = connection.pendingConvergenceHistory;
  const priorIndex = history.findIndex(
    (entry) =>
      entry.sourceRevision === pending.sourceRevision &&
      entry.audienceRevision === pending.audienceRevision,
  );
  if (priorIndex >= 0) history[priorIndex] = pending;
  else history.push(pending);
  while (history.length > MCP_SSE_CONNECTION_LIMITS.maxPendingNotifications) {
    recordConvergenceOutcome(connection, "fenced", history.shift());
  }
  recordConvergenceOutcome(connection, "pending", pending);
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

function writeConnection(
  connection: SseConnection | null | undefined,
  chunk?: unknown,
): boolean {
  const response = connection?.response;
  if (
    !connection ||
    !response ||
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
    if (
      accepted === false ||
      bufferedBytes > MCP_SSE_CONNECTION_LIMITS.maxBufferedBytes
    ) {
      removeConnection(connection, { close: true });
      return false;
    }
    return true;
  } catch {
    removeConnection(connection, { close: true });
    return false;
  }
}

function ensureHeartbeatScheduler(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const connection of activeSseConnections) {
      writeConnection(connection, ":\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function capacityFailure(code: string) {
  return {
    ok: false,
    status: 429,
    code,
  };
}

function normalizePartitionKeys(values: unknown = []): string[] {
  return [
    ...new Set<string>(
      (Array.isArray(values) ? values : [values])
        .map((value) => boundedIdentity(value, 256))
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeCapabilities(values: unknown = []): string[] {
  return [
    ...new Set<string>(
      (Array.isArray(values) ? values : [values])
        .map((value) => boundedIdentity(value, 128))
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Bind opaque audience partition keys onto an active SSE connection.
 * Keys never embed raw subjects or tags.
 */
export function bindMcpSseConnectionPartitions(
  connection: SseConnection | null | undefined,
  partitionKeys: unknown = [],
): boolean {
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
  proxySessionId = "",
}: {
  request?: SseRequest;
  response?: SseResponse;
  grantId?: unknown;
  grant?: unknown;
  privateOnly?: boolean;
  partitionKeys?: unknown;
  negotiatedCapabilities?: unknown;
  proxySessionId?: unknown;
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
      code: "mcp_sse_registration_invalid",
    };
  }
  if (
    normalizedCapabilities.includes("notifications/tools/list_changed") &&
    !normalizedProxySessionId
  ) {
    return {
      ok: false,
      status: 400,
      code: "mcp_sse_convergence_session_required",
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
  if (
    countFor(connectionsByGrant, normalizedGrantId) >=
    MCP_SSE_CONNECTION_LIMITS.perGrant
  ) {
    return capacityFailure("mcp_sse_grant_capacity_exceeded");
  }
  const normalizedPartitionKeys = normalizePartitionKeys(partitionKeys);
  if (
    normalizedPartitionKeys.some(
      (key) =>
        (connectionsByPartition.get(key)?.size || 0) >=
        MCP_SSE_CONNECTION_LIMITS.perPartition,
    )
  ) {
    return capacityFailure("mcp_sse_partition_capacity_exceeded");
  }

  const grantIdDigest = digestIdentity(normalizedGrantId);
  if (
    normalizedCapabilities.includes("notifications/tools/list_changed") &&
    fencedProxySessions.has(
      proxySessionKey(grantIdDigest, normalizedProxySessionId),
    )
  ) {
    return {
      ok: false,
      status: 409,
      code: "mcp_sse_convergence_session_fenced",
    };
  }
  const connection: SseConnection = {
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
    fenced: false,
  };
  activeSseConnections.add(connection);
  incrementCount(connectionsByRemoteAddress, remoteAddress);
  incrementCount(connectionsByGrant, normalizedGrantId);
  addToSetIndex(connectionsByGrantDigest, grantIdDigest, connection);
  addToSetIndex(
    connectionsByProxySession,
    connection.proxySessionId,
    connection,
  );
  bindMcpSseConnectionPartitions(connection, normalizedPartitionKeys);
  ensureHeartbeatScheduler();

  const onClose = () => {
    removeConnection(connection);
  };
  if (typeof request.once === "function") request.once("close", onClose);
  else request.on!("close", onClose);

  return {
    ok: true,
    status: 200,
    connection,
    write: (chunk?: unknown) => writeConnection(connection, chunk),
    close: () => removeConnection(connection, { close: true }),
  };
}

function enqueueOrWrite(
  connection: SseConnection,
  message: string,
  { coalesceKey = "" }: { coalesceKey?: string } = {},
): boolean {
  if (coalesceKey && Array.isArray(connection.pendingNotifications)) {
    const pending = connection.pendingNotifications;
    const existingIndex = pending.findIndex(
      (item) => item.coalesceKey === coalesceKey,
    );
    if (existingIndex >= 0) {
      pending[existingIndex] = { coalesceKey, message };
    } else if (
      pending.length >= MCP_SSE_CONNECTION_LIMITS.maxPendingNotifications
    ) {
      // Coalesce to newest: drop oldest, keep the new revision.
      pending.shift();
      pending.push({ coalesceKey, message });
    } else {
      pending.push({ coalesceKey, message });
    }
    const next = pending.shift();
    return next ? writeConnection(connection, next.message) : false;
  }
  return writeConnection(connection, message);
}

export function broadcastMcpNotification(
  payload?: unknown,
  {
    grantId = "",
    includePrivate = false,
    partitionKeys = null,
    grantIdDigests = null,
    coalesceKey = "",
  }: {
    grantId?: unknown;
    includePrivate?: boolean;
    partitionKeys?: unknown;
    grantIdDigests?: unknown;
    coalesceKey?: string;
  } = {},
) {
  let delivered = 0;
  let matched = 0;
  const scopedGrantId = boundedIdentity(grantId);
  const partitionKeySet = Array.isArray(partitionKeys)
    ? new Set<string>(normalizePartitionKeys(partitionKeys))
    : null;
  const grantDigestSet = Array.isArray(grantIdDigests)
    ? new Set<string>(
        grantIdDigests
          .map((value) => boundedIdentity(value, 256))
          .filter(Boolean),
      )
    : null;
  const candidates = new Set<SseConnection>();

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
  if (
    (!partitionKeySet || partitionKeySet.size === 0) &&
    (!grantDigestSet || grantDigestSet.size === 0)
  ) {
    for (const connection of activeSseConnections) {
      candidates.add(connection);
    }
  }

  for (const connection of candidates) {
    if (scopedGrantId && connection.grantId !== scopedGrantId) continue;
    if (
      !scopedGrantId &&
      !includePrivate &&
      connection.privateOnly === true &&
      !((partitionKeySet?.size ?? 0) > 0 || (grantDigestSet?.size ?? 0) > 0)
    ) {
      continue;
    }
    const payloadRecord = record(payload);
    const method =
      typeof payloadRecord?.method === "string" ? payloadRecord.method : "";
    if (method && !connection.negotiatedCapabilities.includes(method)) {
      continue;
    }
    let deliveredPayload: unknown = payload;
    if (method === "notifications/tools/list_changed") {
      const params = record(payloadRecord?.params);
      const change = record(params?.change);
      const affected = normalizePartitionKeys(change?.affectedPartitions || []);
      const scopedAffected = affected.filter((key) =>
        connection.partitionKeys.includes(key),
      );
      if (affected.length > 0 && scopedAffected.length === 0) continue;
      deliveredPayload = {
        ...payloadRecord,
        params: {
          ...params,
          change: {
            ...change,
            affectedPartitions: scopedAffected,
          },
        },
      };
    }
    const message = `event: message\ndata: ${JSON.stringify(deliveredPayload)}\n\n`;
    matched += 1;
    if (enqueueOrWrite(connection, message, { coalesceKey })) {
      delivered += 1;
      if (
        record(deliveredPayload)?.method === "notifications/tools/list_changed"
      ) {
        scheduleConvergenceAcknowledgement(connection, deliveredPayload);
      }
    }
  }
  return {
    activeConnectionCount: activeSseConnections.size,
    matchedConnectionCount: matched,
    deliveredConnectionCount: delivered,
    partitionMatchCount: partitionKeySet?.size || 0,
    grantDigestMatchCount: grantDigestSet?.size || 0,
  };
}

export function markMcpSseConnectionApplied(
  connection: SseConnection | null | undefined,
  audienceRevision: unknown = 0,
): boolean {
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
  partitionKeys = [],
}: {
  grantId?: unknown;
  proxySessionId?: unknown;
  sourceRevision?: number;
  audienceRevision?: number;
  catalogRevision?: unknown;
  partitionKeys?: unknown;
} = {}) {
  const sessionId = normalizeMcpProxySessionId(proxySessionId);
  const normalizedGrantId = boundedIdentity(grantId);
  const keys = normalizePartitionKeys(partitionKeys);
  let applied = 0;
  for (const connection of connectionsByProxySession.get(sessionId) || []) {
    const pending = connection.pendingConvergence;
    if (!pending || connection.grantId !== normalizedGrantId) continue;
    const normalizedCatalogRevision = boundedIdentity(catalogRevision, 256);
    const acknowledged = connection.pendingConvergenceHistory.find(
      (entry) =>
        entry.sourceRevision === sourceRevision &&
        entry.audienceRevision === audienceRevision &&
        entry.catalogRevision === normalizedCatalogRevision &&
        entry.partitionKeys.length === keys.length &&
        entry.partitionKeys.every((key, index) => key === keys[index]),
    );
    if (!acknowledged) continue;
    if (connection.acknowledgementTimer)
      clearTimeout(connection.acknowledgementTimer);
    connection.acknowledgementTimer = null;
    const remaining: PendingConvergence[] = [];
    for (const cohortEntry of connection.pendingConvergenceHistory) {
      if (
        cohortEntry.sourceRevision <= sourceRevision &&
        cohortEntry.audienceRevision <= audienceRevision &&
        cohortEntry.partitionKeys.length === keys.length &&
        cohortEntry.partitionKeys.every((key, index) => key === keys[index])
      ) {
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
        if (
          activeSseConnections.has(connection) &&
          connection.pendingConvergence === latest
        ) {
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

export function getMcpCatalogConvergenceCohort(): readonly Readonly<JsonRecord>[] {
  return Object.freeze([...convergenceCohort.values()]);
}

export function fenceMcpSseConnection(
  connection: SseConnection | null | undefined,
  { close = true }: { close?: boolean } = {},
): boolean {
  if (!connection || !activeSseConnections.has(connection)) return false;
  connection.fenced = true;
  if (close) removeConnection(connection, { close: true });
  return true;
}

export function disconnectMcpSseConnectionsByGrant(grantId: unknown = "") {
  const normalizedGrantId = boundedIdentity(grantId);
  if (!normalizedGrantId)
    return Object.freeze({ disconnectedConnectionCount: 0 });
  let disconnected = 0;
  for (const connection of activeSseConnections) {
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
    cohortRecordCount: convergenceCohort.size,
  };
}

/** Test helper: reset in-memory SSE indexes. */
export function resetMcpSseConnectionStateForTests(): void {
  for (const connection of activeSseConnections) {
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
