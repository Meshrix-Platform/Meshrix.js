import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";
import { ensurePrivateDir } from "../storage/private-file-atomic.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../storage/private-sqlite.ts";
import { runMigrations } from "../storage/sqlite-migrations.ts";
import { finalizeSensitiveReport } from "../observability/sensitive-report-scan.ts";
import {
  MAX_JSON_BYTES,
  OperationAuditCapacityError,
  OperationAuditIdempotencyConflictError,
  OperationAuditIdRequiredError,
  redactOperationAuditValue
} from "./operation-audit-common.ts";
import {
  inspectOperationAuditProjectionDatabase,
  operationAuditProjectionKeyId,
  projectOperationAuditRetentionPolicy,
  projectLegacyOperationAuditRecord,
  type OperationAuditRecord
} from "./operation-audit-projection.ts";
type DataRecord = Record<string, unknown>;
type SqliteValue = string | number;

interface OperationAuditRow {
  audit_id: string;
  trace_id: string;
  request_id: string;
  tenant_id: string;
  decision_id: string;
  proof_id: string;
  operation_id: string;
  transport: string;
  actor_json: string;
  risk: string;
  read_only: number;
  status: string;
  duration_ms: number;
  input_hash: string;
  redacted_input_json: string;
  redacted_output_summary_json: string;
  error: string;
  risk_control_anchor_digest: string;
  risk_control_last_record_digest: string;
  risk_control_gate_count: number;
  risk_control_envelope_json: string;
  created_at: string;
  idempotency_binding_hmac: string;
}

interface RiskControlSnapshot {
  anchorDigest: string;
  lastRecordDigest: string;
  gateCount: number;
  envelope: unknown;
}

interface RetentionPolicy extends DataRecord {
  policyVersion: string;
  retentionDays: number;
  maxExportItems: number;
  maxRecords: number;
  maxLogicalBytes: number;
  maxDatabaseBytes: number;
  cleanupBatchSize: number;
  maintenanceEveryAppends: number;
  updatedAt: string;
  updatedBy: unknown;
}

interface AuditMetaRow {
  rowCount: number;
  logicalBytes: number;
  appendCount: number;
  lastMaintenanceAt: string;
}

interface CapacityFailure {
  reason: string;
  limit: number;
  actual: number;
}

interface AppendOutcome {
  deletedCount: number;
  capacity: CapacityFailure | null;
}

interface IdempotentAppendOutcome extends AppendOutcome {
  auditId: string;
  replayed: boolean;
}

interface PreparedAuditRecord {
  values: SqliteValue[];
  recordBytes: number;
}

interface OperationAuditItem extends DataRecord {
  auditId: string;
  traceId: string;
  requestId: string;
  tenantId: string;
  decisionId: string;
  proofId: string;
  operationId: string;
  transport: string;
  actor: DataRecord;
  risk: string;
  readOnly: boolean;
  status: string;
  durationMs: number;
  inputHash: string;
  redactedInput: unknown;
  redactedOutputSummary: unknown;
  riskControl: RiskControlSnapshot;
  error: string;
  createdAt: string;
}

export interface OperationAuditWorkerStore {
  db: Database.Database;
  rootPath: string;
  ready(): void;
  append(entry?: DataRecord): { auditId: string; maintenance: { deletedCount: number } };
  appendIdempotent(entry?: DataRecord): { auditId: string; replayed: boolean; maintenance: { deletedCount: number } };
  getById(auditId?: unknown): OperationAuditItem | null;
  list(input?: DataRecord): OperationAuditItem[];
  getRetentionPolicy(): RetentionPolicy;
  setRetentionPolicy(input?: DataRecord): RetentionPolicy;
  pruneExpired(input?: DataRecord): DataRecord;
  exportRedacted(input?: DataRecord): unknown;
  getTrace(traceId?: unknown, input?: DataRecord): DataRecord;
  close(): void;
}

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
const AUDIT_PROJECTION_META_TABLE = "operation_audit_projection_meta";
const AUDIT_PROJECTION_VERSION = "meshrix-operation-audit-projection-v1";
const AUDIT_PROJECTION_BATCH_SIZE = 256;

interface OperationAuditProjectionMeta {
  schema_version: string;
  projection_key_id: string;
  state: string;
  cursor_rowid: number;
}

type OperationAuditProjectionState =
  | "projecting"
  | "cleanup_checkpoint_before"
  | "cleanup_vacuum_pending"
  | "cleanup_checkpoint_after"
  | "cleanup_retention_policy_pending"
  | "ready";

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as DataRecord
    : {};
}

function sqliteErrorCode(error: unknown): string {
  return String(asRecord(error).code || "");
}

function asLimit(value?: unknown, fallback = 100, max = 500): number {
  return Math.max(1, Math.min(Number(value || fallback) || fallback, max));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(number, max));
}

function ensureOperationAuditColumns(db: Database.Database): void {
  const cols = new Set(db.prepare<[], { name: unknown }>("PRAGMA table_info(operation_audit_log)").all().map((row) => String(row.name || "")));
  if (!cols.has("trace_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("request_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN request_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("tenant_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("decision_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN decision_id TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has("proof_id")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN proof_id TEXT NOT NULL DEFAULT ''");
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
  if (!cols.has("idempotency_binding_hmac")) {
    db.exec("ALTER TABLE operation_audit_log ADD COLUMN idempotency_binding_hmac TEXT NOT NULL DEFAULT ''");
  }
}

function ensureOperationAuditRetentionSchema(db: Database.Database): void {
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

function ensureSchema(db: Database.Database): void {
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
      decision_id TEXT NOT NULL DEFAULT '',
      proof_id TEXT NOT NULL DEFAULT '',
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
      record_bytes INTEGER NOT NULL DEFAULT 0 CHECK (record_bytes >= 0),
      idempotency_binding_hmac TEXT NOT NULL DEFAULT ''
    );
  `);

  // Version-controlled migrations.
  runMigrations(db, [
    {
      version: 1,
      up: (d: Database.Database): void => {
        ensureOperationAuditColumns(d);
      }
    },
    {
      version: 2,
      up: (d: Database.Database): void => {
        ensureOperationAuditColumns(d);
        ensureOperationAuditRetentionSchema(d);
      }
    },
    {
      version: 3,
      up: (d: Database.Database): void => {
        ensureOperationAuditColumns(d);
      }
    },
    {
      version: 4,
      up: (d: Database.Database): void => {
        d.exec("DROP INDEX IF EXISTS idx_operation_audit_created");
      }
    },
    {
      version: 5,
      up: (d: Database.Database): void => {
        ensureOperationAuditColumns(d);
      }
    }
  ]);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operation_audit_retention ON operation_audit_log(created_at, audit_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_trace ON operation_audit_log(trace_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_tenant ON operation_audit_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_operation ON operation_audit_log(operation_id);
    CREATE INDEX IF NOT EXISTS idx_operation_audit_status ON operation_audit_log(status);
  `);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

const PROJECTED_RECORD_VERSION = "meshrix-operation-audit-projection-v1";
const PROJECTED_RECORD_KEYS: ReadonlySet<string> = new Set([
  "projectionVersion",
  "auditId",
  "traceId",
  "requestId",
  "tenantId",
  "decisionId",
  "proofId",
  "operationId",
  "transport",
  "actorJson",
  "risk",
  "readOnly",
  "status",
  "durationMs",
  "inputHash",
  "redactedInputJson",
  "redactedOutputSummaryJson",
  "error",
  "riskControlAnchorDigest",
  "riskControlLastRecordDigest",
  "riskControlGateCount",
  "riskControlEnvelopeJson",
  "createdAt",
  "idempotencyBindingHmac"
]);

function projectedOperationAuditRecord(entry: DataRecord = {}): OperationAuditRecord {
  if (
    entry.projectionVersion !== PROJECTED_RECORD_VERSION ||
    Object.keys(entry).some((key) => !PROJECTED_RECORD_KEYS.has(key)) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.traceId || "")) && Boolean(entry.traceId) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.requestId || "")) && Boolean(entry.requestId) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.tenantId || "")) && Boolean(entry.tenantId) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.decisionId || "")) && Boolean(entry.decisionId) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.proofId || "")) && Boolean(entry.proofId) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.inputHash || "")) ||
    !/^hmac-sha256:v1:[a-f0-9]{64}$/u.test(String(entry.idempotencyBindingHmac || ""))
  ) {
    throw Object.assign(new Error("Operation audit entry is not privacy-projected."), {
      code: "operation_audit_projection_required"
    });
  }
  return {
    auditId: String(entry.auditId || ""),
    traceId: String(entry.traceId || ""),
    requestId: String(entry.requestId || ""),
    tenantId: String(entry.tenantId || ""),
    decisionId: String(entry.decisionId || ""),
    proofId: String(entry.proofId || ""),
    operationId: String(entry.operationId || ""),
    transport: String(entry.transport || "unknown"),
    actorJson: String(entry.actorJson || "{}"),
    risk: String(entry.risk || ""),
    readOnly: entry.readOnly ? 1 : 0,
    status: String(entry.status || ""),
    durationMs: Math.max(0, Number(entry.durationMs || 0)),
    inputHash: String(entry.inputHash),
    redactedInputJson: String(entry.redactedInputJson || "{}"),
    redactedOutputSummaryJson: String(entry.redactedOutputSummaryJson || "{}"),
    error: String(entry.error || ""),
    riskControlAnchorDigest: String(entry.riskControlAnchorDigest || ""),
    riskControlLastRecordDigest: String(entry.riskControlLastRecordDigest || ""),
    riskControlGateCount: Math.max(0, Number(entry.riskControlGateCount || 0)),
    riskControlEnvelopeJson: String(entry.riskControlEnvelopeJson || "{}"),
    createdAt: String(entry.createdAt || ""),
    idempotencyBindingHmac: String(entry.idempotencyBindingHmac)
  };
}

function operationAuditRecordValues(record: OperationAuditRecord): SqliteValue[] {
  return [
    record.auditId,
    record.traceId,
    record.requestId,
    record.tenantId,
    record.decisionId,
    record.proofId,
    record.operationId,
    record.transport,
    record.actorJson,
    record.risk,
    record.readOnly,
    record.status,
    record.durationMs,
    record.inputHash,
    record.redactedInputJson,
    record.redactedOutputSummaryJson,
    record.error,
    record.riskControlAnchorDigest,
    record.riskControlLastRecordDigest,
    record.riskControlGateCount,
    record.riskControlEnvelopeJson,
    record.createdAt,
    record.idempotencyBindingHmac
  ];
}

function operationAuditRecordBytes(record: OperationAuditRecord): number {
  return AUDIT_RECORD_FIXED_BYTES + operationAuditRecordValues(record).reduce<number>(
    (total, value) => total + Buffer.byteLength(String(value ?? ""), "utf8"),
    0
  );
}

function canonicalStoredJson(value: unknown): string | null {
  try {
    return stableJson(JSON.parse(String(value)));
  } catch {
    return null;
  }
}

function normalizedOperationAuditRow(row: OperationAuditRow | null | undefined): OperationAuditRecord | null {
  if (!row) {
    return null;
  }
  const actorJson = canonicalStoredJson(row.actor_json);
  const redactedInputJson = canonicalStoredJson(row.redacted_input_json);
  const redactedOutputSummaryJson = canonicalStoredJson(row.redacted_output_summary_json);
  const riskControlEnvelopeJson = canonicalStoredJson(row.risk_control_envelope_json);
  if (
    actorJson === null ||
    redactedInputJson === null ||
    redactedOutputSummaryJson === null ||
    riskControlEnvelopeJson === null
  ) {
    return null;
  }
  return {
    auditId: row.audit_id,
    traceId: row.trace_id,
    requestId: row.request_id,
    tenantId: row.tenant_id,
    decisionId: row.decision_id || "",
    proofId: row.proof_id || "",
    operationId: row.operation_id,
    transport: row.transport,
    actorJson,
    risk: row.risk,
    readOnly: Number(row.read_only),
    status: row.status,
    durationMs: Number(row.duration_ms),
    inputHash: row.input_hash,
    redactedInputJson,
    redactedOutputSummaryJson,
    error: row.error,
    riskControlAnchorDigest: row.risk_control_anchor_digest,
    riskControlLastRecordDigest: row.risk_control_last_record_digest,
    riskControlGateCount: Number(row.risk_control_gate_count),
    riskControlEnvelopeJson,
    createdAt: row.created_at,
    idempotencyBindingHmac: String(row.idempotency_binding_hmac || "")
  };
}

function projectOperationAuditRow(row: OperationAuditRow): OperationAuditItem {
  return {
    auditId: row.audit_id,
    traceId: row.trace_id || "",
    requestId: row.request_id || "",
    tenantId: row.tenant_id || "",
    decisionId: row.decision_id || "",
    proofId: row.proof_id || "",
    operationId: row.operation_id,
    transport: row.transport,
    actor: asRecord(parseJson<unknown>(row.actor_json, {})),
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
  };
}

function projectionMeta(db: Database.Database): OperationAuditProjectionMeta | null {
  const row = db.prepare<[], OperationAuditProjectionMeta>(`
    SELECT schema_version, projection_key_id, state, cursor_rowid
    FROM ${AUDIT_PROJECTION_META_TABLE}
    WHERE singleton = 1
  `).get();
  return row || null;
}

function updateProjectionState(
  db: Database.Database,
  state: OperationAuditProjectionState,
  cursorRowId: number
): void {
  db.prepare<[string, number]>(`
    UPDATE ${AUDIT_PROJECTION_META_TABLE}
    SET state = ?, cursor_rowid = ?
    WHERE singleton = 1
  `).run(state, cursorRowId);
}

function checkpointTruncate(db: Database.Database): void {
  const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<Record<string, unknown>>;
  const status = Array.isArray(result) ? asRecord(result[0]) : {};
  if (Number(status.busy || 0) !== 0) {
    throw Object.assign(new Error("Operation audit privacy cleanup could not truncate its WAL."), {
      code: "operation_audit_projection_cleanup_busy"
    });
  }
}

function projectRetentionPolicyFile(rootPath: string, key: Uint8Array, keyId: string): void {
  const policyPath = path.join(rootPath, "audit-retention.json");
  let source: DataRecord;
  try {
    source = asRecord(JSON.parse(fs.readFileSync(policyPath, "utf8")));
  } catch (error: unknown) {
    if (asRecord(error).code === "ENOENT") return;
    throw Object.assign(new Error("Operation audit retention policy could not be projected."), {
      code: "operation_audit_projection_retention_invalid"
    });
  }
  const existingVersion = String(source.operationAuditProjectionVersion || "");
  const existingKeyId = String(source.operationAuditProjectionKeyId || "");
  if (existingVersion === AUDIT_PROJECTION_VERSION) {
    if (existingKeyId !== keyId) {
      throw Object.assign(new Error("Operation audit retention policy key does not match stored records."), {
        code: "operation_audit_projection_key_mismatch"
      });
    }
    return;
  }
  if (existingVersion || existingKeyId) {
    throw Object.assign(new Error("Operation audit retention policy projection metadata is invalid."), {
      code: "operation_audit_projection_retention_invalid"
    });
  }
  const projected = projectOperationAuditRetentionPolicy(source, key);
  const serialized = `${JSON.stringify({
    ...projected,
    operationAuditProjectionVersion: AUDIT_PROJECTION_VERSION,
    operationAuditProjectionKeyId: keyId
  }, null, 2)}\n`;
  const tempPath = path.join(rootPath, `.audit-retention.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, policyPath);
    fs.chmodSync(policyPath, 0o600);
  } catch (error: unknown) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function finishProjectionRemanenceCleanup(
  db: Database.Database,
  rootPath: string,
  key: Uint8Array,
  keyId: string
): void {
  for (;;) {
    const meta = projectionMeta(db);
    if (!meta) {
      throw Object.assign(new Error("Operation audit projection metadata is missing."), {
        code: "operation_audit_projection_state_invalid"
      });
    }
    if (meta.state === "ready") return;
    if (meta.state === "cleanup_checkpoint_before") {
      checkpointTruncate(db);
      updateProjectionState(db, "cleanup_vacuum_pending", 0);
      continue;
    }
    if (meta.state === "cleanup_vacuum_pending") {
      db.pragma("secure_delete = ON");
      db.exec("VACUUM");
      updateProjectionState(db, "cleanup_checkpoint_after", 0);
      continue;
    }
    if (meta.state === "cleanup_checkpoint_after") {
      checkpointTruncate(db);
      updateProjectionState(db, "cleanup_retention_policy_pending", 0);
      continue;
    }
    if (meta.state === "cleanup_retention_policy_pending") {
      projectRetentionPolicyFile(rootPath, key, keyId);
      db.pragma("secure_delete = OFF");
      updateProjectionState(db, "ready", 0);
      continue;
    }
    throw Object.assign(new Error("Operation audit projection migration is in an invalid state."), {
      code: "operation_audit_projection_state_invalid"
    });
  }
}

function migrateOperationAuditProjection(
  db: Database.Database,
  rootPath: string,
  key: Uint8Array,
  keyId: string
): void {
  db.pragma("secure_delete = ON");
  const selectBatch = db.prepare<[number, number], OperationAuditRow & { projection_rowid: number }>(`
    SELECT rowid AS projection_rowid, *
    FROM operation_audit_log
    WHERE rowid > ?
    ORDER BY rowid ASC
    LIMIT ?
  `);
  const updateProjected = db.prepare<SqliteValue[]>(`
    UPDATE operation_audit_log
    SET trace_id = ?, request_id = ?, tenant_id = ?, decision_id = ?, proof_id = ?,
        operation_id = ?, transport = ?, actor_json = ?, risk = ?, read_only = ?,
        status = ?, duration_ms = ?, input_hash = ?, redacted_input_json = ?,
        redacted_output_summary_json = ?, error = ?, risk_control_anchor_digest = ?,
        risk_control_last_record_digest = ?, risk_control_gate_count = ?,
        risk_control_envelope_json = ?, created_at = ?, record_bytes = ?,
        idempotency_binding_hmac = ?
    WHERE audit_id = ?
  `);
  const projectBatch = db.transaction((): "more" | "cleanup" => {
    const meta = projectionMeta(db);
    if (!meta || meta.state !== "projecting") {
      throw Object.assign(new Error("Operation audit projection migration is in an invalid state."), {
        code: "operation_audit_projection_state_invalid"
      });
    }
    const rows = selectBatch.all(meta.cursor_rowid, AUDIT_PROJECTION_BATCH_SIZE);
    if (rows.length === 0) {
      db.exec(`
        UPDATE operation_audit_meta
        SET row_count = (SELECT COUNT(*) FROM operation_audit_log),
            logical_bytes = (SELECT COALESCE(SUM(record_bytes), 0) FROM operation_audit_log)
        WHERE singleton = 1
      `);
      updateProjectionState(db, "cleanup_checkpoint_before", 0);
      return "cleanup";
    }
    for (const row of rows) {
      const legacy = normalizedOperationAuditRow(row);
      if (!legacy) {
        throw Object.assign(new Error("Operation audit migration found an invalid legacy row."), {
          code: "operation_audit_projection_legacy_row_invalid"
        });
      }
      const projected = projectLegacyOperationAuditRecord(legacy, key);
      const values = operationAuditRecordValues(projected);
      const recordBytes = operationAuditRecordBytes(projected);
      const [auditId, traceId, requestId, tenantId, decisionId, proofId, operationId, transport,
        actorJson, risk, readOnly, status, durationMs, inputHash, redactedInputJson,
        redactedOutputSummaryJson, error, riskControlAnchorDigest, riskControlLastRecordDigest,
        riskControlGateCount, riskControlEnvelopeJson, createdAt, idempotencyBindingHmac] = values;
      updateProjected.run(
        traceId, requestId, tenantId, decisionId, proofId, operationId, transport, actorJson,
        risk, readOnly, status, durationMs, inputHash, redactedInputJson, redactedOutputSummaryJson,
        error, riskControlAnchorDigest, riskControlLastRecordDigest, riskControlGateCount,
        riskControlEnvelopeJson, createdAt, recordBytes, idempotencyBindingHmac, auditId
      );
    }
    updateProjectionState(db, "projecting", Number(rows.at(-1)?.projection_rowid || meta.cursor_rowid));
    return "more";
  });

  for (;;) {
    const state = projectBatch.immediate();
    if (state === "cleanup") break;
  }
  finishProjectionRemanenceCleanup(db, rootPath, key, keyId);
}

function ensureOperationAuditProjection(
  db: Database.Database,
  rootPath: string,
  key: Uint8Array,
  keyId: string,
  inspectionState: "empty" | "legacy_unprojected" | "projected"
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_PROJECTION_META_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version TEXT NOT NULL,
      projection_key_id TEXT NOT NULL,
      state TEXT NOT NULL,
      cursor_rowid INTEGER NOT NULL DEFAULT 0 CHECK (cursor_rowid >= 0)
    )
  `);
  let meta = projectionMeta(db);
  if (!meta) {
    if (inspectionState === "projected") {
      throw Object.assign(new Error("Operation audit projection metadata disappeared during startup."), {
        code: "operation_audit_projection_state_invalid"
      });
    }
    const initialState: OperationAuditProjectionState = inspectionState === "empty"
      ? "cleanup_retention_policy_pending"
      : "projecting";
    db.prepare<[string, string, string]>(`
      INSERT INTO ${AUDIT_PROJECTION_META_TABLE} (
        singleton, schema_version, projection_key_id, state, cursor_rowid
      ) VALUES (1, ?, ?, ?, 0)
    `).run(AUDIT_PROJECTION_VERSION, keyId, initialState);
    meta = projectionMeta(db);
  }
  if (
    !meta ||
    meta.schema_version !== AUDIT_PROJECTION_VERSION ||
    meta.projection_key_id !== keyId ||
    !["projecting", "cleanup_checkpoint_before", "cleanup_vacuum_pending", "cleanup_checkpoint_after", "cleanup_retention_policy_pending", "ready"].includes(meta.state)
  ) {
    throw Object.assign(new Error("Operation audit projection key or metadata does not match the stored records."), {
      code: meta?.projection_key_id !== keyId
        ? "operation_audit_projection_key_mismatch"
        : "operation_audit_projection_state_invalid"
    });
  }
  if (meta.state === "ready") {
    return;
  }
  if (meta.state === "cleanup_retention_policy_pending") {
    finishProjectionRemanenceCleanup(db, rootPath, key, keyId);
    return;
  }
  migrateOperationAuditProjection(db, rootPath, key, keyId);
}

function openOperationAuditDatabase(
  rootPath: string,
  key: Uint8Array,
  keyId: string
): {
  db: Database.Database;
  insertStmt: Database.Statement<SqliteValue[]>;
  databasePath: string;
} {
  const rawDatabasePath = path.join(rootPath, "operation-audit.sqlite");
  const inspection = inspectOperationAuditProjectionDatabase(rawDatabasePath);
  if (inspection.state === "projected" && inspection.projectionKeyId !== keyId) {
    throw Object.assign(new Error("Operation audit projection key does not match the stored records."), {
      code: "operation_audit_projection_key_mismatch"
    });
  }
  const databasePath = ensurePrivateSqliteLocation(rawDatabasePath);
  const state: { db: Database.Database | null } = { db: null };
  try {
    return withPrivateFileCreationMask(() => {
      const openedDatabase = openSqliteDatabase(databasePath) as Database.Database;
      state.db = openedDatabase;
      ensureSchema(openedDatabase);
      ensureOperationAuditProjection(openedDatabase, rootPath, key, keyId, inspection.state);
      ensurePrivateSqliteLocation(databasePath);
      const insertStmt = openedDatabase.prepare<SqliteValue[]>(`
      INSERT INTO operation_audit_log (
        audit_id, trace_id, request_id, tenant_id, decision_id, proof_id, operation_id, transport, actor_json, risk, read_only, status, duration_ms,
        input_hash, redacted_input_json, redacted_output_summary_json, error,
        risk_control_anchor_digest, risk_control_last_record_digest, risk_control_gate_count, risk_control_envelope_json,
        created_at, idempotency_binding_hmac, record_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return { db: openedDatabase, insertStmt, databasePath };
    });
  } catch (error: unknown) {
    try {
      state.db?.close();
    } catch {
      // Preserve the audit-store initialization failure.
    }
    throw error;
  }
}

/**
 * Worker-private synchronous owner. Runtime code must reach this store only
 * through the typed operation-audit SQLite execution lane.
 */
export function createOperationAuditWorkerStore({
  userDataPath,
  projectionKey: suppliedProjectionKey,
  projectionKeyId
}: { userDataPath: string; projectionKey: Uint8Array; projectionKeyId: string }): OperationAuditWorkerStore {
  const projectionKey = Buffer.from(suppliedProjectionKey);
  if (
    projectionKey.length !== 32 ||
    operationAuditProjectionKeyId(projectionKey) !== projectionKeyId
  ) {
    projectionKey.fill(0);
    throw Object.assign(new Error("Operation audit projection key is invalid."), {
      code: "operation_audit_projection_key_invalid"
    });
  }
  const rootPath = path.join(userDataPath, "security");
  let opened: ReturnType<typeof openOperationAuditDatabase>;
  try {
    ensurePrivateDir(rootPath);
    opened = openOperationAuditDatabase(rootPath, projectionKey, projectionKeyId);
  } catch (error: unknown) {
    projectionKey.fill(0);
    throw error;
  }
  const { db, insertStmt } = opened;
  try {
  const databasePageSize = Number(db.pragma("page_size", { simple: true }) || 4096);
  const retentionPolicyPath = path.join(rootPath, "audit-retention.json");
  const deleteExpiredStmt = db.prepare<[string, number]>(`
    DELETE FROM operation_audit_log
    WHERE audit_id IN (
      SELECT audit_id
      FROM operation_audit_log
      WHERE created_at < ?
      ORDER BY created_at ASC, audit_id ASC
      LIMIT ?
    )
  `);
  const readMetaStmt = db.prepare<[], AuditMetaRow>(`
    SELECT row_count AS rowCount,
           logical_bytes AS logicalBytes,
           append_count AS appendCount,
           last_maintenance_at AS lastMaintenanceAt
    FROM operation_audit_meta
    WHERE singleton = 1
  `);
  const markMaintenanceStmt = db.prepare<[string]>(`
    UPDATE operation_audit_meta
    SET last_maintenance_at = ?
    WHERE singleton = 1
  `);
  const selectByIdStmt = db.prepare<[string], OperationAuditRow>(`
    SELECT *
    FROM operation_audit_log
    WHERE audit_id = ?
  `);

  function normalizeRetentionPolicy(input: DataRecord = {}): RetentionPolicy {
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

  function readRetentionPolicy(): RetentionPolicy {
    let source: DataRecord;
    try {
      source = asRecord(JSON.parse(fs.readFileSync(retentionPolicyPath, "utf8")));
    } catch (error: unknown) {
      if (asRecord(error).code === "ENOENT") return normalizeRetentionPolicy();
      throw Object.assign(new Error("Operation audit retention policy is unavailable."), {
        code: "operation_audit_projection_retention_invalid"
      });
    }
    if (
      source.operationAuditProjectionVersion !== AUDIT_PROJECTION_VERSION ||
      source.operationAuditProjectionKeyId !== projectionKeyId
    ) {
      throw Object.assign(new Error("Operation audit retention policy projection does not match its database."), {
        code: "operation_audit_projection_retention_invalid"
      });
    }
    return normalizeRetentionPolicy(source);
  }

  let retentionPolicy = readRetentionPolicy();

  function configureDatabaseCapacity(policy: RetentionPolicy): void {
    const maxPages = Math.max(1, Math.floor(policy.maxDatabaseBytes / databasePageSize));
    db.pragma(`max_page_count = ${maxPages}`);
  }

  configureDatabaseCapacity(retentionPolicy);

  function recordBytes(values: readonly SqliteValue[]): number {
    return AUDIT_RECORD_FIXED_BYTES + values.reduce<number>(
      (total, value) => total + Buffer.byteLength(String(value ?? ""), "utf8"),
      0
    );
  }

  function activeDatabaseBytes(): number {
    const pageCount = Number(db.pragma("page_count", { simple: true }) || 0);
    const freePages = Number(db.pragma("freelist_count", { simple: true }) || 0);
    return Math.max(0, pageCount - freePages) * databasePageSize;
  }

  function maintainStorageAfterDelete(deletedCount: number): void {
    if (deletedCount <= 0) {
      return;
    }
    db.pragma("wal_checkpoint(PASSIVE)");
    if (Number(db.pragma("auto_vacuum", { simple: true }) || 0) === 2) {
      db.pragma(`incremental_vacuum(${Math.min(deletedCount, retentionPolicy.cleanupBatchSize)})`);
    }
  }

  function pruneExpiredInTransaction(policy: RetentionPolicy, cutoff: string): number {
    const result = deleteExpiredStmt.run(cutoff, policy.cleanupBatchSize);
    markMaintenanceStmt.run(nowIso());
    return Number(result.changes || 0);
  }

  function appendNewRecordInTransaction(record: PreparedAuditRecord, policy: RetentionPolicy): AppendOutcome {
    let meta = readMetaStmt.get();
    if (!meta) {
      throw new Error("Operation audit metadata row is missing.");
    }
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
      const refreshedMeta = readMetaStmt.get();
      if (!refreshedMeta) {
        throw new Error("Operation audit metadata row is missing after retention cleanup.");
      }
      meta = refreshedMeta;
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
  }

  const appendTransaction = db.transaction((record: PreparedAuditRecord, policy: RetentionPolicy): AppendOutcome => (
    appendNewRecordInTransaction(record, policy)
  ));

  const appendIdempotentTransaction = db.transaction((
    entry: DataRecord,
    auditId: string,
    policy: RetentionPolicy
  ): IdempotentAppendOutcome => {
    const existing = selectByIdStmt.get(auditId);
    const record = projectedOperationAuditRecord(entry);
    if (record.auditId !== auditId) {
      throw new OperationAuditIdRequiredError();
    }
    if (existing) {
      if (
        existing.idempotency_binding_hmac !== record.idempotencyBindingHmac ||
        (record.createdAt && existing.created_at !== record.createdAt)
      ) {
        throw new OperationAuditIdempotencyConflictError(auditId);
      }
      return {
        auditId,
        replayed: true,
        deletedCount: 0,
        capacity: null
      };
    }

    if (!record.createdAt) record.createdAt = nowIso();
    const values = operationAuditRecordValues(record);
    const bytes = recordBytes(values);
    if (bytes > policy.maxLogicalBytes) {
      throw new OperationAuditCapacityError("record_bytes", policy.maxLogicalBytes, bytes);
    }
    const outcome = appendNewRecordInTransaction({ values, recordBytes: bytes }, policy);
    return {
      auditId,
      replayed: false,
      ...outcome
    };
  });

  function append(entry: DataRecord = {}): { auditId: string; maintenance: { deletedCount: number } } {
    const record = projectedOperationAuditRecord(entry);
    const auditId = record.auditId;
    if (!auditId) {
      throw new Error("Operation audit append requires a projected audit identifier.");
    }
    const values = operationAuditRecordValues(record);
    const bytes = recordBytes(values);
    if (bytes > retentionPolicy.maxLogicalBytes) {
      throw new OperationAuditCapacityError("record_bytes", retentionPolicy.maxLogicalBytes, bytes);
    }
    let outcome: AppendOutcome;
    try {
      outcome = appendTransaction({ values, recordBytes: bytes }, retentionPolicy);
    } catch (error: unknown) {
      if (sqliteErrorCode(error) === "SQLITE_FULL") {
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

  function appendIdempotent(entry: DataRecord = {}): {
    auditId: string;
    replayed: boolean;
    maintenance: { deletedCount: number };
  } {
    if (
      !entry ||
      typeof entry !== "object" ||
      !Object.hasOwn(entry, "auditId") ||
      typeof entry.auditId !== "string" ||
      entry.auditId.trim().length === 0
    ) {
      throw new OperationAuditIdRequiredError();
    }
    const auditId = entry.auditId;
    let outcome: IdempotentAppendOutcome;
    try {
      outcome = appendIdempotentTransaction.immediate(entry, auditId, retentionPolicy);
    } catch (error: unknown) {
      if (sqliteErrorCode(error) === "SQLITE_FULL") {
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
    return {
      auditId,
      replayed: outcome.replayed,
      maintenance: { deletedCount: outcome.deletedCount }
    };
  }

  function getById(auditId?: unknown): OperationAuditItem | null {
    const normalizedAuditId = typeof auditId === "string" ? auditId : "";
    if (!normalizedAuditId) {
      return null;
    }
    const row = selectByIdStmt.get(normalizedAuditId);
    return row ? projectOperationAuditRow(row) : null;
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
  }: DataRecord = {}): OperationAuditItem[] {
    const clauses: string[] = [];
    const params: SqliteValue[] = [];
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
    const rows = db.prepare<SqliteValue[], OperationAuditRow>(`
      SELECT * FROM operation_audit_log
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit));
    return rows
      .map(projectOperationAuditRow)
      .filter((entry) => !userId || entry.actor.userId === String(userId));
  }

  function getRetentionPolicy(): RetentionPolicy {
    return {
      ...retentionPolicy,
      updatedBy: redactOperationAuditValue(retentionPolicy.updatedBy || {})
    };
  }

  function setRetentionPolicy(input: DataRecord = {}): RetentionPolicy {
    const definedInput = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== "")
    );
    const policy = normalizeRetentionPolicy({
      ...retentionPolicy,
      ...definedInput,
      updatedAt: nowIso(),
      updatedBy: redactOperationAuditValue(input.updatedBy || {})
    });
    fs.writeFileSync(retentionPolicyPath, `${JSON.stringify({
      ...policy,
      operationAuditProjectionVersion: AUDIT_PROJECTION_VERSION,
      operationAuditProjectionKeyId: projectionKeyId
    }, null, 2)}\n`, { mode: 0o600 });
    retentionPolicy = policy;
    configureDatabaseCapacity(retentionPolicy);
    return policy;
  }

  function pruneExpired(input: DataRecord = {}): DataRecord {
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

  function exportRedacted(input: DataRecord = {}): unknown {
    const policy = getRetentionPolicy();
    const items = list({
      ...input,
      limit: asLimit(input.limit, Math.min(policy.maxExportItems, DEFAULT_MAX_EXPORT_ITEMS), policy.maxExportItems)
    });
    const manifest: DataRecord = {
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

  function getTrace(traceId?: unknown, input: DataRecord = {}): DataRecord {
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
    ready(): void {
      const meta = projectionMeta(db);
      if (!meta || meta.state !== "ready" || meta.projection_key_id !== projectionKeyId) {
        throw Object.assign(new Error("Operation audit privacy projection is not ready."), {
          code: "operation_audit_projection_state_invalid"
        });
      }
    },
    append,
    appendIdempotent,
    getById,
    list,
    getRetentionPolicy,
    setRetentionPolicy,
    pruneExpired,
    exportRedacted,
    getTrace,
    close(): void {
      try {
        db.close();
      } finally {
        projectionKey.fill(0);
      }
    }
  };
  } catch (error: unknown) {
    try {
      db.close();
    } catch {
      // Preserve the store initialization failure.
    }
    projectionKey.fill(0);
    throw error;
  }
}

export default createOperationAuditWorkerStore;
