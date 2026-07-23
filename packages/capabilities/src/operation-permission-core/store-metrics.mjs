import path from "node:path";
import { getOperationPermissionDatabasePath } from "./store-paths.mjs";
import { nowIso } from "./store-utils.mjs";
import {
  createMetricClauses,
  durationPercentilesFromRows,
  metricWindowSeconds,
  normalizeBucketSeconds,
  normalizeMetricDurationThreshold,
  normalizeMetricExportKind,
  normalizeMetricLimit,
  normalizeMetricMaxRows,
  normalizeMetricThreshold,
  normalizeMetricWindowSeconds,
  normalizeRetentionDays,
  ratio,
  retentionCutoffIso,
  rowToHttpRequestMetricEvent,
  rowToToolMetricEvent,
  safeFileSize,
  summarizeMetricBuckets,
  summarizePendingOperationRows,
  summarizeRequestMetricRows,
  summarizeToolUsageDimension
} from "./store-metrics-utils.mjs";
import { createMetricsPrometheus } from "./store-prometheus.mjs";

export function createMetricsStoreMethods(ctx) {
  const { db, userDataPath } = ctx;

  function metricsSummary({
    limit = 2000,
    since = "",
    until = "",
    toolId = "",
    grantId = "",
    profileId = "",
    route = "",
    transport = "",
    status = "",
    statusCode = "",
    completionStatus = "",
    bucketSeconds = 0
  } = {}) {
    const normalizedLimit = normalizeMetricLimit(limit);
    const normalizedBucketSeconds = normalizeBucketSeconds(bucketSeconds);
    const toolFilters = createMetricClauses({ since, until, toolId, grantId, profileId, status }, "tool");
    const requestFilters = createMetricClauses({
      since,
      until,
      route,
      transport,
      status,
      statusCode,
      completionStatus
    }, "request");
    const pendingOperationFilters = createMetricClauses({ since, until, toolId, grantId, profileId }, "tool");
    const rows = db.prepare(`
      SELECT * FROM tool_metric_events
      ${toolFilters.clauses.length ? `WHERE ${toolFilters.clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...toolFilters.params, normalizedLimit);
    const byStatus = {};
    const byTool = {};
    const byProfile = {};
    const byGrant = {};
    const byRisk = {};
    const deniedByReason = {};
    let durationTotal = 0;
    let inputBytesTotal = 0;
    let resultBytesTotal = 0;
    let transferBytesTotal = 0;
    let byteRateTotal = 0;
    let peakBytesPerSecond = 0;
    let timeoutTotal = 0;
    let rateLimitedTotal = 0;
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      byTool[row.tool_id] = (byTool[row.tool_id] || 0) + 1;
      if (row.profile_id) {
        byProfile[row.profile_id] = (byProfile[row.profile_id] || 0) + 1;
      }
      if (row.grant_id) {
        byGrant[row.grant_id] = (byGrant[row.grant_id] || 0) + 1;
      }
      if (row.risk) {
        byRisk[row.risk] = (byRisk[row.risk] || 0) + 1;
      }
      if (row.status === "denied") {
        deniedByReason[row.reason_code || "unknown"] = (deniedByReason[row.reason_code || "unknown"] || 0) + 1;
      }
      if (row.reason_code === "tool_timeout") {
        timeoutTotal += 1;
      }
      if (row.reason_code === "rate_limited") {
        rateLimitedTotal += 1;
      }
      const durationMs = Number(row.duration_ms || 0);
      const inputBytes = Number(row.input_bytes || 0);
      const resultBytes = Number(row.result_bytes || 0);
      const transferBytes = Number(row.transfer_bytes || inputBytes + resultBytes);
      const bytesPerSecond = Number(row.bytes_per_second || 0);
      durationTotal += durationMs;
      inputBytesTotal += inputBytes;
      resultBytesTotal += resultBytes;
      transferBytesTotal += transferBytes;
      byteRateTotal += bytesPerSecond;
      peakBytesPerSecond = Math.max(peakBytesPerSecond, bytesPerSecond);
    }
    const requestRows = db.prepare(`
      SELECT * FROM http_request_metric_events
      ${requestFilters.clauses.length ? `WHERE ${requestFilters.clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...requestFilters.params, normalizedLimit);
    const requests = summarizeRequestMetricRows(requestRows);
    ctx.expirePendingOperations();
    const pendingOperationRows = db.prepare(`
      SELECT * FROM tool_pending_operations
      ${pendingOperationFilters.clauses.length ? `WHERE ${pendingOperationFilters.clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...pendingOperationFilters.params, normalizedLimit);
    const pendingOperations = summarizePendingOperationRows(pendingOperationRows);
    const activeExecutions = db.prepare("SELECT count(*) AS count FROM tool_executions WHERE status = 'running'").get().count;
    const toolCalls = {
      total: rows.length,
      byStatus,
      byTool,
      byProfile,
      byGrant,
      usageByGrant: summarizeToolUsageDimension(rows, "grant_id", "grantId"),
      usageByProfile: summarizeToolUsageDimension(rows, "profile_id", "profileId"),
      byRisk,
      deniedByReason,
      timeoutTotal,
      rateLimitedTotal,
      activeExecutions,
      averageDurationMs: rows.length ? Number((durationTotal / rows.length).toFixed(2)) : 0,
      inputBytesTotal,
      resultBytesTotal,
      transferBytesTotal,
      averageBytesPerSecond: rows.length ? Number((byteRateTotal / rows.length).toFixed(2)) : 0,
      peakBytesPerSecond
    };
    return {
      filters: {
        limit: normalizedLimit,
        since: String(since || ""),
        until: String(until || ""),
        toolId: String(toolId || ""),
        grantId: String(grantId || ""),
        profileId: String(profileId || ""),
        route: String(route || ""),
        transport: String(transport || ""),
        status: String(status || ""),
        statusCode: String(statusCode || ""),
        completionStatus: String(completionStatus || ""),
        bucketSeconds: normalizedBucketSeconds
      },
      callsTotal: rows.length,
      byStatus,
      byTool,
      byProfile,
      byGrant,
      byRisk,
      deniedByReason,
      timeoutTotal,
      rateLimitedTotal,
      activeExecutions,
      averageDurationMs: rows.length ? Number((durationTotal / rows.length).toFixed(2)) : 0,
      inputBytesTotal,
      resultBytesTotal,
      transferBytesTotal,
      averageBytesPerSecond: rows.length ? Number((byteRateTotal / rows.length).toFixed(2)) : 0,
      peakBytesPerSecond,
      toolCalls,
      requests,
      pendingOperations,
      series: summarizeMetricBuckets({
        toolRows: rows,
        requestRows,
        bucketSeconds: normalizedBucketSeconds
      })
    };
  }

  function metricsExport({
    limit = 2000,
    since = "",
    until = "",
    kind = "all",
    toolId = "",
    grantId = "",
    profileId = "",
    route = "",
    transport = "",
    status = "",
    statusCode = "",
    completionStatus = ""
  } = {}) {
    const normalizedLimit = normalizeMetricLimit(limit);
    const normalizedKind = normalizeMetricExportKind(kind);
    const includeTools = normalizedKind === "all" || normalizedKind === "tool";
    const includeRequests = normalizedKind === "all" || normalizedKind === "request";
    const toolFilters = createMetricClauses({ since, until, toolId, grantId, profileId, status }, "tool");
    const requestFilters = createMetricClauses({
      since,
      until,
      route,
      transport,
      status,
      statusCode,
      completionStatus
    }, "request");
    const toolMetricEvents = includeTools
      ? db.prepare(`
          SELECT * FROM tool_metric_events
          ${toolFilters.clauses.length ? `WHERE ${toolFilters.clauses.join(" AND ")}` : ""}
          ORDER BY created_at DESC
          LIMIT ?
        `).all(...toolFilters.params, normalizedLimit).map(rowToToolMetricEvent)
      : [];
    const httpRequestMetricEvents = includeRequests
      ? db.prepare(`
          SELECT * FROM http_request_metric_events
          ${requestFilters.clauses.length ? `WHERE ${requestFilters.clauses.join(" AND ")}` : ""}
          ORDER BY created_at DESC
          LIMIT ?
        `).all(...requestFilters.params, normalizedLimit).map(rowToHttpRequestMetricEvent)
      : [];
    return {
      schemaVersion: "v0.0.1:operation-permission:metrics-export-1",
      generatedAt: nowIso(),
      filters: {
        limit: normalizedLimit,
        since: String(since || ""),
        until: String(until || ""),
        kind: normalizedKind,
        toolId: String(toolId || ""),
        grantId: String(grantId || ""),
        profileId: String(profileId || ""),
        route: String(route || ""),
        transport: String(transport || ""),
        status: String(status || ""),
        statusCode: String(statusCode || ""),
        completionStatus: String(completionStatus || "")
      },
      counts: {
        toolMetricEvents: toolMetricEvents.length,
        httpRequestMetricEvents: httpRequestMetricEvents.length,
        total: toolMetricEvents.length + httpRequestMetricEvents.length
      },
      toolMetricEvents,
      httpRequestMetricEvents
    };
  }

  function metricsHealth({
    windowSeconds = 300,
    maxRequestErrorRate = 0.05,
    maxToolFailureRate = 0.05,
    maxDeniedRate = 0.2,
    maxRequestP95Ms = 0,
    maxToolP95Ms = 0,
    minRequests = 0
  } = {}) {
    const normalizedWindowSeconds = normalizeMetricWindowSeconds(windowSeconds);
    const thresholds = {
      maxRequestErrorRate: normalizeMetricThreshold(maxRequestErrorRate, 0.05),
      maxToolFailureRate: normalizeMetricThreshold(maxToolFailureRate, 0.05),
      maxDeniedRate: normalizeMetricThreshold(maxDeniedRate, 0.2),
      maxRequestP95Ms: normalizeMetricDurationThreshold(maxRequestP95Ms, 0),
      maxToolP95Ms: normalizeMetricDurationThreshold(maxToolP95Ms, 0),
      minRequests: Math.max(0, Math.floor(Number(minRequests || 0) || 0))
    };
    const endedAt = nowIso();
    const startedAt = new Date(Date.now() - normalizedWindowSeconds * 1000).toISOString();
    const toolRow = db.prepare(`
      SELECT
        count(*) AS total,
        coalesce(sum(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok_total,
        coalesce(sum(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0) AS denied_total,
        coalesce(sum(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failure_total,
        coalesce(sum(CASE WHEN reason_code = 'tool_timeout' THEN 1 ELSE 0 END), 0) AS timeout_total,
        coalesce(sum(CASE WHEN reason_code = 'rate_limited' THEN 1 ELSE 0 END), 0) AS rate_limited_total,
        coalesce(sum(input_bytes), 0) AS input_bytes_total,
        coalesce(sum(result_bytes), 0) AS result_bytes_total,
        coalesce(sum(transfer_bytes), 0) AS transfer_bytes_total,
        coalesce(avg(duration_ms), 0) AS average_duration_ms,
        coalesce(avg(bytes_per_second), 0) AS average_bytes_per_second,
        coalesce(max(bytes_per_second), 0) AS peak_bytes_per_second
      FROM tool_metric_events
      WHERE created_at >= ? AND created_at <= ?
    `).get(startedAt, endedAt);
    const requestRow = db.prepare(`
      SELECT
        count(*) AS total,
        coalesce(sum(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) AS success_total,
        coalesce(sum(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END), 0) AS client_error_total,
        coalesce(sum(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0) AS server_error_total,
        coalesce(sum(CASE WHEN completion_status != 'completed' THEN 1 ELSE 0 END), 0) AS completion_failure_total,
        coalesce(sum(request_bytes), 0) AS request_bytes_total,
        coalesce(sum(response_bytes), 0) AS response_bytes_total,
        coalesce(sum(transfer_bytes), 0) AS transfer_bytes_total,
        coalesce(avg(duration_ms), 0) AS average_duration_ms,
        coalesce(avg(bytes_per_second), 0) AS average_bytes_per_second,
        coalesce(max(bytes_per_second), 0) AS peak_bytes_per_second
      FROM http_request_metric_events
      WHERE created_at >= ? AND created_at <= ?
    `).get(startedAt, endedAt);
    const toolDurationPercentiles = durationPercentilesFromRows(db.prepare(`
      SELECT duration_ms
      FROM tool_metric_events
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY duration_ms ASC
    `).all(startedAt, endedAt));
    const requestDurationPercentiles = durationPercentilesFromRows(db.prepare(`
      SELECT duration_ms
      FROM http_request_metric_events
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY duration_ms ASC
    `).all(startedAt, endedAt));
    const topTools = db.prepare(`
      SELECT
        tool_id,
        count(*) AS total,
        coalesce(sum(transfer_bytes), 0) AS transfer_bytes_total,
        coalesce(avg(duration_ms), 0) AS average_duration_ms
      FROM tool_metric_events
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY tool_id
      ORDER BY total DESC, transfer_bytes_total DESC
      LIMIT 10
    `).all(startedAt, endedAt).map((row) => {
      const transferBytesTotal = Number(row.transfer_bytes_total || 0);
      return {
        toolId: row.tool_id,
        total: Number(row.total || 0),
        transferBytesTotal,
        transferBytesPerSecond: Number((transferBytesTotal / normalizedWindowSeconds).toFixed(2)),
        averageDurationMs: Number(Number(row.average_duration_ms || 0).toFixed(2)),
        durationPercentiles: durationPercentilesFromRows(db.prepare(`
          SELECT duration_ms
          FROM tool_metric_events
          WHERE created_at >= ? AND created_at <= ? AND tool_id = ?
          ORDER BY duration_ms ASC
        `).all(startedAt, endedAt, row.tool_id))
      };
    });
    const topRoutes = db.prepare(`
      SELECT
        transport,
        method,
        route,
        count(*) AS total,
        coalesce(sum(transfer_bytes), 0) AS transfer_bytes_total,
        coalesce(avg(duration_ms), 0) AS average_duration_ms
      FROM http_request_metric_events
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY transport, method, route
      ORDER BY total DESC, transfer_bytes_total DESC
      LIMIT 10
    `).all(startedAt, endedAt).map((row) => {
      const transferBytesTotal = Number(row.transfer_bytes_total || 0);
      return {
        transport: row.transport,
        method: row.method,
        route: row.route,
        total: Number(row.total || 0),
        transferBytesTotal,
        transferBytesPerSecond: Number((transferBytesTotal / normalizedWindowSeconds).toFixed(2)),
        averageDurationMs: Number(Number(row.average_duration_ms || 0).toFixed(2)),
        durationPercentiles: durationPercentilesFromRows(db.prepare(`
          SELECT duration_ms
          FROM http_request_metric_events
          WHERE created_at >= ? AND created_at <= ? AND transport = ? AND method = ? AND route = ?
          ORDER BY duration_ms ASC
        `).all(startedAt, endedAt, row.transport, row.method, row.route))
      };
    });

    const toolTotal = Number(toolRow.total || 0);
    const requestTotal = Number(requestRow.total || 0);
    const toolCalls = {
      total: toolTotal,
      okTotal: Number(toolRow.ok_total || 0),
      deniedTotal: Number(toolRow.denied_total || 0),
      failureTotal: Number(toolRow.failure_total || 0),
      timeoutTotal: Number(toolRow.timeout_total || 0),
      rateLimitedTotal: Number(toolRow.rate_limited_total || 0),
      callsPerMinute: Number(((toolTotal * 60) / normalizedWindowSeconds).toFixed(2)),
      failureRate: ratio(toolRow.failure_total, toolTotal),
      deniedRate: ratio(toolRow.denied_total, toolTotal),
      inputBytesTotal: Number(toolRow.input_bytes_total || 0),
      resultBytesTotal: Number(toolRow.result_bytes_total || 0),
      transferBytesTotal: Number(toolRow.transfer_bytes_total || 0),
      transferBytesPerSecond: Number((Number(toolRow.transfer_bytes_total || 0) / normalizedWindowSeconds).toFixed(2)),
      averageDurationMs: Number(Number(toolRow.average_duration_ms || 0).toFixed(2)),
      durationPercentiles: toolDurationPercentiles,
      averageBytesPerSecond: Number(Number(toolRow.average_bytes_per_second || 0).toFixed(2)),
      peakBytesPerSecond: Number(toolRow.peak_bytes_per_second || 0),
      topTools
    };
    const requests = {
      total: requestTotal,
      successTotal: Number(requestRow.success_total || 0),
      clientErrorTotal: Number(requestRow.client_error_total || 0),
      serverErrorTotal: Number(requestRow.server_error_total || 0),
      completionFailureTotal: Number(requestRow.completion_failure_total || 0),
      requestsPerMinute: Number(((requestTotal * 60) / normalizedWindowSeconds).toFixed(2)),
      serverErrorRate: ratio(requestRow.server_error_total, requestTotal),
      clientErrorRate: ratio(requestRow.client_error_total, requestTotal),
      completionFailureRate: ratio(requestRow.completion_failure_total, requestTotal),
      requestBytesTotal: Number(requestRow.request_bytes_total || 0),
      responseBytesTotal: Number(requestRow.response_bytes_total || 0),
      transferBytesTotal: Number(requestRow.transfer_bytes_total || 0),
      transferBytesPerSecond: Number((Number(requestRow.transfer_bytes_total || 0) / normalizedWindowSeconds).toFixed(2)),
      averageDurationMs: Number(Number(requestRow.average_duration_ms || 0).toFixed(2)),
      durationPercentiles: requestDurationPercentiles,
      averageBytesPerSecond: Number(Number(requestRow.average_bytes_per_second || 0).toFixed(2)),
      peakBytesPerSecond: Number(requestRow.peak_bytes_per_second || 0),
      topRoutes
    };
    const breaches = [];
    if (thresholds.minRequests && requestTotal < thresholds.minRequests) {
      breaches.push({
        code: "request_volume_low",
        severity: "warn",
        observed: requestTotal,
        threshold: thresholds.minRequests
      });
    }
    if (requests.serverErrorRate > thresholds.maxRequestErrorRate) {
      breaches.push({
        code: "request_server_error_rate",
        severity: "critical",
        observed: requests.serverErrorRate,
        threshold: thresholds.maxRequestErrorRate
      });
    }
    if (requests.completionFailureRate > thresholds.maxRequestErrorRate) {
      breaches.push({
        code: "request_completion_failure_rate",
        severity: "critical",
        observed: requests.completionFailureRate,
        threshold: thresholds.maxRequestErrorRate
      });
    }
    if (thresholds.maxRequestP95Ms > 0 && requests.durationPercentiles.p95Ms > thresholds.maxRequestP95Ms) {
      breaches.push({
        code: "request_p95_duration_ms",
        severity: "warn",
        observed: requests.durationPercentiles.p95Ms,
        threshold: thresholds.maxRequestP95Ms
      });
    }
    if (toolCalls.failureRate > thresholds.maxToolFailureRate) {
      breaches.push({
        code: "tool_failure_rate",
        severity: "critical",
        observed: toolCalls.failureRate,
        threshold: thresholds.maxToolFailureRate
      });
    }
    if (toolCalls.deniedRate > thresholds.maxDeniedRate) {
      breaches.push({
        code: "tool_denied_rate",
        severity: "warn",
        observed: toolCalls.deniedRate,
        threshold: thresholds.maxDeniedRate
      });
    }
    if (thresholds.maxToolP95Ms > 0 && toolCalls.durationPercentiles.p95Ms > thresholds.maxToolP95Ms) {
      breaches.push({
        code: "tool_p95_duration_ms",
        severity: "warn",
        observed: toolCalls.durationPercentiles.p95Ms,
        threshold: thresholds.maxToolP95Ms
      });
    }
    const status = breaches.some((breach) => breach.severity === "critical")
      ? "critical"
      : breaches.length
        ? "warn"
        : "ok";
    return {
      schemaVersion: "v0.0.1:operation-permission:metrics-health-1",
      generatedAt: endedAt,
      status,
      window: {
        startedAt,
        endedAt,
        windowSeconds: normalizedWindowSeconds
      },
      thresholds,
      requests,
      toolCalls,
      breaches
    };
  }

  const metricsPrometheus = createMetricsPrometheus({ metricsHealth });

  function metricTableStorageSummary(kind) {
    if (kind === "tool") {
      const row = db.prepare(`
        SELECT
          count(*) AS rows,
          min(created_at) AS oldest_created_at,
          max(created_at) AS newest_created_at,
          coalesce(sum(input_bytes), 0) AS input_bytes_total,
          coalesce(sum(result_bytes), 0) AS result_bytes_total,
          coalesce(sum(transfer_bytes), 0) AS transfer_bytes_total,
          coalesce(avg(bytes_per_second), 0) AS average_bytes_per_second,
          coalesce(max(bytes_per_second), 0) AS peak_bytes_per_second
        FROM tool_metric_events
      `).get();
      const rows = Number(row.rows || 0);
      const observedWindowSeconds = metricWindowSeconds(row.oldest_created_at, row.newest_created_at, rows);
      const transferBytesTotal = Number(row.transfer_bytes_total || 0);
      return {
        tableName: "tool_metric_events",
        rows,
        oldestCreatedAt: row.oldest_created_at || "",
        newestCreatedAt: row.newest_created_at || "",
        observedWindowSeconds,
        eventsPerMinute: observedWindowSeconds ? Number(((rows * 60) / observedWindowSeconds).toFixed(2)) : 0,
        inputBytesTotal: Number(row.input_bytes_total || 0),
        resultBytesTotal: Number(row.result_bytes_total || 0),
        transferBytesTotal,
        observedTransferBytesPerSecond: observedWindowSeconds
          ? Number((transferBytesTotal / observedWindowSeconds).toFixed(2))
          : 0,
        averageBytesPerSecond: Number(Number(row.average_bytes_per_second || 0).toFixed(2)),
        peakBytesPerSecond: Number(row.peak_bytes_per_second || 0)
      };
    }

    if (kind === "request") {
      const row = db.prepare(`
        SELECT
          count(*) AS rows,
          min(created_at) AS oldest_created_at,
          max(created_at) AS newest_created_at,
          coalesce(sum(request_bytes), 0) AS request_bytes_total,
          coalesce(sum(response_bytes), 0) AS response_bytes_total,
          coalesce(sum(transfer_bytes), 0) AS transfer_bytes_total,
          coalesce(avg(bytes_per_second), 0) AS average_bytes_per_second,
          coalesce(max(bytes_per_second), 0) AS peak_bytes_per_second
        FROM http_request_metric_events
      `).get();
      const rows = Number(row.rows || 0);
      const observedWindowSeconds = metricWindowSeconds(row.oldest_created_at, row.newest_created_at, rows);
      const transferBytesTotal = Number(row.transfer_bytes_total || 0);
      return {
        tableName: "http_request_metric_events",
        rows,
        oldestCreatedAt: row.oldest_created_at || "",
        newestCreatedAt: row.newest_created_at || "",
        observedWindowSeconds,
        eventsPerMinute: observedWindowSeconds ? Number(((rows * 60) / observedWindowSeconds).toFixed(2)) : 0,
        requestBytesTotal: Number(row.request_bytes_total || 0),
        responseBytesTotal: Number(row.response_bytes_total || 0),
        transferBytesTotal,
        observedTransferBytesPerSecond: observedWindowSeconds
          ? Number((transferBytesTotal / observedWindowSeconds).toFixed(2))
          : 0,
        averageBytesPerSecond: Number(Number(row.average_bytes_per_second || 0).toFixed(2)),
        peakBytesPerSecond: Number(row.peak_bytes_per_second || 0)
      };
    }

    throw new Error("Unknown metric storage table kind.");
  }

  function metricsStorageSummary() {
    const databasePath = getOperationPermissionDatabasePath(userDataPath);
    const databaseBytes = safeFileSize(databasePath);
    const walBytes = safeFileSize(`${databasePath}-wal`);
    const shmBytes = safeFileSize(`${databasePath}-shm`);
    const toolMetricEvents = metricTableStorageSummary("tool");
    const httpRequestMetricEvents = metricTableStorageSummary("request");
    const metricRows = toolMetricEvents.rows + httpRequestMetricEvents.rows;
    const transferBytesTotal = toolMetricEvents.transferBytesTotal + httpRequestMetricEvents.transferBytesTotal;
    return {
      schemaVersion: "v0.0.1:operation-permission:metrics-storage-1",
      generatedAt: nowIso(),
      database: {
        fileName: path.basename(databasePath),
        bytes: databaseBytes,
        walBytes,
        shmBytes,
        totalBytes: databaseBytes + walBytes + shmBytes
      },
      tables: {
        toolMetricEvents,
        httpRequestMetricEvents
      },
      totals: {
        metricRows,
        transferBytesTotal,
        observedTransferBytesPerSecond: Number((
          toolMetricEvents.observedTransferBytesPerSecond +
          httpRequestMetricEvents.observedTransferBytesPerSecond
        ).toFixed(2))
      }
    };
  }

  function pruneMetrics({
    olderThan = "",
    retentionDays = 0,
    maxRows = 0,
    maxToolMetricRows = 0,
    maxHttpRequestMetricRows = 0,
    dryRun = false
  } = {}) {
    const cutoff = retentionCutoffIso({ olderThan, retentionDays });
    const normalizedMaxRows = normalizeMetricMaxRows(maxRows);
    const normalizedMaxToolMetricRows = normalizeMetricMaxRows(maxToolMetricRows) || normalizedMaxRows;
    const normalizedMaxHttpRequestMetricRows = normalizeMetricMaxRows(maxHttpRequestMetricRows) || normalizedMaxRows;

    const before = {
      toolMetrics: db.prepare("SELECT count(*) AS count FROM tool_metric_events").get().count,
      httpRequestMetrics: db.prepare("SELECT count(*) AS count FROM http_request_metric_events").get().count
    };
    const cutoffCounts = cutoff
      ? {
          toolMetrics: db.prepare("SELECT count(*) AS count FROM tool_metric_events WHERE created_at < ?").get(cutoff).count,
          httpRequestMetrics: db.prepare("SELECT count(*) AS count FROM http_request_metric_events WHERE created_at < ?").get(cutoff).count
        }
      : { toolMetrics: 0, httpRequestMetrics: 0 };
    const maxRowCounts = {
      toolMetrics: normalizedMaxToolMetricRows
        ? Math.max(0, before.toolMetrics - normalizedMaxToolMetricRows)
        : 0,
      httpRequestMetrics: normalizedMaxHttpRequestMetricRows
        ? Math.max(0, before.httpRequestMetrics - normalizedMaxHttpRequestMetricRows)
        : 0
    };
    const planned = {
      toolMetrics: Math.max(cutoffCounts.toolMetrics, maxRowCounts.toolMetrics),
      httpRequestMetrics: Math.max(cutoffCounts.httpRequestMetrics, maxRowCounts.httpRequestMetrics)
    };

    let deletedToolMetrics = 0;
    let deletedHttpRequestMetrics = 0;
    if (!dryRun) {
      const run = db.transaction(() => {
        if (cutoff) {
          deletedToolMetrics += db.prepare("DELETE FROM tool_metric_events WHERE created_at < ?").run(cutoff).changes;
          deletedHttpRequestMetrics += db.prepare("DELETE FROM http_request_metric_events WHERE created_at < ?").run(cutoff).changes;
        }
        if (normalizedMaxToolMetricRows) {
          const remainingToolMetrics = db.prepare("SELECT count(*) AS count FROM tool_metric_events").get().count;
          const overflow = Math.max(0, remainingToolMetrics - normalizedMaxToolMetricRows);
          if (overflow > 0) {
            deletedToolMetrics += db.prepare(`
              DELETE FROM tool_metric_events
              WHERE metric_id IN (
                SELECT metric_id FROM tool_metric_events ORDER BY created_at ASC LIMIT ?
              )
            `).run(overflow).changes;
          }
        }
        if (normalizedMaxHttpRequestMetricRows) {
          const remainingHttpMetrics = db.prepare("SELECT count(*) AS count FROM http_request_metric_events").get().count;
          const overflow = Math.max(0, remainingHttpMetrics - normalizedMaxHttpRequestMetricRows);
          if (overflow > 0) {
            deletedHttpRequestMetrics += db.prepare(`
              DELETE FROM http_request_metric_events
              WHERE metric_id IN (
                SELECT metric_id FROM http_request_metric_events ORDER BY created_at ASC LIMIT ?
              )
            `).run(overflow).changes;
          }
        }
      });
      run();
    }
    const after = dryRun
      ? before
      : {
          toolMetrics: db.prepare("SELECT count(*) AS count FROM tool_metric_events").get().count,
          httpRequestMetrics: db.prepare("SELECT count(*) AS count FROM http_request_metric_events").get().count
        };

    return {
      schemaVersion: "v0.0.1:operation-permission:metrics-prune-1",
      dryRun: Boolean(dryRun),
      cutoff,
      retentionDays: normalizeRetentionDays(retentionDays),
      maxToolMetricRows: normalizedMaxToolMetricRows,
      maxHttpRequestMetricRows: normalizedMaxHttpRequestMetricRows,
      planned,
      deleted: {
        toolMetrics: dryRun ? 0 : deletedToolMetrics,
        httpRequestMetrics: dryRun ? 0 : deletedHttpRequestMetrics
      },
      before,
      after
    };
  }

  return {
    metricsSummary,
    metricsExport,
    metricsHealth,
    metricsPrometheus,
    metricsStorageSummary,
    pruneMetrics
  };
}
