import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "../storage/sqlite-database.mjs";
import { ensurePrivateDir } from "../storage/private-file-atomic.mjs";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../storage/private-sqlite.mjs";
import { runMigrations } from "../storage/sqlite-migrations.mjs";
import { finalizeSensitiveReport } from "../observability/sensitive-report-scan.mjs";

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf|prompt|runtime[-_]?id|grant[-_]?id|pending[-_]?operation[-_]?id|relay[-_]?session[-_]?id|relay[-_]?turn[-_]?id|relay[-_]?mcp[-_]?id|source[-_]?path|local[-_]?path|dir[-_]?path|source[-_]?root|local[-_]?root|config[-_]?path|content[-_]?base64|file[-_]?content|raw[-_]?content|^content$/i;
const OPAQUE_BINDING_KEY_PATTERN =
  /^(secretBindingId|secretBindingIds|allowedSecretBindings|credentialBindingIds)$/i;
const SENSITIVE_VALUE_PATTERN =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
// M-8: extended pattern — covers any Unix absolute path (not just well-known roots)
// and Windows UNC/drive paths.  Extra roots (data, srv, app, …) are now included.
const ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\[^\s"'<>]+|\\\\[^\s"'<>]+|\/[a-zA-Z][a-zA-Z0-9._-]*(?:\/[^\s"',<>]+)+)/g;
const MAX_JSON_BYTES = 12 * 1024;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_EXPORT_ITEMS = 1000;
const DEFAULT_MAX_RECORDS = 250_000;
const DEFAULT_MAX_LOGICAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const DEFAULT_CLEANUP_BATCH_SIZE = 512;
const DEFAULT_MAINTENANCE_EVERY_APPENDS = 128;
const MAX_RECORDS = 2_000_000;
const MAX_LOGICAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DATABASE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CLEANUP_BATCH_SIZE = 4096;
const MAX_MAINTENANCE_EVERY_APPENDS = 4096;
const MIN_DATABASE_BYTES = 4 * 1024 * 1024;
const WAL_JOURNAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const AUDIT_RECORD_FIXED_BYTES = 128;

export class OperationAuditCapacityError extends Error {
  constructor(reason, limit, actual) {
    super(`Operation audit capacity is exhausted (${reason}).`);
    this.name = "OperationAuditCapacityError";
    this.code = "operation_audit_capacity_exhausted";
    this.reason = reason;
    this.limit = limit;
    this.actual = actual;
  }
}

function nowIso() {
  return new Date().toISOString();
}


function hashValue(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function truncateJson(value) {
  const text = JSON.stringify(value ?? {});
  if (Buffer.byteLength(text, "utf8") <= MAX_JSON_BYTES) {
    return value;
  }
  return {
    redacted: true,
    reason: "payload_too_large",
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: crypto.createHash("sha256").update(text).digest("hex")
  };
}

function asLimit(value, fallback = 100, max = 500) {
  return Math.max(1, Math.min(Number(value || fallback) || fallback, max));
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(number, max));
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function redactOperationAuditValue(value, depth = 0) {
  if (depth > 8) {
    return "<redacted-depth>";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .replace(SENSITIVE_VALUE_PATTERN, (match) => {
        const prefix = match.match(/^\s*(api[-_]?key|token|secret|password)\s*[:=]/i)?.[0] || "";
        return prefix ? `${prefix}<redacted>` : "<redacted-secret>";
      })
      .replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return {
      redacted: true,
      reason: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex")
    };
  }
  if (Array.isArray(value)) {
    return truncateJson(value.map((item) => redactOperationAuditValue(item, depth + 1)));
  }
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) && !OPAQUE_BINDING_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactOperationAuditValue(nested, depth + 1);
  }
  return truncateJson(output);
}

function summarizeOutput(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (Buffer.isBuffer(value)) {
    return { type: "buffer", byteLength: value.length };
  }
  if (typeof value !== "object") {
    return { value: redactOperationAuditValue(value) };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  const summary = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      summary[key] = "<redacted>";
    } else if (Array.isArray(nested)) {
      summary[key] = { type: "array", length: nested.length };
    } else if (nested && typeof nested === "object") {
      if (["checkpoint", "stateCommit", "summary", "file", "workspaceFileRestore"].includes(key)) {
        summary[key] = redactOperationAuditValue(nested);
      } else {
        summary[key] = { type: "object", keys: Object.keys(nested).slice(0, 20) };
      }
    } else {
      summary[key] = redactOperationAuditValue(nested);
    }
  }
  return truncateJson(summary);
}

function actorFrom(value = {}) {
  const user = value.user || value;
  return {
    type: value.type || (user?.userId ? "console-user" : "anonymous"),
    userId: user?.userId || "",
    username: user?.username || "",
    roleId: user?.roleId || "",
    tenantId: user?.tenantId || value.tenantId || "",
    orgId: user?.orgId || value.orgId || "",
    teamIds: Array.isArray(user?.teamIds || value.teamIds) ? [...(user?.teamIds || value.teamIds)] : [],
    departmentIds: Array.isArray(user?.departmentIds || value.departmentIds) ? [...(user?.departmentIds || value.departmentIds)] : []
  };
}

function ensureOperationAuditColumns(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(operation_audit_log)").all().map((row) => row.name));
  if (!cols.has("trace_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("request_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN request_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("tenant_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("risk_control_anchor_digest")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN risk_control_anchor_digest TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("risk_control_last_record_digest")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN risk_control_last_record_digest TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("risk_control_gate_count")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN risk_control_gate_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.has("risk_control_envelope_json")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN risk_control_envelope_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!cols.has("record_bytes")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN record_bytes INTEGER NOT NULL DEFAULT 0");
  }
}

function ensureOperationAuditRetentionSchema(db) {
  db.exec(`
    UPDATE operation_audit_log
    SET record_bytes =
      ${AUDIT_RECORD_FIXED_BYTES} +
      length(CAST(audit_id AS BLOB)) +
      length(CAST(trace_id AS BLOB)) +
      length(CAST(request_id AS BLOB)) +
      length(CAST(tenant_id AS BLOB)) +
      length(CAST(operation_id AS BLOB)) +
      length(CAST(transport AS BLOB)) +
      length(CAST(actor_json AS BLOB)) +
      length(CAST(risk AS BLOB)) +
      length(CAST(status AS BLOB)) +
      length(CAST(input_hash AS BLOB)) +
      length(CAST(redacted_input_json AS BLOB)) +
      length(CAST(redacted_output_summary_json AS BLOB)) +
      length(CAST(error AS BLOB)) +
      length(CAST(risk_control_anchor_digest AS BLOB)) +
      length(CAST(risk_control_last_record_digest AS BLOB)) +
      length(CAST(risk_control_envelope_json AS BLOB)) +
      length(CAST(created_at AS BLOB))
    WHERE record_bytes = 0;

    CREATE TABLE IF NOT EXISTS operation_audit_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
      append_count INTEGER NOT NULL CHECK (append_count >= 0),
      last_maintenance_at TEXT NOT NULL DEFAULT ''
    );

    INSERT OR IGNORE INTO operation_audit_meta (
      singleton, row_count, logical_bytes, append_count, last_maintenance_at
    )
    SELECT 1, COUNT(*), COALESCE(SUM(record_bytes), 0), COUNT(*), ''
    FROM operation_audit_log;

    DROP TRIGGER IF EXISTS operation_audit_meta_after_insert;
    DROP TRIGGER IF EXISTS operation_audit_meta_after_delete;

    CREATE TRIGGER operation_audit_meta_after_insert
    AFTER INSERT ON operation_audit_log
    BEGIN
      UPDATE operation_audit_meta
      SET row_count = row_count + 1,
          logical_bytes = logical_bytes + NEW.record_bytes,
          append_count = append_count + 1
      WHERE singleton = 1;
    END;

    CREATE TRIGGER operation_audit_meta_after_delete
    AFTER DELETE ON operation_audit_log
    BEGIN
      UPDATE operation_audit_meta
      SET row_count = row_count - 1,
          logical_bytes = logical_bytes - OLD.record_bytes
      WHERE singleton = 1;
    END;
  `);
}

function ensureSchema(db) {
  // Establish the first SQLite failure boundary before any driver-specific
  // metadata reads so constructor unwind always preserves the schema error.
  db.exec("PRAGMA busy_timeout = 5000;");
  if (Number(db.pragma("user_version", { simple: true }) || 0) === 0) {
    db.pragma("auto_vacuum = INCREMENTAL");
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES};

    CREATE TABLE IF NOT EXISTS operation_audit_log (
      audit_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      tenant_id TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      actor_json TEXT NOT NULL DEFAULT '{}',
      risk TEXT NOT NULL DEFAULT '',
      read_only INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_hash TEXT NOT NULL DEFAULT '',
      redacted_input_json TEXT NOT NULL DEFAULT '{}',
      redacted_output_summary_json TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      risk_control_anchor_digest TEXT NOT NULL DEFAULT '',
      risk_control_last_record_digest TEXT NOT NULL DEFAULT '',
      risk_control_gate_count INTEGER NOT NULL DEFAULT 0,
      risk_control_envelope_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      record_bytes INTEGER NOT NULL DEFAULT 0 CHECK (record_bytes >= 0)
    );
  `);

  // Version-controlled migrations.
  runMigrations(db, [
    {
      version: 1,
      up: (d) => {
        ensureOperationAuditColumns(d);
      }
    },
    {
      version: 2,
      up: (d) => {
        ensureOperationAuditColumns(d);
        ensureOperationAuditRetentionSchema(d);
      }
    }
  ]);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operation_audit_created ON operation_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_retention ON operation_audit_log(created_at, audit_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_trace ON operation_audit_log(trace_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_tenant ON operation_audit_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_operation ON operation_audit_log(operation_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_status ON operation_audit_log(status);
  `);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function riskControlAuditSnapshot(value = null) {
  const envelope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const records = Array.isArray(envelope.gateRecords) ? envelope.gateRecords : [];
  const compactEnvelope = {
    envelopeVersion: String(envelope.envelopeVersion || ""),
    operationId: String(envelope.operationId || ""),
    traceId: String(envelope.traceId || ""),
    inputHash: String(envelope.inputHash || ""),
    operationAnchorDigest: String(envelope.operationAnchorDigest || ""),
    gateRecords: records.map((record) => ({
      recordVersion: String(record.recordVersion || ""),
      controlRef: record.controlRef || {},
      gate: String(record.gate || ""),
      decision: String(record.decision || ""),
      reasonCode: String(record.reasonCode || ""),
      subject: record.subject || {},
      resource: record.resource || {},
      environment: record.environment || {},
      evidence: Array.isArray(record.evidence) ? record.evidence : [],
      occurredAt: String(record.occurredAt || ""),
      previousRecordDigest: String(record.previousRecordDigest || ""),
      recordDigest: String(record.recordDigest || "")
    }))
  };
  const redactedEnvelope = redactOperationAuditValue(compactEnvelope);
  return {
    anchorDigest: String(envelope.operationAnchorDigest || ""),
    lastRecordDigest: String(records.at(-1)?.recordDigest || ""),
    gateCount: records.length,
    envelope: truncateJson(redactedEnvelope)
  };
}

function openOperationAuditDatabase(rootPath) {
  const databasePath = ensurePrivateSqliteLocation(path.join(rootPath, "operation-audit.sqlite"));
  let db = null;
  try {
    return withPrivateFileCreationMask(() => {
      db = openSqliteDatabase(databasePath);
      ensureSchema(db);
      ensurePrivateSqliteLocation(databasePath);
      const insertStmt = db.prepare(`
      INSERT INTO operation_audit_log (
        audit_id, trace_id, request_id, tenant_id, operation_id, transport, actor_json, risk, read_only, status, duration_ms,
        input_hash, redacted_input_json, redacted_output_summary_json, error,
        risk_control_anchor_digest, risk_control_last_record_digest, risk_control_gate_count, risk_control_envelope_json,
        created_at, record_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return { db, insertStmt, databasePath };
    });
  } catch (error) {
    try {
      db?.close?.();
    } catch {
      // Preserve the audit-store initialization failure.
    }
    throw error;
  }
}

export function createOperationAuditStore({ userDataPath }) {
  const rootPath = path.join(userDataPath, "security");
  ensurePrivateDir(rootPath);
  const { db, insertStmt } = openOperationAuditDatabase(rootPath);
  const retentionPolicyPath = path.join(rootPath, "audit-retention.json");
  const deleteExpiredStmt = db.prepare(`
    DELETE FROM operation_audit_log
    WHERE audit_id IN (
      SELECT audit_id
      FROM operation_audit_log
      WHERE created_at < ?
      ORDER BY created_at ASC, audit_id ASC
      LIMIT ?
    )
  `);
  const readMetaStmt = db.prepare(`
    SELECT row_count AS rowCount,
           logical_bytes AS logicalBytes,
           append_count AS appendCount,
           last_maintenance_at AS lastMaintenanceAt
    FROM operation_audit_meta
    WHERE singleton = 1
  `);
  const markMaintenanceStmt = db.prepare(`
    UPDATE operation_audit_meta
    SET last_maintenance_at = ?
    WHERE singleton = 1
  `);

  function normalizeRetentionPolicy(input = {}) {
    return {
      policyVersion: "v0.0.1:platform:audit-retention-1",
      retentionDays: boundedInteger(input.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650),
      maxExportItems: boundedInteger(input.maxExportItems, DEFAULT_MAX_EXPORT_ITEMS, 1, 10000),
      maxRecords: boundedInteger(input.maxRecords, DEFAULT_MAX_RECORDS, 1, MAX_RECORDS),
      maxLogicalBytes: boundedInteger(
        input.maxLogicalBytes,
        DEFAULT_MAX_LOGICAL_BYTES,
        MAX_JSON_BYTES + AUDIT_RECORD_FIXED_BYTES,
        MAX_LOGICAL_BYTES
      ),
      maxDatabaseBytes: boundedInteger(
        input.maxDatabaseBytes,
        DEFAULT_MAX_DATABASE_BYTES,
        MIN_DATABASE_BYTES,
        MAX_DATABASE_BYTES
      ),
      cleanupBatchSize: boundedInteger(
        input.cleanupBatchSize,
        DEFAULT_CLEANUP_BATCH_SIZE,
        1,
        MAX_CLEANUP_BATCH_SIZE
      ),
      maintenanceEveryAppends: boundedInteger(
        input.maintenanceEveryAppends,
        DEFAULT_MAINTENANCE_EVERY_APPENDS,
        1,
        MAX_MAINTENANCE_EVERY_APPENDS
      ),
      updatedAt: String(input.updatedAt || ""),
      updatedBy: redactOperationAuditValue(input.updatedBy || {})
    };
  }

  function readRetentionPolicy() {
    try {
      return normalizeRetentionPolicy(JSON.parse(fs.readFileSync(retentionPolicyPath, "utf8")));
    } catch {
      return normalizeRetentionPolicy();
    }
  }

  let retentionPolicy = readRetentionPolicy();

  function configureDatabaseCapacity(policy) {
    const pageSize = Number(db.pragma("page_size", { simple: true }) || 4096);
    const maxPages = Math.max(1, Math.floor(policy.maxDatabaseBytes / pageSize));
    db.pragma(`max_page_count = ${maxPages}`);
  }

  configureDatabaseCapacity(retentionPolicy);

  function recordBytes(values) {
    return AUDIT_RECORD_FIXED_BYTES + values.reduce(
      (total, value) => total + Buffer.byteLength(String(value ?? ""), "utf8"),
      0
    );
  }

  function activeDatabaseBytes() {
    const pageSize = Number(db.pragma("page_size", { simple: true }) || 4096);
    const pageCount = Number(db.pragma("page_count", { simple: true }) || 0);
    const freePages = Number(db.pragma("freelist_count", { simple: true }) || 0);
    return Math.max(0, pageCount - freePages) * pageSize;
  }

  function maintainStorageAfterDelete(deletedCount) {
    if (deletedCount <= 0) {
      return;
    }
    db.pragma("wal_checkpoint(PASSIVE)");
    if (Number(db.pragma("auto_vacuum", { simple: true }) || 0) === 2) {
      db.pragma(`incremental_vacuum(${Math.min(deletedCount, retentionPolicy.cleanupBatchSize)})`);
    }
  }

  function pruneExpiredInTransaction(policy, cutoff) {
    const result = deleteExpiredStmt.run(cutoff, policy.cleanupBatchSize);
    markMaintenanceStmt.run(nowIso());
    return Number(result.changes || 0);
  }

  const appendTransaction = db.transaction((record, policy) => {
    let meta = readMetaStmt.get();
    const exceedsCount = meta.rowCount + 1 > policy.maxRecords;
    const exceedsLogicalBytes = meta.logicalBytes + record.recordBytes > policy.maxLogicalBytes;
    const maintenanceDue =
      meta.appendCount === 0 ||
      meta.appendCount % policy.maintenanceEveryAppends === 0 ||
      exceedsCount ||
      exceedsLogicalBytes;
    let deletedCount = 0;
    if (maintenanceDue) {
      const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      deletedCount = pruneExpiredInTransaction(policy, cutoff);
      meta = readMetaStmt.get();
    }
    if (meta.rowCount + 1 > policy.maxRecords) {
      return {
        deletedCount,
        capacity: {
          reason: "record_count",
          limit: policy.maxRecords,
          actual: meta.rowCount + 1
        }
      };
    }
    if (meta.logicalBytes + record.recordBytes > policy.maxLogicalBytes) {
      return {
        deletedCount,
        capacity: {
          reason: "logical_bytes",
          limit: policy.maxLogicalBytes,
          actual: meta.logicalBytes + record.recordBytes
        }
      };
    }
    insertStmt.run(...record.values, record.recordBytes);
    const databaseBytes = activeDatabaseBytes();
    if (databaseBytes > policy.maxDatabaseBytes) {
      throw new OperationAuditCapacityError("database_bytes", policy.maxDatabaseBytes, databaseBytes);
    }
    return { deletedCount, capacity: null };
  });

  function append(entry = {}) {
    const input = entry.input ?? {};
    const redactedInput = redactOperationAuditValue(input);
    const outputSummary = summarizeOutput(entry.output);
    const auditId = entry.auditId || `op_audit_${crypto.randomUUID()}`;
    const actor = actorFrom(entry.actor || {});
    const riskControl = riskControlAuditSnapshot(entry.riskControl || entry.riskControlEnvelope || null);
    const values = [
      auditId,
      String(entry.traceId || ""),
      String(entry.requestId || ""),
      firstString(entry.tenantId, entry.tenant?.tenantId, actor.tenantId, input.tenantId, input["tenant-id"]),
      String(entry.operationId || ""),
      String(entry.transport || "unknown"),
      JSON.stringify(actor),
      String(entry.risk || ""),
      entry.readOnly ? 1 : 0,
      String(entry.status || ""),
      Math.max(0, Number(entry.durationMs || 0)),
      hashValue(input),
      JSON.stringify(redactedInput),
      JSON.stringify(outputSummary),
      String(entry.error || "").replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>").slice(0, 2000),
      riskControl.anchorDigest,
      riskControl.lastRecordDigest,
      riskControl.gateCount,
      JSON.stringify(riskControl.envelope),
      entry.createdAt || nowIso()
    ];
    const bytes = recordBytes(values);
    if (bytes > retentionPolicy.maxLogicalBytes) {
      throw new OperationAuditCapacityError("record_bytes", retentionPolicy.maxLogicalBytes, bytes);
    }
    configureDatabaseCapacity(retentionPolicy);
    let outcome = null;
    try {
      outcome = appendTransaction({ values, recordBytes: bytes }, retentionPolicy);
    } catch (error) {
      if (error?.code === "SQLITE_FULL") {
        throw new OperationAuditCapacityError(
          "database_bytes",
          retentionPolicy.maxDatabaseBytes,
          activeDatabaseBytes()
        );
      }
      throw error;
    }
    maintainStorageAfterDelete(outcome.deletedCount);
    if (outcome.capacity) {
      throw new OperationAuditCapacityError(
        outcome.capacity.reason,
        outcome.capacity.limit,
        outcome.capacity.actual
      );
    }
    return { auditId, maintenance: { deletedCount: outcome.deletedCount } };
  }

  function list({
    limit = 100,
    operationId = "",
    status = "",
    userId = "",
    traceId = "",
    tenantId = "",
    createdFrom = "",
    createdTo = ""
  } = {}) {
    const clauses = [];
    const params = [];
    if (operationId) {
      clauses.push("operation_id = ?");
      params.push(String(operationId));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(String(status));
    }
    if (traceId) {
      clauses.push("trace_id = ?");
      params.push(String(traceId));
    }
    if (tenantId) {
      clauses.push("tenant_id = ?");
      params.push(String(tenantId));
    }
    if (createdFrom) {
      clauses.push("created_at >= ?");
      params.push(String(createdFrom));
    }
    if (createdTo) {
      clauses.push("created_at <= ?");
      params.push(String(createdTo));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT * FROM operation_audit_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit));
    return rows
      .map((row) => ({
        auditId: row.audit_id,
        traceId: row.trace_id || "",
        requestId: row.request_id || "",
        tenantId: row.tenant_id || "",
        operationId: row.operation_id,
        transport: row.transport,
        actor: parseJson(row.actor_json, {}),
        risk: row.risk,
        readOnly: Boolean(row.read_only),
        status: row.status,
        durationMs: row.duration_ms,
        inputHash: row.input_hash,
        redactedInput: parseJson(row.redacted_input_json, {}),
        redactedOutputSummary: parseJson(row.redacted_output_summary_json, {}),
        riskControl: {
          anchorDigest: row.risk_control_anchor_digest || "",
          lastRecordDigest: row.risk_control_last_record_digest || "",
          gateCount: Number(row.risk_control_gate_count || 0),
          envelope: parseJson(row.risk_control_envelope_json, {})
        },
        error: row.error,
        createdAt: row.created_at
      }))
      .filter((entry) => !userId || entry.actor?.userId === String(userId));
  }

  function getRetentionPolicy() {
    return {
      ...retentionPolicy,
      updatedBy: redactOperationAuditValue(retentionPolicy.updatedBy || {})
    };
  }

  function setRetentionPolicy(input = {}) {
    const definedInput = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")
    );
    const policy = normalizeRetentionPolicy({
      ...retentionPolicy,
      ...definedInput,
      updatedAt: nowIso(),
      updatedBy: redactOperationAuditValue(input.updatedBy || {})
    });
    fs.writeFileSync(retentionPolicyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    retentionPolicy = policy;
    configureDatabaseCapacity(retentionPolicy);
    return policy;
  }

  function pruneExpired(input = {}) {
    const policy = input.retentionDays ? setRetentionPolicy(input) : getRetentionPolicy();
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = db.transaction(() => {
      const deletedCount = pruneExpiredInTransaction(policy, cutoff);
      return { deletedCount };
    })();
    maintainStorageAfterDelete(result.deletedCount);
    return {
      policyVersion: policy.policyVersion,
      retentionDays: policy.retentionDays,
      cutoff,
      deletedCount: result.deletedCount,
      cleanupBatchSize: policy.cleanupBatchSize,
      hasMore: Boolean(db.prepare(`
        SELECT 1
        FROM operation_audit_log
        WHERE created_at < ?
        LIMIT 1
      `).get(cutoff))
    };
  }

  function exportRedacted(input = {}) {
    const policy = getRetentionPolicy();
    const items = list({
      ...input,
      limit: asLimit(input.limit, Math.min(policy.maxExportItems, DEFAULT_MAX_EXPORT_ITEMS), policy.maxExportItems)
    });
    const manifest = {
      protocolVersion: "v0.0.1:platform:audit-export-1",
      exportedAt: nowIso(),
      redactionPolicy: "operation-audit-redacted-v1",
      retentionDays: policy.retentionDays,
      itemCount: items.length,
      filters: redactOperationAuditValue({
        operationId: input.operationId || "",
        status: input.status || "",
        userId: input.userId || "",
        traceId: input.traceId || "",
        tenantId: input.tenantId || "",
        createdFrom: input.createdFrom || "",
        createdTo: input.createdTo || ""
      })
    };
    const redactedItems = items.map((item) => redactOperationAuditValue(item));
    return finalizeSensitiveReport({
      manifest,
      items: redactedItems,
      jsonl: [
        JSON.stringify({ type: "manifest", ...manifest }),
        ...redactedItems.map((item) => JSON.stringify({ type: "audit", item }))
      ].join("\n") + "\n"
    }, {
      provenance: {
        producer: "meshrix-core-operation-audit",
        commandId: "auth.audit.export",
        sourceRevision: manifest.protocolVersion
      }
    });
  }

  function getTrace(traceId, input = {}) {
    const normalizedTraceId = String(traceId || input.traceId || "").trim();
    if (!normalizedTraceId) {
      return {
        protocolVersion: "v0.0.1:platform:trace-drilldown-1",
        traceId: "",
        auditItems: [],
        spans: [],
        count: 0
      };
    }
    const auditItems = list({
      ...input,
      traceId: normalizedTraceId,
      limit: input.limit || 200
    }).reverse();
    return {
      protocolVersion: "v0.0.1:platform:trace-drilldown-1",
      traceId: normalizedTraceId,
      count: auditItems.length,
      auditItems,
      spans: auditItems.map((item) => ({
        auditId: item.auditId,
        operationId: item.operationId,
        transport: item.transport,
        status: item.status,
        risk: item.risk,
        actor: item.actor,
        durationMs: item.durationMs,
        createdAt: item.createdAt,
        inputHash: item.inputHash,
        riskControl: {
          anchorDigest: item.riskControl?.anchorDigest || "",
          lastRecordDigest: item.riskControl?.lastRecordDigest || "",
          gateCount: item.riskControl?.gateCount || 0
        }
      }))
    };
  }

  return {
    db,
    rootPath,
    append,
    list,
    getRetentionPolicy,
    setRetentionPolicy,
    pruneExpired,
    exportRedacted,
    getTrace,
    close() {
      db.close();
    }
  };
}

export default createOperationAuditStore;
