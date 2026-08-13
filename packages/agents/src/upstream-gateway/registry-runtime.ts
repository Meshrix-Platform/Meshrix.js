import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteFile,
  queueStateMutation,
  stateFileKey
} from "@meshrix/foundation/storage/state-coordinator";
import { appendBoundedJsonLine } from "@meshrix/foundation/storage/bounded-jsonl";
import {
  UPSTREAM_GATEWAY_PROTOCOL_VERSION,
  asArray,
  clone,
  nowIso,
  object,
  stableId,
  text
} from "./support.ts";

const RUNTIME_WAL_SCHEMA_VERSION: any = "v0.0.1:upstream-gateway:runtime-wal-1";
const LEGACY_RUNTIME_SCHEMA_VERSION: any = "v0.0.1:schema:definition-1";
const DEFAULT_FLUSH_BATCH_SIZE: any = 256;
const DEFAULT_WAL_MAX_BYTES: any = 8 * 1024 * 1024;
const DEFAULT_AUDIT_RING_LIMIT: any = 1000;
const DEFAULT_METRIC_DIMENSION_LIMIT: any = 4096;
const METRIC_BUCKET_KEYS: any = ["byService", "byStatus"];

function emptyMetrics() : any {
  return {
    totalForwardCount: 0,
    totalFailureCount: 0,
    byService: {},
    byStatus: {}
  };
}

function boundedBucketInsert(bucket: Record<string, any>, key: any, amount: any, dimensionLimit: any, shed: any) : any {
  const normalizedKey: any = text(key || "unknown");
  const current: any = Number(bucket[normalizedKey] || 0);
  if (current === 0 && Object.keys(bucket).length >= dimensionLimit) {
    shed.shedMetricDimensions += 1;
    return;
  }
  bucket[normalizedKey] = current + Number(amount || 0);
}

function shedCounter() : any {
  return { shedMetricDimensions: 0 };
}

function applyMetricDeltas(target: Record<string, any>, deltas: Record<string, any>) : any {
  target.totalForwardCount = Number(target.totalForwardCount || 0) + Number(deltas.totalForwardCount || 0);
  target.totalFailureCount = Number(target.totalFailureCount || 0) + Number(deltas.totalFailureCount || 0);
  for (const key of METRIC_BUCKET_KEYS) {
    for (const [bucketKey, count] of (Object.entries(object(deltas[key])) as [string, any][])) {
      const normalizedKey: any = text(bucketKey || "unknown");
      target[key][normalizedKey] = Number(target[key][normalizedKey] || 0) + Number(count || 0);
    }
  }
}

function metricDeltasToDurable(deltas: Record<string, any>) : any {
  return {
    totalForwardCount: Number(deltas.totalForwardCount || 0),
    totalFailureCount: Number(deltas.totalFailureCount || 0),
    byService: { ...object(deltas.byService) },
    byStatus: { ...object(deltas.byStatus) }
  };
}

function auditIdentity(event: Record<string, any> = {}) : any {
  return text(event?.auditId || "");
}

function emptyWalDelta(sequence: any) : any {
  return {
    schemaVersion: RUNTIME_WAL_SCHEMA_VERSION,
    sequence: Number(sequence || 0),
    kind: "delta",
    auditEvents: [],
    metrics: emptyMetrics(),
    createdAt: nowIso()
  };
}

function walPathFor(filePath: any) : any {
  const raw: any = text(filePath);
  if (!raw) return "";
  return `${raw}.wal.jsonl`;
}

function parseWalLine(raw: any) : any {
  if (!raw) return null;
  try {
    const parsed: any = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (text(parsed.schemaVersion) !== RUNTIME_WAL_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createGatewayRuntime({
  persistenceEnabled = false,
  filePath = "",
  securityAlertStore = null,
  flushBatchSize = DEFAULT_FLUSH_BATCH_SIZE,
  walMaxBytes = DEFAULT_WAL_MAX_BYTES,
  auditRingLimit = DEFAULT_AUDIT_RING_LIMIT,
  metricDimensionLimit = DEFAULT_METRIC_DIMENSION_LIMIT
}: Record<string, any> = {}) : any {
  const enabled: any = persistenceEnabled === true && Boolean(walPathFor(filePath));
  const walPath: any = enabled ? walPathFor(filePath) : "";
  const auditEvents: any[] = [];
  const metrics: any = emptyMetrics();
  let metricDeltas: any = emptyMetrics();
  let pendingAuditEvents: any[] = [];
  let shedMetricDimensions: any = 0;
  let flushedBatchCount: any = 0;
  let compactionCount: any = 0;
  let recoveryReads: any = 0;
  let migrationReads: any = 0;
  let migrationWrites: any = 0;
  let requestPathFullStateReads: any = 0;
  let requestPathFullStateRewrites: any = 0;
  let flushFailureCount: any = 0;
  let shedAuditEvents: any = 0;
  let sequence: any = 0;
  let closed: any = false;
  let flushOwner: Promise<any> | null = null;
  let auditRingLimitResolved: any = Math.max(1, Math.min(Number(auditRingLimit || DEFAULT_AUDIT_RING_LIMIT), 100_000));
  let flushBatchSizeResolved: any = Math.max(1, Math.min(Number(flushBatchSize || DEFAULT_FLUSH_BATCH_SIZE), 10_000));
  let metricDimensionLimitResolved: any = Math.max(1, Math.min(Number(metricDimensionLimit || DEFAULT_METRIC_DIMENSION_LIMIT), 100_000));
  const walMaxBytesResolved: any = Math.max(64 * 1024, Math.min(Number(walMaxBytes || DEFAULT_WAL_MAX_BYTES), 1024 * 1024 * 1024));
  function pushAuditEvent(event: Record<string, any>) : any {
    auditEvents.push(event);
    if (auditEvents.length > auditRingLimitResolved) {
      const shedCount: any = auditEvents.length - auditRingLimitResolved;
      const shedIds: any = new Set<any>(
        auditEvents.slice(0, shedCount).map((item?: any) : any => auditIdentity(item))
      );
      auditEvents.splice(0, shedCount);
      pendingAuditEvents = pendingAuditEvents.filter(
        (item?: any) : any => !shedIds.has(auditIdentity(item))
      );
      shedAuditEvents += shedCount;
    }
  }

  function applyRecoveredAuditEvents(events: any) : any {
    const byId: any = new Map<any, any>();
    for (const event of auditEvents) byId.set(auditIdentity(event), event);
    for (const event of asArray(events)) {
      const auditId: any = auditIdentity(event);
      if (auditId) byId.set(auditId, event);
    }
    auditEvents.splice(0, auditEvents.length, ...byId.values());
    if (auditEvents.length > auditRingLimitResolved) {
      auditEvents.splice(0, auditEvents.length - auditRingLimitResolved);
    }
  }

  function applyRecoveredMetrics(recovered: Record<string, any> = {}) : any {
    metrics.totalForwardCount = Number(metrics.totalForwardCount || 0) + Number(recovered.totalForwardCount || 0);
    metrics.totalFailureCount = Number(metrics.totalFailureCount || 0) + Number(recovered.totalFailureCount || 0);
    const shed: any = shedCounter();
    for (const key of METRIC_BUCKET_KEYS) {
      for (const [bucketKey, count] of (Object.entries(object(recovered[key])) as [string, any][])) {
        boundedBucketInsert(
          metrics[key],
          bucketKey,
          Number(count || 0),
          metricDimensionLimitResolved,
          shed
        );
      }
    }
    shedMetricDimensions += shed.shedMetricDimensions;
  }

  function replayWal() : any {
    if (!enabled) return 0;
    let raw: any = "";
    try {
      raw = fs.readFileSync(walPath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    recoveryReads += 1;
    let applied: any = 0;
    const lines: any = raw.split("\n").filter((line?: any) : any => line.trim());
    for (let index: any = 0; index < lines.length; index += 1) {
      const line: any = lines[index];
      const entry: any = parseWalLine(line);
      if (!entry) {
        if (index === lines.length - 1) continue;
        throw new Error("Upstream gateway runtime WAL contains an invalid durable record.");
      }
      sequence = Math.max(sequence, Number(entry.sequence || 0));
      if (entry.kind === "seed") {
        auditEvents.splice(
          0,
          auditEvents.length,
          ...asArray(entry.auditEvents).slice(-auditRingLimitResolved)
        );
        metrics.totalForwardCount = 0;
        metrics.totalFailureCount = 0;
        metrics.byService = {};
        metrics.byStatus = {};
        applyRecoveredMetrics(entry.metrics);
        applied += 1;
        continue;
      }
      if (entry.kind === "delta") {
        applyRecoveredAuditEvents(entry.auditEvents);
        applyRecoveredMetrics(entry.metrics);
        applied += 1;
      }
    }
    return applied;
  }

  function normalizeLegacyRuntime(legacy: any) : any {
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      throw new Error("Upstream gateway legacy runtime state is malformed.");
    }
    if (
      legacy.schemaVersion &&
      text(legacy.schemaVersion) !== LEGACY_RUNTIME_SCHEMA_VERSION
    ) {
      throw new Error("Upstream gateway legacy runtime schema is unsupported.");
    }
    const byId: any = new Map<any, any>();
    for (const event of asArray(legacy.auditEvents)) {
      const auditId: any = auditIdentity(event);
      if (auditId) byId.set(auditId, event);
    }
    return {
      auditEvents: [...byId.values()]
        .sort((left?: any, right?: any) : any => text(left?.createdAt).localeCompare(text(right?.createdAt)))
        .slice(-auditRingLimitResolved),
      metrics: {
        totalForwardCount: Number(legacy.metrics?.totalForwardCount || 0),
        totalFailureCount: Number(legacy.metrics?.totalFailureCount || 0),
        byService: { ...object(legacy.metrics?.byService) },
        byStatus: { ...object(legacy.metrics?.byStatus) }
      }
    };
  }

  function seedMatchesLegacy(seed: any, legacyState: any) : any {
    return seed?.kind === "seed" &&
      JSON.stringify(asArray(seed.auditEvents)) === JSON.stringify(legacyState.auditEvents) &&
      JSON.stringify(object(seed.metrics)) === JSON.stringify(legacyState.metrics);
  }

  function verifiedSeedFromDisk(expectedSequence: any) : any {
    const entries: any = fs.readFileSync(walPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line?: any) : any => parseWalLine(line))
      .filter(Boolean);
    return entries.findLast((entry?: any) : any =>
      entry.kind === "seed" && Number(entry.sequence) === Number(expectedSequence)
    ) || null;
  }

  async function removeVerifiedLegacyRuntimeJson() : Promise<any> {
    if (!fs.existsSync(filePath)) return false;
    const legacyState: any = normalizeLegacyRuntime(
      JSON.parse(fs.readFileSync(filePath, "utf8"))
    );
    migrationReads += 1;
    const seed: any = fs.readFileSync(walPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line?: any) : any => parseWalLine(line))
      .filter(Boolean)
      .find((entry?: any) : any => seedMatchesLegacy(entry, legacyState));
    if (!seed) {
      throw new Error("Upstream gateway legacy runtime state has no verified WAL authority.");
    }
    fs.unlinkSync(filePath);
    return true;
  }

  async function migrateLegacyRuntimeJson() : Promise<any> {
    if (!enabled) return false;
    let legacy: any = null;
    try {
      legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    migrationReads += 1;
    const legacyState: any = normalizeLegacyRuntime(legacy);
    const nextSequence: any = sequence + 1;
    const seed: Record<string, any> = {
      schemaVersion: RUNTIME_WAL_SCHEMA_VERSION,
      protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
      sequence: nextSequence,
      kind: "seed",
      auditEvents: legacyState.auditEvents,
      metrics: legacyState.metrics,
      createdAt: nowIso()
    };
    const serialized: any = `${JSON.stringify(seed)}\n`;
    if (Buffer.byteLength(serialized) > walMaxBytesResolved) {
      throw new Error("Upstream gateway legacy runtime state exceeds the bounded WAL capacity.");
    }
    await queueStateMutation(stateFileKey(walPath), async () : Promise<any> => {
      await atomicWriteFile(walPath, serialized, "utf8");
      const verified: any = verifiedSeedFromDisk(nextSequence);
      if (!verified || !seedMatchesLegacy(verified, legacyState)) {
        throw new Error("Upstream gateway runtime migration verification failed.");
      }
      fs.unlinkSync(filePath);
    });
    migrationWrites += 1;
    sequence = nextSequence;
    applyRecoveredAuditEvents(legacyState.auditEvents);
    metrics.totalForwardCount = legacyState.metrics.totalForwardCount;
    metrics.totalFailureCount = legacyState.metrics.totalFailureCount;
    metrics.byService = {};
    metrics.byStatus = {};
    const legacyTotals: any = {
      ...legacyState.metrics,
      totalForwardCount: 0,
      totalFailureCount: 0
    };
    applyRecoveredMetrics(legacyTotals);
    return true;
  }

  function hasMetricDeltas() : any {
    return Number(metricDeltas.totalForwardCount || 0) !== 0 ||
      Number(metricDeltas.totalFailureCount || 0) !== 0 ||
      Object.keys(metricDeltas.byService).length > 0 ||
      Object.keys(metricDeltas.byStatus).length > 0;
  }

  function subtractMetricDeltas(durable: Record<string, any>) : any {
    metricDeltas.totalForwardCount = Math.max(
      0,
      Number(metricDeltas.totalForwardCount || 0) - Number(durable.totalForwardCount || 0)
    );
    metricDeltas.totalFailureCount = Math.max(
      0,
      Number(metricDeltas.totalFailureCount || 0) - Number(durable.totalFailureCount || 0)
    );
    for (const key of METRIC_BUCKET_KEYS) {
      for (const [bucketKey, count] of (Object.entries(object(durable[key])) as [string, any][])) {
        const remaining: any = Math.max(
          0,
          Number(metricDeltas[key][bucketKey] || 0) - Number(count || 0)
        );
        if (remaining === 0) delete metricDeltas[key][bucketKey];
        else metricDeltas[key][bucketKey] = remaining;
      }
    }
  }

  function currentSeed(nextSequence: any) : any {
    return {
      schemaVersion: RUNTIME_WAL_SCHEMA_VERSION,
      protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
      sequence: nextSequence,
      kind: "seed",
      auditEvents: auditEvents.map((event?: any) : any => clone(event)),
      metrics: {
        totalForwardCount: Number(metrics.totalForwardCount || 0),
        totalFailureCount: Number(metrics.totalFailureCount || 0),
        byService: { ...metrics.byService },
        byStatus: { ...metrics.byStatus }
      },
      createdAt: nowIso()
    };
  }

  async function flushDirtyBatch() : Promise<any> {
    if (!enabled) return { flushed: 0, shedMetricDimensions: 0 };
    if (closed) return { flushed: 0, shedMetricDimensions: 0 };
    const batchAuditEvents: any = pendingAuditEvents.slice(0, flushBatchSizeResolved);
    const batchMetrics: any = metricDeltasToDurable(metricDeltas);
    if (batchAuditEvents.length === 0 && !hasMetricDeltas()) {
      return { flushed: 0, shedMetricDimensions };
    }
    const nextSequence: any = sequence + 1;
    const delta: any = emptyWalDelta(nextSequence);
    delta.auditEvents = batchAuditEvents;
    delta.metrics = batchMetrics;
    const allPendingAuditCount: any = pendingAuditEvents.length;
    const allPendingMetrics: any = metricDeltasToDurable(metricDeltas);
    const seed: any = currentSeed(nextSequence);
    const { replaced: compacted }: any = await appendBoundedJsonLine(
      walPath,
      delta,
      {
        maxBytes: walMaxBytesResolved,
        maxRecordBytes: walMaxBytesResolved,
        overflowReplacement: seed
      }
    );
    sequence = nextSequence;
    flushedBatchCount += 1;
    if (compacted) {
      compactionCount += 1;
      pendingAuditEvents.splice(0, allPendingAuditCount);
      subtractMetricDeltas(allPendingMetrics);
    } else {
      pendingAuditEvents.splice(0, batchAuditEvents.length);
      subtractMetricDeltas(batchMetrics);
    }
    return { flushed: batchAuditEvents.length, shedMetricDimensions: shedMetricDimensions };
  }

  async function persist() : Promise<any> {
    if (!enabled || closed) return { flushed: 0, shedMetricDimensions };
    if (flushOwner) return flushOwner;
    const run: Promise<any> = (async () : Promise<any> => {
      try {
        await initPromise;
        let flushed: any = 0;
        while (pendingAuditEvents.length > 0 || hasMetricDeltas()) {
          const result: any = await flushDirtyBatch();
          flushed += Number(result.flushed || 0);
        }
        return { flushed, shedMetricDimensions };
      } catch {
        flushFailureCount += 1;
        return { flushed: 0, shedMetricDimensions };
      }
    })();
    flushOwner = run.finally(() : any => {
      flushOwner = null;
    });
    return flushOwner;
  }

  async function close() : Promise<any> {
    if (closed) return { ok: true };
    await initPromise;
    if (flushOwner) await flushOwner;
    if (enabled && (pendingAuditEvents.length > 0 || hasMetricDeltas())) {
      const result: any = await persist();
      if (pendingAuditEvents.length > 0 || hasMetricDeltas()) {
        throw new Error(`Upstream gateway runtime did not flush ${Number(result.flushed || 0)} pending records.`);
      }
    }
    closed = true;
    return { ok: true };
  }

  function recordMetric({ serviceId, statusCode = 0, failed = false }: Record<string, any> = {}) : any {
    const bucketKey: any = String(statusCode || (failed ? "failed" : "unknown"));
    const shed: any = shedCounter();
    metrics.totalForwardCount += 1;
    metricDeltas.totalForwardCount += 1;
    if (failed) {
      metrics.totalFailureCount += 1;
      metricDeltas.totalFailureCount += 1;
    }
    boundedBucketInsert(metrics.byService, serviceId, 1, metricDimensionLimitResolved, shed);
    boundedBucketInsert(metricDeltas.byService, serviceId, 1, metricDimensionLimitResolved, shedCounter());
    boundedBucketInsert(metrics.byStatus, bucketKey, 1, metricDimensionLimitResolved, shed);
    boundedBucketInsert(metricDeltas.byStatus, bucketKey, 1, metricDimensionLimitResolved, shedCounter());
    shedMetricDimensions += shed.shedMetricDimensions;
    return { serviceId, statusCode: Number(statusCode || 0), failed: failed === true };
  }

  function appendAudit(eventType?: any, payload: Record<string, any> = {}) : any {
    const audit: Record<string, any> = {
      auditId: stableId("upstream_gateway_audit", { eventType, payload, nonce: randomUUID() }),
      eventType,
      serviceId: text(payload.serviceId || ""),
      operationKey: text(payload.operationKey || ""),
      payload,
      createdAt: nowIso()
    };
    pushAuditEvent(audit);
    pendingAuditEvents.push(audit);
    if (pendingAuditEvents.length > flushBatchSizeResolved * 4) {
      void persist();
    }
    return audit;
  }

  function appendSecurityAlert({
    reasonCode = "upstream_gateway_security_event",
    severity = "high",
    title = "Upstream gateway security event",
    serviceId = "",
    operationKey = "",
    evidence = {}
  }: Record<string, any> = {}) : any {
    try {
      securityAlertStore?.appendAlert({
        source: "upstream-gateway",
        category: "upstream-gateway",
        severity,
        reasonCode,
        title,
        subjectRef: serviceId ? `upstream-service:${serviceId}` : "",
        resourceRef: operationKey ? `operation:${operationKey}` : "",
        details: evidence
      });
    } catch {
      // Alert persistence must not mask the primary security denial.
    }
    return null;
  }

  function getRefactorInstrumentation() : any {
    return {
      schemaVersion: "v0.0.1:upstream-gateway:runtime-refactor-instrumentation-1",
      requestPathFullStateReads,
      requestPathFullStateRewrites,
      flushedBatchCount,
      shedMetricDimensions,
      shedAuditEvents,
      flushFailureCount,
      compactionCount,
      recoveryReads,
      migrationReads,
      migrationWrites,
      walBytes: enabled ? fs.existsSync(walPath) ? fs.statSync(walPath).size : 0 : 0,
      auditRingLimit: auditRingLimitResolved,
      flushBatchSize: flushBatchSizeResolved,
      metricDimensionLimit: metricDimensionLimitResolved,
      closed
    };
  }

  const initPromise: any = (async () : Promise<any> => {
    if (!enabled) return;
    fs.mkdirSync(path.dirname(walPath), { recursive: true });
    if (fs.existsSync(walPath)) {
      const applied: any = replayWal();
      if (fs.statSync(walPath).size > 0 && applied === 0) {
        throw new Error("Upstream gateway runtime WAL contains no recoverable authority.");
      }
      await removeVerifiedLegacyRuntimeJson();
    } else if (fs.existsSync(filePath)) {
      await migrateLegacyRuntimeJson();
    }
  })();

  return {
    auditEvents,
    metrics,
    appendAudit,
    appendSecurityAlert,
    recordMetric,
    persist,
    close,
    getRefactorInstrumentation
  };
}
