/**
 * Runtime JSONL Logger — Meshrix.js structured logging with OTel alignment.
 *
 * OTel Semantic Convention Fields (adoption baseline):
 *   service.name, service.version
 *   process.pid, process.command
 *   ci.workflow.name, ci.job.name
 *   gen_ai.operation.name
 *   meshrix.operation.id, meshrix.workspace.id, meshrix.capability.id, meshrix.receipt.id
 *
 * process.pid is already emitted in log entry metadata.
 * Other fields are adopted incrementally as dispatch paths are instrumented.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getTraceContext, traceDetails } from "./trace-context.ts";
import { ServerConfig } from "#meshrix/server-config";
import { OTEL_SEMANTIC_FIELDS } from "./otel-semantic-fields.ts";

// ── OTel Attribute Registry ─────────────────────────────────────────────────
// Literal field names used in runtime log record instrumentation.
const RUNTIME_LOG_OTEL_ATTRIBUTES: Readonly<Record<string, any>> = Object.freeze({
  "service.name": "meshrix-server",
  "service.version": "0.0.1",
  "ci.workflow.name": null,
  "ci.job.name": null,
  "gen_ai.operation.name": null,
  "meshrix.operation.id": null,
  "meshrix.workspace.id": null,
  "meshrix.capability.id": null,
  "meshrix.receipt.id": null,
});

const DEFAULT_RETENTION_DAYS: any = 14;
const DEFAULT_MAX_TOTAL_BYTES: any = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES: any = 32 * 1024 * 1024;
const DEFAULT_MAX_PENDING_RECORDS: any = 2048;
const DEFAULT_MAX_RECORD_BYTES: any = 64 * 1024;
const CLEANUP_INTERVAL_MS: any = 5 * 60 * 1000;
const CLEANUP_BYTE_INTERVAL: any = 8 * 1024 * 1024;
const MAX_ARRAY_ITEMS: any = 12;
const MAX_OBJECT_KEYS: any = 60;
const MAX_DEPTH: any = 5;
const PROCESS_PROJECTION_KEY: any = crypto.randomBytes(32);
const SENSITIVE_KEY_PATTERN: any =
  /(authorization|cookie|csrf|token|password|passwd|secret|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|private[-_]?key|session)/i;
const IDENTITY_KEY_PATTERN: any =
  /^(?:account[-_]?id|actor(?:[-_]?id)?|agent[-_]?id|client(?:[-_]?(?:fingerprint|id|name))?|device[-_]?id|endpoint[-_]?id|installation[-_]?id|machine[-_]?id|principal(?:[-_]?id)?|remote[-_]?(?:addr|address)|source[-_]?ip|subject(?:[-_]?(?:id|key))?|user(?:name|[-_]?(?:agent|id|name))?)$/i;
const METADATA_ONLY_KEY_PATTERN: any =
  /^(body|bodyJson|headers|params|payload|query|queryParams|rpcParams|searchParams)$/i;
const ERROR_TEXT_KEY_PATTERN: any = /^(error|errorMessage|message|stack)$/i;
const SAFE_CATEGORY_KEY_PATTERN: any =
  /^(code|completionStatus|edition|method|mode|operationId|profile|reasonCode|status|transport|type)$/i;
const DIGEST_KEY_PATTERN: any = /^(hash|sha256)$/i;
const SAFE_CATEGORY_VALUE_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,159}$/;
const DIGEST_VALUE_PATTERN: any = /^(?:hmac-sha256:)?[a-f0-9]{16,64}$/i;
const HTTP_ROUTE_KEY_PATTERN: any = /^(pathname|route)$/i;
const ABSOLUTE_PATH_VALUE_PATTERN: any =
  /(?:[A-Za-z]:\\[^\s"'<>]+|\\\\[^\s"'<>]+|\/[A-Za-z][A-Za-z0-9._-]*(?:\/[^\s"',<>]+)+)/;

let defaultLogger: any = null;

const LEVEL_RANK: Readonly<Record<string, any>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

function nowIso() : any {
  return new Date().toISOString();
}

function datePart(value: any = new Date()) : any {
  return value.toISOString().slice(0, 10);
}

function digestSource(value?: any) : any {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  try {
    return Buffer.from(JSON.stringify(value, (_key?: any, nested?: any) : any =>
      typeof nested === "bigint" ? String(nested) : nested
    ) ?? "", "utf8");
  } catch {
    return Buffer.from(Object.prototype.toString.call(value), "utf8");
  }
}

function projectionHash(value?: any, options: Record<string, any> = {}) : any {
  const projectionKey: any = options.projectionKey || PROCESS_PROJECTION_KEY;
  const namespace: any = String(options.namespace || "runtime-log");
  return crypto
    .createHmac("sha256", projectionKey)
    .update(namespace)
    .update("\u001f")
    .update(digestSource(value))
    .digest("hex");
}

function shortHash(value?: any, options: Record<string, any> = {}) : any {
  return projectionHash(value, options).slice(0, 16);
}

export function irreversibleSecurityDigest(value?: any, options: Record<string, any> = {}) : any {
  return `hmac-sha256:${projectionHash(value, options)}`;
}

function normalizeRetentionDays(value?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RETENTION_DAYS;
  }
  return Math.max(1, Math.min(3660, Math.trunc(parsed)));
}

function normalizeByteLimit(value?: any, fallback?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1024 * 1024, Math.trunc(parsed));
}

function normalizeRecordByteLimit(value?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_RECORD_BYTES;
  }
  return Math.max(4 * 1024, Math.min(4 * 1024 * 1024, Math.trunc(parsed)));
}

function normalizeLogLevel(value?: any, fallback: any = "debug") : any {
  const level: any = String(value || fallback).trim().toLowerCase();
  return LEVEL_RANK[level] ? level : fallback;
}

function resolveLogDirectory({ runtimeOptions = {}, userDataPath = "" }: Record<string, any> = {}) : any {
  const explicit: any = String(
    runtimeOptions.logDir ||
      process.env.MESHRIX_LOG_DIR ||
      ""
  ).trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const dataRoot: any = String(userDataPath || "").trim();
  if (dataRoot) {
    return path.join(path.resolve(dataRoot), "logs", "runtime");
  }
  return path.join(path.resolve(ServerConfig.getDataDir()), "logs", "runtime");
}

function sanitizeString(value?: any, maxPreview: any = 180) : any {
  const text: any = String(value ?? "").replace(/[\r\n\t]/g, " ");
  if (text.length <= maxPreview) {
    return text;
  }
  return `${text.slice(0, maxPreview)}...`;
}

function looksLikeAbsolutePath(value?: any) : any {
  const text: any = String(value || "");
  return path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text);
}

function shouldRedactAbsolutePath(value?: any, key: any = "") : any {
  if (HTTP_ROUTE_KEY_PATTERN.test(key)) {
    return false;
  }
  const text: any = String(value || "");
  return looksLikeAbsolutePath(text) || ABSOLUTE_PATH_VALUE_PATTERN.test(text);
}

function summarizeString(value?: any, key: any = "", options: Record<string, any> = {}) : any {
  const text: any = String(value ?? "");
  const metadata: any = (type: any = "string", reason: any = "metadata-only") : any => ({
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

function summarizeMetadataOnlyValue(value?: any, options: Record<string, any> = {}, key: any = "metadata") : any {
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

export function summarizeForLog(value?: any, options: Record<string, any> = {}, depth: any = 0, key: any = "") : any {
  const maxDepth: any = Number(options.maxDepth || MAX_DEPTH);
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
    const maxItems: any = Number(options.maxArrayItems || MAX_ARRAY_ITEMS);
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, maxItems).map((item?: any, index?: any) : any =>
        summarizeForLog(item, options, depth + 1, `${key}[${index}]`)
      ),
      truncated: value.length > maxItems
    };
  }
  if (typeof value === "object") {
    const entries: any = (Object.entries(value) as [string, any][]);
    const maxKeys: any = Number(options.maxObjectKeys || MAX_OBJECT_KEYS);
    const output: Record<string, any> = {};
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

export function summarizeSecurityValue(value?: any, options: Record<string, any> = {}) : any {
  const { key = "", ...projectionOptions } = options;
  if (
    SENSITIVE_KEY_PATTERN.test(key) ||
    IDENTITY_KEY_PATTERN.test(key) ||
    METADATA_ONLY_KEY_PATTERN.test(key)
  ) {
    const summary: any = summarizeMetadataOnlyValue(value, projectionOptions, key || "security-value");
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

function safeDiagnosticCode(value?: any, fallback: any = "") : any {
  const text: any = String(value || "").trim();
  return SAFE_CATEGORY_VALUE_PATTERN.test(text) ? text : fallback;
}

export function summarizeError(error?: any, options: Record<string, any> = {}) : any {
  const message: any = error instanceof Error ? error.message : String(error || "");
  const stack: any = error instanceof Error ? String(error.stack || "") : "";
  const code: any = safeDiagnosticCode(error?.code);
  const reasonCode: any = safeDiagnosticCode(error?.reasonCode, code || "runtime_error");
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

function actorSummary(actor: Record<string, any> = {}) : any {
  const user: any = actor?.user || actor;
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

function normalizeEventRecord({ component, level, event, details }: Record<string, any>) : any {
  const activeTrace: any = getTraceContext();
  const mergedDetails: Record<string, any> = {
    ...(activeTrace ? traceDetails(activeTrace) : {}),
    ...(details || {})
  };
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    ts: nowIso(),
    level,
    component,
    event: sanitizeString(event, 160),
    [OTEL_SEMANTIC_FIELDS.serviceName]: "meshrix-server",
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
  retentionDays = process.env.MESHRIX_LOG_RETENTION_DAYS,
  maxTotalBytes = runtimeOptions.logMaxTotalBytes || process.env.MESHRIX_LOG_MAX_TOTAL_BYTES,
  maxFileBytes = runtimeOptions.logMaxFileBytes || process.env.MESHRIX_LOG_MAX_FILE_BYTES,
  maxPendingRecords = runtimeOptions.logMaxPendingRecords || process.env.MESHRIX_LOG_MAX_PENDING_RECORDS,
  maxRecordBytes = runtimeOptions.logMaxRecordBytes || process.env.MESHRIX_LOG_MAX_RECORD_BYTES,
  level = runtimeOptions.logLevel || process.env.MESHRIX_LOG_LEVEL
}: Record<string, any> = {}) : any {
  const logDir: any = resolveLogDirectory({ runtimeOptions, userDataPath });
  const safeRetentionDays: any = normalizeRetentionDays(retentionDays);
  const safeMaxTotalBytes: any = normalizeByteLimit(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const safeMaxFileBytes: any = normalizeByteLimit(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const safeMaxPendingRecords: any = Math.max(
    32,
    Math.min(65_536, Number(maxPendingRecords) || DEFAULT_MAX_PENDING_RECORDS)
  );
  const safeMaxRecordBytes: any = normalizeRecordByteLimit(maxRecordBytes);
  const defaultLevel = "info";
  let currentLevel: any = normalizeLogLevel(level, defaultLevel);
  const traceDebugFilters: any = new Set<any>();
  const operationDebugFilters: any = new Set<any>();
  const topicDebugFilters: any = new Set<any>();
  const jobDebugFilters: any = new Set<any>();
  let appendQueue: any = Promise.resolve();
  let lastCleanupAt: any = 0;
  let bytesSinceCleanup: any = 0;
  let pendingRecords: any = 0;
  let droppedRecords: any = 0;
  let closed: any = false;

  function logPathFor(date: any = new Date(), index: any = 0) : any {
    const suffix: any = index > 0 ? `.${index}` : "";
    return path.join(logDir, `meshrix-${component}-${datePart(date)}${suffix}.jsonl`);
  }

  async function currentLogPath() : Promise<any> {
    await fs.mkdir(logDir, { recursive: true });
    let index: any = 0;
    while (index < 10_000) {
      const candidate: any = logPathFor(new Date(), index);
      const stat: any = await fs.stat(candidate).catch(() : any => null);
      if (!stat || stat.size < safeMaxFileBytes) {
        return candidate;
      }
      index += 1;
    }
    return logPathFor(new Date(), index);
  }

  async function cleanupOldLogs({ force = false }: Record<string, any> = {}) : Promise<any> {
    const now: any = Date.now();
    if (
      !force &&
      now - lastCleanupAt < CLEANUP_INTERVAL_MS &&
      bytesSinceCleanup < CLEANUP_BYTE_INTERVAL
    ) {
      return;
    }
    lastCleanupAt = now;
    bytesSinceCleanup = 0;
    const cutoff: any = now - safeRetentionDays * 24 * 60 * 60 * 1000;
    await fs.mkdir(logDir, { recursive: true });
    const entries: any = await fs.readdir(logDir, { withFileTypes: true }).catch(() : any => []);
    const logFiles: any[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^meshrix-.+\.jsonl$/.test(entry.name)) {
        continue;
      }
      const filePath: any = path.join(logDir, entry.name);
      const stat: any = await fs.stat(filePath).catch(() : any => null);
      if (!stat) {
        continue;
      }
      if (stat.mtimeMs < cutoff) {
        await fs.rm(filePath, { force: true }).catch(() : any => null);
        continue;
      }
      logFiles.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    let totalBytes: any = logFiles.reduce((sum?: any, item?: any) : any => sum + item.size, 0);
    for (const file of logFiles.sort((left?: any, right?: any) : any => left.mtimeMs - right.mtimeMs)) {
      if (totalBytes <= safeMaxTotalBytes) {
        break;
      }
      await fs.rm(file.filePath, { force: true }).catch(() : any => null);
      totalBytes -= file.size;
    }
  }

  function shouldLog(levelName?: any, details: Record<string, any> = {}) : any {
    const normalized: any = normalizeLogLevel(levelName, "info");
    if (LEVEL_RANK[normalized] >= LEVEL_RANK[currentLevel]) {
      return true;
    }
    const trace: any = getTraceContext();
    const traceId: any = String(details.traceId || trace?.traceId || "");
    const operationId: any = String(details.operationId || trace?.operationId || "");
    const topic: any = String(details.topic || "");
    const jobId: any = String(details.jobId || "");
    return (
      (traceId && traceDebugFilters.has(traceId)) ||
      (operationId && operationDebugFilters.has(operationId)) ||
      (topic && topicDebugFilters.has(topic)) ||
      (jobId && jobDebugFilters.has(jobId))
    );
  }

  function enqueue(record?: any) : any {
    if (closed || pendingRecords >= safeMaxPendingRecords) {
      droppedRecords += 1;
      return false;
    }
    const completeRecord: Record<string, any> = {
      ...record,
      ...(droppedRecords > 0 ? { droppedRecordsBefore: droppedRecords } : {})
    };
    const serialized: any = JSON.stringify(completeRecord);
    const serializedBytes: any = Buffer.byteLength(serialized);
    const persistedRecord: any = serializedBytes <= safeMaxRecordBytes
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
    const line: any = `${JSON.stringify(persistedRecord)}\n`;
    droppedRecords = 0;
    pendingRecords += 1;
    appendQueue = appendQueue.catch(() : any => null).then(async () : Promise<any> => {
      await cleanupOldLogs();
      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(await currentLogPath(), line, "utf8");
      bytesSinceCleanup += Buffer.byteLength(line);
    }).finally(() : any => {
      pendingRecords -= 1;
    });
    return true;
  }

  function log(level?: any, event?: any, details: Record<string, any> = {}) : any {
    if (!shouldLog(level, details)) {
      return null;
    }
    const record: any = normalizeEventRecord({ component, level, event, details });
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
    get level() : any {
      return currentLevel;
    },
    setLevel(nextLevel?: any) : any {
      currentLevel = normalizeLogLevel(nextLevel, currentLevel);
      return currentLevel;
    },
    enableDebugFilter(kind?: any, value?: any) : any {
      const text: any = String(value || "").trim();
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
    child(childDetails: Record<string, any> = {}) : any {
      return {
        component,
        logDir,
        retentionDays: safeRetentionDays,
        debug: (event?: any, details: Record<string, any> = {}) : any => log("debug", event, { ...childDetails, ...details }),
        info: (event?: any, details: Record<string, any> = {}) : any => log("info", event, { ...childDetails, ...details }),
        warn: (event?: any, details: Record<string, any> = {}) : any => log("warn", event, { ...childDetails, ...details }),
        error: (event?: any, details: Record<string, any> = {}) : any => log("error", event, { ...childDetails, ...details })
      };
    },
    debug: (event?: any, details: Record<string, any> = {}) : any => log("debug", event, details),
    info: (event?: any, details: Record<string, any> = {}) : any => log("info", event, details),
    warn: (event?: any, details: Record<string, any> = {}) : any => log("warn", event, details),
    error: (event?: any, details: Record<string, any> = {}) : any => log("error", event, details),
    async cleanup({ force = false }: Record<string, any> = {}) : Promise<any> {
      await cleanupOldLogs({ force });
    },
    async flush() : Promise<any> {
      await appendQueue.catch(() : any => null);
    },
    async close() : Promise<any> {
      closed = true;
      await appendQueue.catch(() : any => null);
    }
  };
}

export function setRuntimeLogger(logger?: any) : any {
  defaultLogger = logger || null;
}

export function getRuntimeLogger() : any {
  return defaultLogger;
}

export function logRuntimeEvent(level?: any, event?: any, details: Record<string, any> = {}) : any {
  const logger: any = getRuntimeLogger();
  if (!logger || typeof logger[level] !== "function") {
    return null;
  }
  return logger[level](event, details);
}
