/**
 * Runtime JSONL Logger — LicoMesh structured logging with OTel alignment.
 *
 * OTel Semantic Convention Fields (adoption baseline):
 *   service.name, service.version
 *   process.pid, process.command
 *   ci.workflow.name, ci.job.name
 *   gen_ai.operation.name
 *   lico.operation.id, lico.workspace.id, lico.capability.id, lico.receipt.id
 *
 * process.pid is already emitted in log entry metadata.
 * Other fields are adopted incrementally as dispatch paths are instrumented.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getTraceContext, traceDetails } from "./trace-context.mjs";
import { ServerConfig } from "#lico/server-config";
import { OTEL_SEMANTIC_FIELDS } from "./otel-semantic-fields.mjs";

// ── OTel Attribute Registry ─────────────────────────────────────────────────
// Literal field names used in runtime log record instrumentation.
const RUNTIME_LOG_OTEL_ATTRIBUTES = Object.freeze({
  "service.name": "licomesh-server",
  "service.version": "0.0.1",
  "ci.workflow.name": null,
  "ci.job.name": null,
  "gen_ai.operation.name": null,
  "lico.operation.id": null,
  "lico.workspace.id": null,
  "lico.capability.id": null,
  "lico.receipt.id": null,
});

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PENDING_RECORDS = 2048;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const CLEANUP_BYTE_INTERVAL = 8 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 5;
const PROCESS_PROJECTION_KEY = crypto.randomBytes(32);
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|csrf|token|password|passwd|secret|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|private[-_]?key|session)/i;
const IDENTITY_KEY_PATTERN =
  /^(?:account[-_]?id|actor(?:[-_]?id)?|agent[-_]?id|client(?:[-_]?(?:fingerprint|id|name))?|device[-_]?id|endpoint[-_]?id|installation[-_]?id|machine[-_]?id|principal(?:[-_]?id)?|remote[-_]?(?:addr|address)|source[-_]?ip|subject(?:[-_]?(?:id|key))?|user(?:name|[-_]?(?:agent|id|name))?)$/i;
const METADATA_ONLY_KEY_PATTERN =
  /^(body|bodyJson|headers|params|payload|query|queryParams|rpcParams|searchParams)$/i;
const ERROR_TEXT_KEY_PATTERN = /^(error|errorMessage|message|stack)$/i;
const SAFE_CATEGORY_KEY_PATTERN =
  /^(code|completionStatus|edition|method|mode|operationId|profile|reasonCode|status|transport|type)$/i;
const DIGEST_KEY_PATTERN = /^(hash|sha256)$/i;
const SAFE_CATEGORY_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/;
const DIGEST_VALUE_PATTERN = /^(?:hmac-sha256:)?[a-f0-9]{16,64}$/i;
const HTTP_ROUTE_KEY_PATTERN = /^(pathname|route)$/i;
const ABSOLUTE_PATH_VALUE_PATTERN =
  /(?:[A-Za-z]:\\[^\s"'<>]+|\\\\[^\s"'<>]+|\/[A-Za-z][A-Za-z0-9._-]*(?:\/[^\s"',<>]+)+)/;

let defaultLogger = null;

const LEVEL_RANK = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

function nowIso() {
  return new Date().toISOString();
}

function datePart(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function digestSource(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  try {
    return Buffer.from(JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? String(nested) : nested
    ) ?? "", "utf8");
  } catch {
    return Buffer.from(Object.prototype.toString.call(value), "utf8");
  }
}

function projectionHash(value, options = {}) {
  const projectionKey = options.projectionKey || PROCESS_PROJECTION_KEY;
  const namespace = String(options.namespace || "runtime-log");
  return crypto
    .createHmac("sha256", projectionKey)
    .update(namespace)
    .update("\u001f")
    .update(digestSource(value))
    .digest("hex");
}

function shortHash(value, options = {}) {
  return projectionHash(value, options).slice(0, 16);
}

export function irreversibleSecurityDigest(value, options = {}) {
  return `hmac-sha256:${projectionHash(value, options)}`;
}

function normalizeRetentionDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.max(1, Math.min(3660, Math.trunc(parsed)));
}

function normalizeByteLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1024 * 1024, Math.trunc(parsed));
}

function normalizeRecordByteLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_RECORD_BYTES;
  }
  return Math.max(4 * 1024, Math.min(4 * 1024 * 1024, Math.trunc(parsed)));
}

function normalizeLogLevel(value, fallback = "debug") {
  const level = String(value || fallback).trim().toLowerCase();
  return LEVEL_RANK[level] ? level : fallback;
}

function resolveLogDirectory({ runtimeOptions = {}, userDataPath = "" } = {}) {
  const explicit = String(
    runtimeOptions.logDir ||
      process.env.LICO_LOG_DIR ||
      ""
  ).trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const dataRoot = String(userDataPath || "").trim();
  if (dataRoot) {
    return path.join(path.resolve(dataRoot), "logs", "runtime");
  }
  return path.join(path.resolve(ServerConfig.getDataDir()), "logs", "runtime");
}

function sanitizeString(value, maxPreview = 180) {
  const text = String(value ?? "").replace(/[\r\n\t]/g, " ");
  if (text.length <= maxPreview) {
    return text;
  }
  return `${text.slice(0, maxPreview)}...`;
}

function looksLikeAbsolutePath(value) {
  const text = String(value || "");
  return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text);
}

function shouldRedactAbsolutePath(value, key = "") {
  if (HTTP_ROUTE_KEY_PATTERN.test(key)) {
    return false;
  }
  const text = String(value || "");
  return looksLikeAbsolutePath(text) || ABSOLUTE_PATH_VALUE_PATTERN.test(text);
}

function summarizeString(value, key = "", options = {}) {
  const text = String(value ?? "");
  const metadata = (type = "string", reason = "metadata-only") => ({
    type,
    length: text.length,
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: shortHash(text, { ...options, namespace: `runtime-log:${key || type}` }),
    hashAlgorithm: "hmac-sha256",
    metadataOnly: true,
    reason
  });
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return {
      redacted: true,
      reason: "sensitive-key",
      length: text.length,
      byteLength: Buffer.byteLength(text, "utf8"),
      sha256: shortHash(text, { ...options, namespace: `runtime-log:sensitive:${key}` }),
      hashAlgorithm: "hmac-sha256",
      metadataOnly: true
    };
  }
  if (IDENTITY_KEY_PATTERN.test(key)) {
    return {
      ...metadata("identity", "identity"),
      redacted: true
    };
  }
  if (ERROR_TEXT_KEY_PATTERN.test(key)) {
    return metadata(key === "stack" ? "stack" : "error", "error-text");
  }
  if (METADATA_ONLY_KEY_PATTERN.test(key)) {
    return metadata("string", "metadata-only-key");
  }
  if (shouldRedactAbsolutePath(text, key)) {
    return metadata("path", "absolute-path");
  }
  if (DIGEST_KEY_PATTERN.test(key) && DIGEST_VALUE_PATTERN.test(text)) {
    return text;
  }
  if (
    options.preserveCategories !== false &&
    SAFE_CATEGORY_KEY_PATTERN.test(key) &&
    SAFE_CATEGORY_VALUE_PATTERN.test(text)
  ) {
    return text;
  }
  return metadata();
}

function summarizeMetadataOnlyValue(value, options = {}, key = "metadata") {
  if (value === null || value === undefined) {
    return {
      type: "empty",
      metadataOnly: true
    };
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      byteLength: value.length,
      sha256: shortHash(value, { ...options, namespace: `runtime-log:${key}` }),
      hashAlgorithm: "hmac-sha256",
      metadataOnly: true
    };
  }
  if (typeof value === "string") {
    return summarizeString(value, key, options);
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sha256: shortHash(value, { ...options, namespace: `runtime-log:${key}` }),
      hashAlgorithm: "hmac-sha256",
      metadataOnly: true
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keyCount: Object.keys(value).length,
      sha256: shortHash(value, { ...options, namespace: `runtime-log:${key}` }),
      hashAlgorithm: "hmac-sha256",
      metadataOnly: true
    };
  }
  return {
    type: typeof value,
    sha256: shortHash(value, { ...options, namespace: `runtime-log:${key}` }),
    hashAlgorithm: "hmac-sha256",
    metadataOnly: true
  };
}

export function summarizeForLog(value, options = {}, depth = 0, key = "") {
  const maxDepth = Number(options.maxDepth || MAX_DEPTH);
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    return summarizeString(value, key, options);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      byteLength: value.length,
      sha256: shortHash(value, { ...options, namespace: `runtime-log:${key || "buffer"}` }),
      hashAlgorithm: "hmac-sha256"
    };
  }
  if (value instanceof Error) {
    return summarizeError(value, options);
  }
  if (depth >= maxDepth) {
    return {
      type: Array.isArray(value) ? "array" : "object",
      truncated: true
    };
  }
  if (Array.isArray(value)) {
    const maxItems = Number(options.maxArrayItems || MAX_ARRAY_ITEMS);
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, maxItems).map((item, index) =>
        summarizeForLog(item, options, depth + 1, `${key}[${index}]`)
      ),
      truncated: value.length > maxItems
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const maxKeys = Number(options.maxObjectKeys || MAX_OBJECT_KEYS);
    const output = {};
    for (const [entryKey, entryValue] of entries.slice(0, maxKeys)) {
      if (SENSITIVE_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = summarizeMetadataOnlyValue(entryValue, options, `sensitive:${entryKey}`);
        output[entryKey].redacted = true;
        output[entryKey].reason = "sensitive-key";
        continue;
      }
      if (IDENTITY_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = summarizeMetadataOnlyValue(entryValue, options, `identity:${entryKey}`);
        output[entryKey].redacted = true;
        output[entryKey].reason = "identity";
        continue;
      }
      if (METADATA_ONLY_KEY_PATTERN.test(entryKey)) {
        output[entryKey] = summarizeMetadataOnlyValue(entryValue, options, entryKey);
        continue;
      }
      output[entryKey] = summarizeForLog(entryValue, options, depth + 1, entryKey);
    }
    if (entries.length > maxKeys) {
      output.__truncatedKeys = entries.length - maxKeys;
    }
    return output;
  }
  return {
    type: typeof value
  };
}

export function summarizeSecurityValue(value, options = {}) {
  const { key = "", ...projectionOptions } = options;
  if (
    SENSITIVE_KEY_PATTERN.test(key) ||
    IDENTITY_KEY_PATTERN.test(key) ||
    METADATA_ONLY_KEY_PATTERN.test(key)
  ) {
    const summary = summarizeMetadataOnlyValue(value, projectionOptions, key || "security-value");
    if (SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key)) {
      summary.redacted = true;
      summary.reason = SENSITIVE_KEY_PATTERN.test(key) ? "sensitive-key" : "identity";
    }
    return summary;
  }
  return summarizeForLog(
    value,
    { ...projectionOptions, preserveCategories: options.preserveCategories !== false },
    0,
    key
  );
}

function safeDiagnosticCode(value, fallback = "") {
  const text = String(value || "").trim();
  return SAFE_CATEGORY_VALUE_PATTERN.test(text) ? text : fallback;
}

export function summarizeError(error, options = {}) {
  const message = error instanceof Error ? error.message : String(error || "");
  const stack = error instanceof Error ? String(error.stack || "") : "";
  const code = safeDiagnosticCode(error?.code);
  const reasonCode = safeDiagnosticCode(error?.reasonCode, code || "runtime_error");
  return {
    name: safeDiagnosticCode(error?.name, "Error"),
    code,
    reasonCode,
    status: Number.isFinite(Number(error?.status || error?.statusCode))
      ? Number(error?.status || error?.statusCode)
      : 0,
    message: summarizeString(message, "message", options),
    stack: stack
      ? {
          ...summarizeString(stack, "stack", options),
          lineCount: stack.split(/\r?\n/).length
        }
      : {
          type: "stack",
          length: 0,
          byteLength: 0,
          lineCount: 0,
          metadataOnly: true,
          reason: "error-text"
        }
  };
}

function actorSummary(actor = {}) {
  const user = actor?.user || actor;
  return {
    type: safeDiagnosticCode(actor?.type || (user?.userId ? "console-user" : "system"), "unknown"),
    userId: user?.userId
      ? irreversibleSecurityDigest(user.userId, { namespace: "runtime-log:actor:user-id" })
      : "",
    username: user?.username
      ? irreversibleSecurityDigest(user.username, { namespace: "runtime-log:actor:username" })
      : "",
    roleId: safeDiagnosticCode(user?.roleId)
  };
}

function normalizeEventRecord({ component, level, event, details }) {
  const activeTrace = getTraceContext();
  const mergedDetails = {
    ...(activeTrace ? traceDetails(activeTrace) : {}),
    ...(details || {})
  };
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    ts: nowIso(),
    level,
    component,
    event: sanitizeString(event, 160),
    [OTEL_SEMANTIC_FIELDS.serviceName]: "licomesh-server",
    [OTEL_SEMANTIC_FIELDS.serviceVersion]: process.env.npm_package_version || "0.0.1",
    [OTEL_SEMANTIC_FIELDS.processPid]: process.pid,
    [OTEL_SEMANTIC_FIELDS.processCommand]: irreversibleSecurityDigest(process.argv, {
      namespace: "runtime-log:process-command"
    }),
    "process.command.arg_count": process.argv.length,
    [OTEL_SEMANTIC_FIELDS.ciWorkflowName]: process.env.GITHUB_WORKFLOW || process.env.CI_WORKFLOW_NAME
      ? irreversibleSecurityDigest(process.env.GITHUB_WORKFLOW || process.env.CI_WORKFLOW_NAME, {
          namespace: "runtime-log:ci-workflow"
        })
      : "",
    [OTEL_SEMANTIC_FIELDS.ciJobName]: process.env.GITHUB_JOB || process.env.CI_JOB_NAME
      ? irreversibleSecurityDigest(process.env.GITHUB_JOB || process.env.CI_JOB_NAME, {
          namespace: "runtime-log:ci-job"
        })
      : "",
    [OTEL_SEMANTIC_FIELDS.genAiOperationName]: (
      mergedDetails[OTEL_SEMANTIC_FIELDS.genAiOperationName] ||
      mergedDetails.genAiOperationName ||
      mergedDetails.genAiOperation
    )
      ? irreversibleSecurityDigest(
          mergedDetails[OTEL_SEMANTIC_FIELDS.genAiOperationName] ||
            mergedDetails.genAiOperationName ||
            mergedDetails.genAiOperation,
          { namespace: "runtime-log:gen-ai-operation" }
        )
      : "",
    pid: process.pid,
    traceId: mergedDetails.traceId || "",
    requestId: mergedDetails.requestId || "",
    spanId: mergedDetails.spanId || "",
    parentSpanId: mergedDetails.parentSpanId || "",
    details: summarizeForLog(mergedDetails, { projectionKey: PROCESS_PROJECTION_KEY })
  };
}

export function createRuntimeLogger({
  userDataPath = "",
  runtimeOptions = {},
  component = "server",
  retentionDays = process.env.LICO_LOG_RETENTION_DAYS,
  maxTotalBytes = runtimeOptions.logMaxTotalBytes || process.env.LICO_LOG_MAX_TOTAL_BYTES,
  maxFileBytes = runtimeOptions.logMaxFileBytes || process.env.LICO_LOG_MAX_FILE_BYTES,
  maxPendingRecords = runtimeOptions.logMaxPendingRecords || process.env.LICO_LOG_MAX_PENDING_RECORDS,
  maxRecordBytes = runtimeOptions.logMaxRecordBytes || process.env.LICO_LOG_MAX_RECORD_BYTES,
  level = runtimeOptions.logLevel || process.env.LICO_LOG_LEVEL
} = {}) {
  const logDir = resolveLogDirectory({ runtimeOptions, userDataPath });
  const safeRetentionDays = normalizeRetentionDays(retentionDays);
  const safeMaxTotalBytes = normalizeByteLimit(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const safeMaxFileBytes = normalizeByteLimit(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const safeMaxPendingRecords = Math.max(
    32,
    Math.min(65_536, Number(maxPendingRecords) || DEFAULT_MAX_PENDING_RECORDS)
  );
  const safeMaxRecordBytes = normalizeRecordByteLimit(maxRecordBytes);
  const defaultLevel = "info";
  let currentLevel = normalizeLogLevel(level, defaultLevel);
  const traceDebugFilters = new Set();
  const operationDebugFilters = new Set();
  const topicDebugFilters = new Set();
  const jobDebugFilters = new Set();
  let appendQueue = Promise.resolve();
  let lastCleanupAt = 0;
  let bytesSinceCleanup = 0;
  let pendingRecords = 0;
  let droppedRecords = 0;
  let closed = false;

  function logPathFor(date = new Date(), index = 0) {
    const suffix = index > 0 ? `.${index}` : "";
    return path.join(logDir, `licomesh-${component}-${datePart(date)}${suffix}.jsonl`);
  }

  async function currentLogPath() {
    await fs.mkdir(logDir, { recursive: true });
    let index = 0;
    while (index < 10_000) {
      const candidate = logPathFor(new Date(), index);
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat || stat.size < safeMaxFileBytes) {
        return candidate;
      }
      index += 1;
    }
    return logPathFor(new Date(), index);
  }

  async function cleanupOldLogs({ force = false } = {}) {
    const now = Date.now();
    if (
      !force &&
      now - lastCleanupAt < CLEANUP_INTERVAL_MS &&
      bytesSinceCleanup < CLEANUP_BYTE_INTERVAL
    ) {
      return;
    }
    lastCleanupAt = now;
    bytesSinceCleanup = 0;
    const cutoff = now - safeRetentionDays * 24 * 60 * 60 * 1000;
    await fs.mkdir(logDir, { recursive: true });
    const entries = await fs.readdir(logDir, { withFileTypes: true }).catch(() => []);
    const logFiles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^licomesh-.+\.jsonl$/.test(entry.name)) {
        continue;
      }
      const filePath = path.join(logDir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) {
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        await fs.rm(filePath, { force: true }).catch(() => null);
        continue;
      }
      logFiles.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    let totalBytes = logFiles.reduce((sum, item) => sum + item.size, 0);
    for (const file of logFiles.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (totalBytes <= safeMaxTotalBytes) {
        break;
      }
      await fs.rm(file.filePath, { force: true }).catch(() => null);
      totalBytes -= file.size;
    }
  }

  function shouldLog(levelName, details = {}) {
    const normalized = normalizeLogLevel(levelName, "info");
    if (LEVEL_RANK[normalized] >= LEVEL_RANK[currentLevel]) {
      return true;
    }
    const trace = getTraceContext();
    const traceId = String(details.traceId || trace?.traceId || "");
    const operationId = String(details.operationId || trace?.operationId || "");
    const topic = String(details.topic || "");
    const jobId = String(details.jobId || "");
    return (
      (traceId && traceDebugFilters.has(traceId)) ||
      (operationId && operationDebugFilters.has(operationId)) ||
      (topic && topicDebugFilters.has(topic)) ||
      (jobId && jobDebugFilters.has(jobId))
    );
  }

  function enqueue(record) {
    if (closed || pendingRecords >= safeMaxPendingRecords) {
      droppedRecords += 1;
      return false;
    }
    const completeRecord = {
      ...record,
      ...(droppedRecords > 0 ? { droppedRecordsBefore: droppedRecords } : {})
    };
    const serialized = JSON.stringify(completeRecord);
    const serializedBytes = Buffer.byteLength(serialized);
    const persistedRecord = serializedBytes <= safeMaxRecordBytes
      ? completeRecord
      : {
          timestamp: record.timestamp,
          level: record.level,
          component: record.component,
          event: record.event,
          traceId: record.traceId || "",
          requestId: record.requestId || "",
          spanId: record.spanId || "",
          parentSpanId: record.parentSpanId || "",
          ...(completeRecord.droppedRecordsBefore
            ? { droppedRecordsBefore: completeRecord.droppedRecordsBefore }
            : {}),
          recordTruncated: true,
          details: {
            metadataOnly: true,
            reason: "record-size-limit",
            originalBytes: serializedBytes,
            sha256: shortHash(serialized, { namespace: "runtime-log:oversized-record" }),
            hashAlgorithm: "hmac-sha256"
          }
        };
    const line = `${JSON.stringify(persistedRecord)}\n`;
    droppedRecords = 0;
    pendingRecords += 1;
    appendQueue = appendQueue.catch(() => null).then(async () => {
      await cleanupOldLogs();
      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(await currentLogPath(), line, "utf8");
      bytesSinceCleanup += Buffer.byteLength(line);
    }).finally(() => {
      pendingRecords -= 1;
    });
    return true;
  }

  function log(level, event, details = {}) {
    if (!shouldLog(level, details)) {
      return null;
    }
    const record = normalizeEventRecord({ component, level, event, details });
    return enqueue(record) ? record : null;
  }

  return {
    component,
    logDir,
    retentionDays: safeRetentionDays,
    maxTotalBytes: safeMaxTotalBytes,
    maxFileBytes: safeMaxFileBytes,
    maxPendingRecords: safeMaxPendingRecords,
    maxRecordBytes: safeMaxRecordBytes,
    actorSummary,
    get level() {
      return currentLevel;
    },
    setLevel(nextLevel) {
      currentLevel = normalizeLogLevel(nextLevel, currentLevel);
      return currentLevel;
    },
    enableDebugFilter(kind, value) {
      const text = String(value || "").trim();
      if (!text) {
        return;
      }
      if (kind === "operationId") {
        operationDebugFilters.add(text);
      } else if (kind === "topic") {
        topicDebugFilters.add(text);
      } else if (kind === "jobId") {
        jobDebugFilters.add(text);
      } else {
        traceDebugFilters.add(text);
      }
    },
    child(childDetails = {}) {
      return {
        component,
        logDir,
        retentionDays: safeRetentionDays,
        debug: (event, details = {}) => log("debug", event, { ...childDetails, ...details }),
        info: (event, details = {}) => log("info", event, { ...childDetails, ...details }),
        warn: (event, details = {}) => log("warn", event, { ...childDetails, ...details }),
        error: (event, details = {}) => log("error", event, { ...childDetails, ...details })
      };
    },
    debug: (event, details = {}) => log("debug", event, details),
    info: (event, details = {}) => log("info", event, details),
    warn: (event, details = {}) => log("warn", event, details),
    error: (event, details = {}) => log("error", event, details),
    async cleanup({ force = false } = {}) {
      await cleanupOldLogs({ force });
    },
    async flush() {
      await appendQueue.catch(() => null);
    },
    async close() {
      closed = true;
      await appendQueue.catch(() => null);
    }
  };
}

export function setRuntimeLogger(logger) {
  defaultLogger = logger || null;
}

export function getRuntimeLogger() {
  return defaultLogger;
}

export function logRuntimeEvent(level, event, details = {}) {
  const logger = getRuntimeLogger();
  if (!logger || typeof logger[level] !== "function") {
    return null;
  }
  return logger[level](event, details);
}
