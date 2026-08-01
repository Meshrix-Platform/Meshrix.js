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
} from "./support.ts";

function emptyMetricDeltas() : any {
  return {
    totalForwardCount: 0,
    totalFailureCount: 0,
    byService: {},
    byStatus: {}
  };
}

function mergeAuditEvents(...eventLists: any[]) : any {
  const byId: any = new Map<any, any>();
  for (const event of eventLists.flatMap((items?: any) : any => asArray(items))) {
    const auditId: any = text(event?.auditId || "");
    if (!auditId) continue;
    byId.set(auditId, clone(event));
  }
  return [...byId.values()]
    .sort((left?: any, right?: any) : any => text(left.createdAt).localeCompare(text(right.createdAt)))
    .slice(-1000);
}

function incrementMetricBucket(bucket: Record<string, any> = {}, key: any = "", amount: any = 1) : any {
  const normalizedKey: any = text(key || "unknown");
  bucket[normalizedKey] = Number(bucket[normalizedKey] || 0) + amount;
}

function mergeMetricState(base: Record<string, any> = {}, deltas: Record<string, any> = {}) : any {
  const merged: Record<string, any> = {
    totalForwardCount: Number(base.totalForwardCount || 0) + Number(deltas.totalForwardCount || 0),
    totalFailureCount: Number(base.totalFailureCount || 0) + Number(deltas.totalFailureCount || 0),
    byService: { ...object(base.byService) },
    byStatus: { ...object(base.byStatus) }
  };
  for (const [serviceId, count] of (Object.entries(object(deltas.byService)) as [string, any][])) {
    incrementMetricBucket(merged.byService, serviceId, Number(count || 0));
  }
  for (const [statusKey, count] of (Object.entries(object(deltas.byStatus)) as [string, any][])) {
    incrementMetricBucket(merged.byStatus, statusKey, Number(count || 0));
  }
  return merged;
}

export function createGatewayRuntime({
  persistenceEnabled = false,
  filePath = "",
  securityAlertStore = null
}: Record<string, any> = {}) : any {
  const state: any = normalizeState(
    persistenceEnabled ? readJsonSync(filePath, emptyState()) : emptyState()
  );
  const auditEvents: any = state.auditEvents;
  const metrics: any = state.metrics;
  let metricDeltas: any = emptyMetricDeltas();

  function replaceMetrics(nextMetrics: Record<string, any> = {}) : any {
    metrics.totalForwardCount = Number(nextMetrics.totalForwardCount || 0);
    metrics.totalFailureCount = Number(nextMetrics.totalFailureCount || 0);
    metrics.byService = { ...object(nextMetrics.byService) };
    metrics.byStatus = { ...object(nextMetrics.byStatus) };
  }

  function refreshRuntimeStateFromDisk() : any {
    if (!persistenceEnabled) return;
    const diskState: any = normalizeState(readJsonSync(filePath, emptyState()));
    const mergedAuditEvents: any = mergeAuditEvents(diskState.auditEvents, auditEvents);
    auditEvents.splice(0, auditEvents.length, ...mergedAuditEvents);
    replaceMetrics(mergeMetricState(diskState.metrics, metricDeltas));
  }

  function persist() : any {
    if (!persistenceEnabled) return;
    const diskState: any = normalizeState(readJsonSync(filePath, emptyState()));
    const mergedAuditEvents: any = mergeAuditEvents(diskState.auditEvents, auditEvents);
    const mergedMetrics: any = mergeMetricState(diskState.metrics, metricDeltas);
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

  function appendAudit(eventType?: any, payload: Record<string, any> = {}) : any {
    const audit: Record<string, any> = {
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
  }

  function recordMetric({ serviceId, statusCode = 0, failed = false }: Record<string, any> = {}) : any {
    metrics.totalForwardCount += 1;
    metricDeltas.totalForwardCount += 1;
    if (failed) metrics.totalFailureCount += 1;
    if (failed) metricDeltas.totalFailureCount += 1;
    metrics.byService[serviceId] = (metrics.byService[serviceId] || 0) + 1;
    incrementMetricBucket(metricDeltas.byService, serviceId);
    const statusKey: any = String(statusCode || (failed ? "failed" : "unknown"));
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
