import fs from "node:fs";

export function summarizeRequestMetricRows(rows = []) {
  const byStatusCode = {};
  const byCompletionStatus = {};
  const byMethod = {};
  const byRoute = {};
  const byTransport = {};
  let durationTotal = 0;
  let requestBytesTotal = 0;
  let responseBytesTotal = 0;
  let transferBytesTotal = 0;
  let byteRateTotal = 0;
  let peakBytesPerSecond = 0;
  let successTotal = 0;
  let clientErrorTotal = 0;
  let serverErrorTotal = 0;
  let completionFailureTotal = 0;
  const durationRows = [];
  let firstTimestamp = 0;
  let lastTimestamp = 0;

  for (const row of rows) {
    const statusKey = String(row.status_code || 0);
    const statusCode = Number(row.status_code || 0);
    const completionStatus = row.completion_status || "unknown";
    byStatusCode[statusKey] = (byStatusCode[statusKey] || 0) + 1;
    byCompletionStatus[completionStatus] = (byCompletionStatus[completionStatus] || 0) + 1;
    byMethod[row.method || ""] = (byMethod[row.method || ""] || 0) + 1;
    byRoute[row.route || ""] = (byRoute[row.route || ""] || 0) + 1;
    byTransport[row.transport || "http"] = (byTransport[row.transport || "http"] || 0) + 1;

    const durationMs = Number(row.duration_ms || 0);
    const requestBytes = Number(row.request_bytes || 0);
    const responseBytes = Number(row.response_bytes || 0);
    const transferBytes = Number(row.transfer_bytes || requestBytes + responseBytes);
    const bytesPerSecond = Number(row.bytes_per_second || 0);
    durationTotal += durationMs;
    durationRows.push({ duration_ms: durationMs });
    requestBytesTotal += requestBytes;
    responseBytesTotal += responseBytes;
    transferBytesTotal += transferBytes;
    byteRateTotal += bytesPerSecond;
    peakBytesPerSecond = Math.max(peakBytesPerSecond, bytesPerSecond);
    successTotal += statusCode >= 200 && statusCode < 400 ? 1 : 0;
    clientErrorTotal += statusCode >= 400 && statusCode < 500 ? 1 : 0;
    serverErrorTotal += statusCode >= 500 ? 1 : 0;
    completionFailureTotal += completionStatus === "completed" ? 0 : 1;

    const timestamp = Date.parse(row.created_at || "");
    if (Number.isFinite(timestamp)) {
      firstTimestamp = firstTimestamp ? Math.min(firstTimestamp, timestamp) : timestamp;
      lastTimestamp = Math.max(lastTimestamp, timestamp);
    }
  }

  const observedWindowSeconds = rows.length
    ? Math.max(1, Number(((lastTimestamp - firstTimestamp) / 1000).toFixed(3)) || 1)
    : 0;

  return {
    total: rows.length,
    byStatusCode,
    byCompletionStatus,
    byMethod,
    byRoute,
    byTransport,
    successTotal,
    clientErrorTotal,
    serverErrorTotal,
    completionFailureTotal,
    serverErrorRate: ratio(serverErrorTotal, rows.length),
    clientErrorRate: ratio(clientErrorTotal, rows.length),
    completionFailureRate: ratio(completionFailureTotal, rows.length),
    requestBytesTotal,
    responseBytesTotal,
    transferBytesTotal,
    averageDurationMs: rows.length ? Number((durationTotal / rows.length).toFixed(2)) : 0,
    durationPercentiles: durationPercentilesFromRows(durationRows),
    observedWindowSeconds,
    requestsPerMinute: observedWindowSeconds
      ? Number(((rows.length * 60) / observedWindowSeconds).toFixed(2))
      : 0,
    transferBytesPerSecond: observedWindowSeconds
      ? Number((transferBytesTotal / observedWindowSeconds).toFixed(2))
      : 0,
    averageBytesPerSecond: rows.length ? Number((byteRateTotal / rows.length).toFixed(2)) : 0,
    peakBytesPerSecond
  };
}

export function normalizeMetricLimit(value) {
  return Math.max(1, Math.min(Number(value || 2000), 10000));
}

export function normalizeBucketSeconds(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 86_400));
}

export function normalizeMetricWindowSeconds(value) {
  const parsed = Number(value || 300);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 300;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 86_400));
}

export function normalizeMetricExportKind(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  if (normalized === "tool" || normalized === "tools" || normalized === "tool_calls") {
    return "tool";
  }
  if (normalized === "request" || normalized === "requests" || normalized === "http") {
    return "request";
  }
  return "all";
}

export function normalizeMetricThreshold(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  if (parsed > 1 && parsed <= 100) {
    return Number((parsed / 100).toFixed(4));
  }
  return Math.min(parsed, 1);
}

export function normalizeMetricDurationThreshold(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Number(Math.min(parsed, 86_400_000).toFixed(2));
}

export function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function metricWindowSeconds(oldestCreatedAt = "", newestCreatedAt = "", rows = 0) {
  if (!rows) {
    return 0;
  }
  const oldest = Date.parse(oldestCreatedAt || "");
  const newest = Date.parse(newestCreatedAt || "");
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) {
    return 1;
  }
  return Math.max(1, Number(((newest - oldest) / 1000).toFixed(3)) || 1);
}

export function ratio(part, total) {
  const denominator = Number(total || 0);
  if (!denominator) {
    return 0;
  }
  return Number((Number(part || 0) / denominator).toFixed(4));
}

function percentileFromSortedValues(values = [], quantile = 0) {
  if (!values.length) {
    return 0;
  }
  const normalizedQuantile = Math.min(1, Math.max(0, Number(quantile || 0)));
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(normalizedQuantile * values.length) - 1));
  return Number(Number(values[index] || 0).toFixed(2));
}

export function durationPercentilesFromRows(rows = []) {
  const values = rows
    .map((row) => Number(row.duration_ms || 0))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  return {
    p50Ms: percentileFromSortedValues(values, 0.5),
    p95Ms: percentileFromSortedValues(values, 0.95),
    p99Ms: percentileFromSortedValues(values, 0.99)
  };
}

export function summarizeToolUsageDimension(rows = [], columnName = "", outputKey = "", limit = 10) {
  const summaries = new Map();
  for (const row of rows) {
    const dimensionValue = String(row[columnName] || "").trim();
    if (!dimensionValue) {
      continue;
    }
    if (!summaries.has(dimensionValue)) {
      summaries.set(dimensionValue, {
        [outputKey]: dimensionValue,
        total: 0,
        okTotal: 0,
        deniedTotal: 0,
        failureTotal: 0,
        inputBytesTotal: 0,
        resultBytesTotal: 0,
        transferBytesTotal: 0,
        durationTotal: 0,
        byteRateTotal: 0,
        peakBytesPerSecond: 0,
        durationRows: []
      });
    }
    const summary = summaries.get(dimensionValue);
    const status = row.status || "unknown";
    const durationMs = Number(row.duration_ms || 0);
    const inputBytes = Number(row.input_bytes || 0);
    const resultBytes = Number(row.result_bytes || 0);
    const transferBytes = Number(row.transfer_bytes || inputBytes + resultBytes);
    const bytesPerSecond = Number(row.bytes_per_second || 0);
    summary.total += 1;
    summary.okTotal += status === "ok" ? 1 : 0;
    summary.deniedTotal += status === "denied" ? 1 : 0;
    summary.failureTotal += status === "ok" ? 0 : 1;
    summary.inputBytesTotal += inputBytes;
    summary.resultBytesTotal += resultBytes;
    summary.transferBytesTotal += transferBytes;
    summary.durationTotal += durationMs;
    summary.byteRateTotal += bytesPerSecond;
    summary.peakBytesPerSecond = Math.max(summary.peakBytesPerSecond, bytesPerSecond);
    summary.durationRows.push({ duration_ms: durationMs });
  }

  return [...summaries.values()]
    .sort((left, right) =>
      right.total - left.total ||
      right.transferBytesTotal - left.transferBytesTotal ||
      String(left[outputKey]).localeCompare(String(right[outputKey]))
    )
    .slice(0, Math.max(1, Number(limit || 10)))
    .map((summary) => {
      const { durationRows, durationTotal, byteRateTotal, ...publicSummary } = summary;
      return {
        ...publicSummary,
        failureRate: ratio(summary.failureTotal, summary.total),
        deniedRate: ratio(summary.deniedTotal, summary.total),
        averageDurationMs: summary.total ? Number((durationTotal / summary.total).toFixed(2)) : 0,
        durationPercentiles: durationPercentilesFromRows(durationRows),
        averageBytesPerSecond: summary.total ? Number((byteRateTotal / summary.total).toFixed(2)) : 0
      };
    });
}

export function summarizePendingOperationRows(rows = []) {
  const byStatus = {};
  const byTool = {};
  const byOperation = {};
  const byRisk = {};
  const byGrant = {};
  const byProfile = {};
  const byAgent = {};
  let redactedInputBytesTotal = 0;
  let contextBytesTotal = 0;
  let resultSummaryBytesTotal = 0;
  let pendingAgeSecondsTotal = 0;
  let pendingAgeCount = 0;
  let oldestPendingAgeSeconds = 0;
  let oldestCreatedAt = "";
  let newestCreatedAt = "";
  const nowMs = Date.now();

  for (const row of rows) {
    const status = row.status || "unknown";
    const toolId = row.tool_id || "unknown";
    const operationId = row.operation_id || "";
    const risk = row.risk || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
    byTool[toolId] = (byTool[toolId] || 0) + 1;
    byRisk[risk] = (byRisk[risk] || 0) + 1;
    if (operationId) {
      byOperation[operationId] = (byOperation[operationId] || 0) + 1;
    }
    if (row.grant_id) {
      byGrant[row.grant_id] = (byGrant[row.grant_id] || 0) + 1;
    }
    if (row.profile_id) {
      byProfile[row.profile_id] = (byProfile[row.profile_id] || 0) + 1;
    }
    if (row.agent_id) {
      byAgent[row.agent_id] = (byAgent[row.agent_id] || 0) + 1;
    }
    redactedInputBytesTotal += Buffer.byteLength(String(row.redacted_input_json || ""), "utf8");
    contextBytesTotal += Buffer.byteLength(String(row.context_json || ""), "utf8");
    resultSummaryBytesTotal += Buffer.byteLength(String(row.result_summary_json || ""), "utf8");

    const createdAt = String(row.created_at || "");
    if (createdAt) {
      oldestCreatedAt = !oldestCreatedAt || createdAt < oldestCreatedAt ? createdAt : oldestCreatedAt;
      newestCreatedAt = !newestCreatedAt || createdAt > newestCreatedAt ? createdAt : newestCreatedAt;
    }
    if (status === "pending") {
      const createdMs = Date.parse(createdAt);
      if (Number.isFinite(createdMs)) {
        const ageSeconds = Math.max(0, Number(((nowMs - createdMs) / 1000).toFixed(2)));
        pendingAgeSecondsTotal += ageSeconds;
        pendingAgeCount += 1;
        oldestPendingAgeSeconds = Math.max(oldestPendingAgeSeconds, ageSeconds);
      }
    }
  }

  const observedWindowSeconds = metricWindowSeconds(oldestCreatedAt, newestCreatedAt, rows.length);
  const metadataBytesTotal = redactedInputBytesTotal + contextBytesTotal + resultSummaryBytesTotal;
  return {
    total: rows.length,
    pendingTotal: byStatus.pending || 0,
    approvedTotal: byStatus.approved || 0,
    completedTotal: byStatus.completed || 0,
    rejectedTotal: byStatus.rejected || 0,
    expiredTotal: byStatus.expired || 0,
    failedTotal: byStatus.failed || 0,
    byStatus,
    byTool,
    byOperation,
    byRisk,
    byGrant,
    byProfile,
    byAgent,
    redactedInputBytesTotal,
    contextBytesTotal,
    resultSummaryBytesTotal,
    metadataBytesTotal,
    oldestCreatedAt,
    newestCreatedAt,
    observedWindowSeconds,
    operationsPerMinute: observedWindowSeconds
      ? Number(((rows.length * 60) / observedWindowSeconds).toFixed(2))
      : 0,
    averagePendingAgeSeconds: pendingAgeCount
      ? Number((pendingAgeSecondsTotal / pendingAgeCount).toFixed(2))
      : 0,
    oldestPendingAgeSeconds
  };
}

function prometheusEscapeLabel(value = "") {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function prometheusLabels(labels = {}) {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${prometheusEscapeLabel(value)}"`).join(",")}}`;
}

export function prometheusSample(name, value, labels = {}) {
  const numericValue = Number(value || 0);
  return `${name}${prometheusLabels(labels)} ${Number.isFinite(numericValue) ? numericValue : 0}`;
}

export function createMetricClauses({
  since = "",
  until = "",
  status = "",
  toolId = "",
  grantId = "",
  profileId = "",
  route = "",
  transport = "",
  statusCode = "",
  completionStatus = ""
} = {}, kind = "tool") {
  const clauses = [];
  const params = [];
  if (since) {
    clauses.push("created_at >= ?");
    params.push(String(since));
  }
  if (until) {
    clauses.push("created_at <= ?");
    params.push(String(until));
  }
  if (kind === "tool") {
    if (toolId) {
      clauses.push("tool_id = ?");
      params.push(String(toolId));
    }
    if (grantId) {
      clauses.push("grant_id = ?");
      params.push(String(grantId));
    }
    if (profileId) {
      clauses.push("profile_id = ?");
      params.push(String(profileId));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(String(status));
    }
  } else {
    if (route) {
      clauses.push("route = ?");
      params.push(String(route));
    }
    if (transport) {
      clauses.push("transport = ?");
      params.push(String(transport));
    }
    if (statusCode) {
      clauses.push("status_code = ?");
      params.push(Math.max(0, Number(statusCode || 0) || 0));
    }
    if (completionStatus || status) {
      clauses.push("completion_status = ?");
      params.push(String(completionStatus || status));
    }
  }
  return { clauses, params };
}

export function rowToToolMetricEvent(row) {
  return {
    metricId: row.metric_id,
    traceId: row.trace_id,
    toolId: row.tool_id,
    grantId: row.grant_id,
    profileId: row.profile_id,
    status: row.status,
    risk: row.risk,
    durationMs: row.duration_ms,
    inputBytes: row.input_bytes,
    resultBytes: row.result_bytes,
    transferBytes: row.transfer_bytes,
    bytesPerSecond: row.bytes_per_second,
    reasonCode: row.reason_code,
    createdAt: row.created_at
  };
}

export function rowToHttpRequestMetricEvent(row) {
  return {
    metricId: row.metric_id,
    traceId: row.trace_id,
    requestId: row.request_id,
    transport: row.transport,
    method: row.method,
    route: row.route,
    statusCode: row.status_code,
    completionStatus: row.completion_status,
    requestBytes: row.request_bytes,
    responseBytes: row.response_bytes,
    transferBytes: row.transfer_bytes,
    durationMs: row.duration_ms,
    bytesPerSecond: row.bytes_per_second,
    createdAt: row.created_at
  };
}

function bucketStartMs(createdAt = "", bucketSeconds = 60) {
  const timestamp = Date.parse(createdAt || "");
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const bucketMs = Math.max(1, Number(bucketSeconds || 60)) * 1000;
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function emptyBucket(startMs, bucketSeconds) {
  const endMs = startMs + (bucketSeconds * 1000);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    toolCalls: {
      total: 0,
      byStatus: {},
      byTool: {},
      inputBytesTotal: 0,
      resultBytesTotal: 0,
      transferBytesTotal: 0
    },
    requests: {
      total: 0,
      byStatusCode: {},
      byCompletionStatus: {},
      byRoute: {},
      byTransport: {},
      successTotal: 0,
      clientErrorTotal: 0,
      serverErrorTotal: 0,
      completionFailureTotal: 0,
      requestBytesTotal: 0,
      responseBytesTotal: 0,
      transferBytesTotal: 0
    }
  };
}

export function summarizeMetricBuckets({ toolRows = [], requestRows = [], bucketSeconds = 0 } = {}) {
  const normalizedBucketSeconds = normalizeBucketSeconds(bucketSeconds);
  if (!normalizedBucketSeconds) {
    return {
      bucketSeconds: 0,
      buckets: []
    };
  }
  const buckets = new Map();
  const ensureBucket = (createdAt) => {
    const startMs = bucketStartMs(createdAt, normalizedBucketSeconds);
    if (!startMs) {
      return null;
    }
    if (!buckets.has(startMs)) {
      buckets.set(startMs, emptyBucket(startMs, normalizedBucketSeconds));
    }
    return buckets.get(startMs);
  };

  for (const row of toolRows) {
    const bucket = ensureBucket(row.created_at);
    if (!bucket) {
      continue;
    }
    const status = row.status || "unknown";
    const toolId = row.tool_id || "unknown";
    const inputBytes = Number(row.input_bytes || 0);
    const resultBytes = Number(row.result_bytes || 0);
    const transferBytes = Number(row.transfer_bytes || inputBytes + resultBytes);
    bucket.toolCalls.total += 1;
    bucket.toolCalls.byStatus[status] = (bucket.toolCalls.byStatus[status] || 0) + 1;
    bucket.toolCalls.byTool[toolId] = (bucket.toolCalls.byTool[toolId] || 0) + 1;
    bucket.toolCalls.inputBytesTotal += inputBytes;
    bucket.toolCalls.resultBytesTotal += resultBytes;
    bucket.toolCalls.transferBytesTotal += transferBytes;
  }

  for (const row of requestRows) {
    const bucket = ensureBucket(row.created_at);
    if (!bucket) {
      continue;
    }
    const statusCode = String(row.status_code || 0);
    const numericStatusCode = Number(row.status_code || 0);
    const completionStatus = row.completion_status || "unknown";
    const route = row.route || "";
    const transport = row.transport || "http";
    const requestBytes = Number(row.request_bytes || 0);
    const responseBytes = Number(row.response_bytes || 0);
    const transferBytes = Number(row.transfer_bytes || requestBytes + responseBytes);
    bucket.requests.total += 1;
    bucket.requests.byStatusCode[statusCode] = (bucket.requests.byStatusCode[statusCode] || 0) + 1;
    bucket.requests.byCompletionStatus[completionStatus] =
      (bucket.requests.byCompletionStatus[completionStatus] || 0) + 1;
    bucket.requests.byRoute[route] = (bucket.requests.byRoute[route] || 0) + 1;
    bucket.requests.byTransport[transport] = (bucket.requests.byTransport[transport] || 0) + 1;
    bucket.requests.successTotal += numericStatusCode >= 200 && numericStatusCode < 400 ? 1 : 0;
    bucket.requests.clientErrorTotal += numericStatusCode >= 400 && numericStatusCode < 500 ? 1 : 0;
    bucket.requests.serverErrorTotal += numericStatusCode >= 500 ? 1 : 0;
    bucket.requests.completionFailureTotal += completionStatus === "completed" ? 0 : 1;
    bucket.requests.requestBytesTotal += requestBytes;
    bucket.requests.responseBytesTotal += responseBytes;
    bucket.requests.transferBytesTotal += transferBytes;
  }

  return {
    bucketSeconds: normalizedBucketSeconds,
    buckets: [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, bucket]) => bucket)
  };
}

export function normalizeRetentionDays(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 3650));
}

export function normalizeMetricMaxRows(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 1_000_000));
}

export function retentionCutoffIso({ olderThan = "", retentionDays = 0 } = {}) {
  const explicit = String(olderThan || "").trim();
  if (explicit) {
    const parsed = Date.parse(explicit);
    if (!Number.isFinite(parsed)) {
      throw new Error("Metric prune olderThan must be an ISO timestamp.");
    }
    return new Date(parsed).toISOString();
  }
  const days = normalizeRetentionDays(retentionDays);
  if (!days) {
    return "";
  }
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
