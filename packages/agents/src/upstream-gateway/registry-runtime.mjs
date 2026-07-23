import { randomUUID } from "node:crypto";
import {
  UPSTREAM_GATEWAY_PROTOCOL_VERSION,
  asArray,
  clone,
  emptyState,
  normalizeState,
  nowIso,
  object,
  readJsonSync,
  stableId,
  text,
  writeJsonSyncAtomic
} from "./support.mjs";

function emptyMetricDeltas() {
  return {
    totalForwardCount: 0,
    totalFailureCount: 0,
    byService: {},
    byStatus: {}
  };
}

function mergeAuditEvents(...eventLists) {
  const byId = new Map();
  for (const event of eventLists.flatMap((items) => asArray(items))) {
    const auditId = text(event?.auditId || "");
    if (!auditId) continue;
    byId.set(auditId, clone(event));
  }
  return [...byId.values()]
    .sort((left, right) => text(left.createdAt).localeCompare(text(right.createdAt)))
    .slice(-1000);
}

function incrementMetricBucket(bucket = {}, key = "", amount = 1) {
  const normalizedKey = text(key || "unknown");
  bucket[normalizedKey] = Number(bucket[normalizedKey] || 0) + amount;
}

function mergeMetricState(base = {}, deltas = {}) {
  const merged = {
    totalForwardCount: Number(base.totalForwardCount || 0) + Number(deltas.totalForwardCount || 0),
    totalFailureCount: Number(base.totalFailureCount || 0) + Number(deltas.totalFailureCount || 0),
    byService: { ...object(base.byService) },
    byStatus: { ...object(base.byStatus) }
  };
  for (const [serviceId, count] of Object.entries(object(deltas.byService))) {
    incrementMetricBucket(merged.byService, serviceId, Number(count || 0));
  }
  for (const [statusKey, count] of Object.entries(object(deltas.byStatus))) {
    incrementMetricBucket(merged.byStatus, statusKey, Number(count || 0));
  }
  return merged;
}

export function createGatewayRuntime({
  persistenceEnabled = false,
  filePath = "",
  securityAlertStore = null
} = {}) {
  const state = normalizeState(
    persistenceEnabled ? readJsonSync(filePath, emptyState()) : emptyState()
  );
  const auditEvents = state.auditEvents;
  const metrics = state.metrics;
  let metricDeltas = emptyMetricDeltas();

  function replaceMetrics(nextMetrics = {}) {
    metrics.totalForwardCount = Number(nextMetrics.totalForwardCount || 0);
    metrics.totalFailureCount = Number(nextMetrics.totalFailureCount || 0);
    metrics.byService = { ...object(nextMetrics.byService) };
    metrics.byStatus = { ...object(nextMetrics.byStatus) };
  }

  function refreshRuntimeStateFromDisk() {
    if (!persistenceEnabled) return;
    const diskState = normalizeState(readJsonSync(filePath, emptyState()));
    const mergedAuditEvents = mergeAuditEvents(diskState.auditEvents, auditEvents);
    auditEvents.splice(0, auditEvents.length, ...mergedAuditEvents);
    replaceMetrics(mergeMetricState(diskState.metrics, metricDeltas));
  }

  function persist() {
    if (!persistenceEnabled) return;
    const diskState = normalizeState(readJsonSync(filePath, emptyState()));
    const mergedAuditEvents = mergeAuditEvents(diskState.auditEvents, auditEvents);
    const mergedMetrics = mergeMetricState(diskState.metrics, metricDeltas);
    writeJsonSyncAtomic(filePath, {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
      updatedAt: nowIso(),
      auditEvents: mergedAuditEvents,
      metrics: mergedMetrics
    });
    auditEvents.splice(0, auditEvents.length, ...mergedAuditEvents);
    replaceMetrics(mergedMetrics);
    metricDeltas = emptyMetricDeltas();
  }

  function appendAudit(eventType, payload = {}) {
    const audit = {
      auditId: stableId("upstream_gateway_audit", { eventType, payload, nonce: randomUUID() }),
      eventType,
      serviceId: text(payload.serviceId || ""),
      operationKey: text(payload.operationKey || ""),
      payload,
      createdAt: nowIso()
    };
    auditEvents.push(audit);
    if (auditEvents.length > 1000) {
      auditEvents.splice(0, auditEvents.length - 1000);
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
  } = {}) {
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
  }

  function recordMetric({ serviceId, statusCode = 0, failed = false } = {}) {
    metrics.totalForwardCount += 1;
    metricDeltas.totalForwardCount += 1;
    if (failed) metrics.totalFailureCount += 1;
    if (failed) metricDeltas.totalFailureCount += 1;
    metrics.byService[serviceId] = (metrics.byService[serviceId] || 0) + 1;
    incrementMetricBucket(metricDeltas.byService, serviceId);
    const statusKey = String(statusCode || (failed ? "failed" : "unknown"));
    metrics.byStatus[statusKey] = (metrics.byStatus[statusKey] || 0) + 1;
    incrementMetricBucket(metricDeltas.byStatus, statusKey);
  }

  return {
    auditEvents,
    metrics,
    appendAudit,
    appendSecurityAlert,
    recordMetric,
    refreshRuntimeStateFromDisk,
    persist
  };
}
