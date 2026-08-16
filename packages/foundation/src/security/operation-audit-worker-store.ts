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
  ABSOLUTE_PATH_PATTERN,
  MAX_JSON_BYTES,
  OperationAuditCapacityError,
  OperationAuditIdempotencyConflictError,
  OperationAuditIdRequiredError,
  SENSITIVE_KEY_PATTERN,
  redactOperationAuditValue,
  truncateOperationAuditJson
} from "./operation-audit-common.ts";
type DataRecord = Record<string, unknown>;
type SqliteValue = string | number;

interface OperationAuditRecord {
  auditId: string;
  traceId: string;
  requestId: string;
  tenantId: string;
  decisionId: string;
  proofId: string;
  operationId: string;
  transport: string;
  actorJson: string;
  risk: string;
  readOnly: number;
  status: string;
  durationMs: number;
  inputHash: string;
  redactedInputJson: string;
  redactedOutputSummaryJson: string;
  error: string;
  riskControlAnchorDigest: string;
  riskControlLastRecordDigest: string;
  riskControlGateCount: number;
  riskControlEnvelopeJson: string;
  createdAt: string;
}

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
}

interface OperationAuditActor extends DataRecord {
  type: string;
  userId: string;
  username: string;
  roleId: string;
  tenantId: string;
  orgId: string;
  teamIds: unknown[];
  departmentIds: unknown[];
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

function hashValue(value?: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
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

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function summarizeOutput(value?: unknown): unknown {
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
  const summary: DataRecord = {};
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
  return truncateOperationAuditJson(summary);
}

function actorFrom(value: DataRecord = {}): OperationAuditActor {
  const user = asRecord(value.user || value);
  const teamIds = user.teamIds || value.teamIds;
  const departmentIds = user.departmentIds || value.departmentIds;
  return {
    type: String(value.type || (user.userId ? "console-user" : "anonymous")),
    userId: String(user.userId || ""),
    username: String(user.username || ""),
    roleId: String(user.roleId || ""),
    tenantId: String(user.tenantId || value.tenantId || ""),
    orgId: String(user.orgId || value.orgId || ""),
    teamIds: Array.isArray(teamIds) ? [...teamIds] : [],
    departmentIds: Array.isArray(departmentIds) ? [...departmentIds] : []
  };
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
      record_bytes INTEGER NOT NULL DEFAULT 0 CHECK (record_bytes >= 0)
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

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value || "")) as T;
  } catch {
    return fallback;
  }
}

function riskControlAuditSnapshot(value: unknown = null): RiskControlSnapshot {
  const envelope = asRecord(value);
  const records = Array.isArray(envelope.gateRecords)
    ? envelope.gateRecords.map(asRecord)
    : [];
  const compactEnvelope: DataRecord = {
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
    envelope: truncateOperationAuditJson(redactedEnvelope)
  };
}

function normalizeOperationAuditRecord(entry: DataRecord = {}, {
  auditId,
  fallbackCreatedAt = ""
}: { auditId: string; fallbackCreatedAt?: string }): OperationAuditRecord {
  const input = entry.input ?? {};
  const inputRecord = asRecord(input);
  const actor = actorFrom(asRecord(entry.actor));
  const riskControl = riskControlAuditSnapshot(entry.riskControl || entry.riskControlEnvelope || null);
  const decisionId = String(entry.decisionId || entry.authorizationDecisionId || "");
  const proofId = String(entry.proofId || entry.ledgerEventId || "");
  const canonicalReference = Boolean(decisionId || proofId);
  return {
    auditId,
    traceId: String(entry.traceId || ""),
    requestId: String(entry.requestId || ""),
    tenantId: firstString(
      entry.tenantId,
      asRecord(entry.tenant).tenantId,
      actor.tenantId,
      inputRecord.tenantId,
      inputRecord["tenant-id"]
    ),
    decisionId,
    proofId,
    operationId: String(entry.operationId || ""),
    transport: String(entry.transport || "unknown"),
    actorJson: JSON.stringify(actor),
    risk: String(entry.risk || ""),
    readOnly: entry.readOnly ? 1 : 0,
    status: String(entry.status || ""),
    durationMs: Math.max(0, Number(entry.durationMs || 0)),
    inputHash: hashValue(input),
    redactedInputJson: JSON.stringify(redactOperationAuditValue(input)),
    redactedOutputSummaryJson: JSON.stringify(summarizeOutput(entry.output)),
    error: canonicalReference
      ? ""
      : String(entry.error || "").replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>").slice(0, 2000),
    riskControlAnchorDigest: riskControl.anchorDigest,
    riskControlLastRecordDigest: riskControl.lastRecordDigest,
    riskControlGateCount: riskControl.gateCount,
    riskControlEnvelopeJson: JSON.stringify(riskControl.envelope),
    createdAt: String(entry.createdAt || fallbackCreatedAt || nowIso())
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
    record.createdAt
  ];
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
    createdAt: row.created_at
  };
}

function operationAuditRecordsEqual(row: OperationAuditRow, record: OperationAuditRecord): boolean {
  const stored = normalizedOperationAuditRow(row);
  const normalizedRecord = normalizedOperationAuditRow({
    audit_id: record.auditId,
    trace_id: record.traceId,
    request_id: record.requestId,
    tenant_id: record.tenantId,
    decision_id: record.decisionId,
    proof_id: record.proofId,
    operation_id: record.operationId,
    transport: record.transport,
    actor_json: record.actorJson,
    risk: record.risk,
    read_only: record.readOnly,
    status: record.status,
    duration_ms: record.durationMs,
    input_hash: record.inputHash,
    redacted_input_json: record.redactedInputJson,
    redacted_output_summary_json: record.redactedOutputSummaryJson,
    error: record.error,
    risk_control_anchor_digest: record.riskControlAnchorDigest,
    risk_control_last_record_digest: record.riskControlLastRecordDigest,
    risk_control_gate_count: record.riskControlGateCount,
    risk_control_envelope_json: record.riskControlEnvelopeJson,
    created_at: record.createdAt
  });
  return (
    stored !== null &&
    normalizedRecord !== null &&
    stableJson(stored) === stableJson(normalizedRecord)
  );
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

function openOperationAuditDatabase(rootPath: string): {
  db: Database.Database;
  insertStmt: Database.Statement<SqliteValue[]>;
  databasePath: string;
} {
  const databasePath = ensurePrivateSqliteLocation(path.join(rootPath, "operation-audit.sqlite"));
  const state: { db: Database.Database | null } = { db: null };
  try {
    return withPrivateFileCreationMask(() => {
      const openedDatabase = openSqliteDatabase(databasePath) as Database.Database;
      state.db = openedDatabase;
      ensureSchema(openedDatabase);
      ensurePrivateSqliteLocation(databasePath);
      const insertStmt = openedDatabase.prepare<SqliteValue[]>(`
      INSERT INTO operation_audit_log (
        audit_id, trace_id, request_id, tenant_id, decision_id, proof_id, operation_id, transport, actor_json, risk, read_only, status, duration_ms,
        input_hash, redacted_input_json, redacted_output_summary_json, error,
        risk_control_anchor_digest, risk_control_last_record_digest, risk_control_gate_count, risk_control_envelope_json,
        created_at, record_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
export function createOperationAuditWorkerStore({ userDataPath }: { userDataPath: string }): OperationAuditWorkerStore {
  const rootPath = path.join(userDataPath, "security");
  ensurePrivateDir(rootPath);
  const { db, insertStmt } = openOperationAuditDatabase(rootPath);
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
    try {
      return normalizeRetentionPolicy(asRecord(JSON.parse(fs.readFileSync(retentionPolicyPath, "utf8"))));
    } catch {
      return normalizeRetentionPolicy();
    }
  }

  let retentionPolicy = readRetentionPolicy();

  function configureDatabaseCapacity(policy: RetentionPolicy): void {
    const pageSize = Number(db.pragma("page_size", { simple: true }) || 4096);
    const maxPages = Math.max(1, Math.floor(policy.maxDatabaseBytes / pageSize));
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
    const pageSize = Number(db.pragma("page_size", { simple: true }) || 4096);
    const pageCount = Number(db.pragma("page_count", { simple: true }) || 0);
    const freePages = Number(db.pragma("freelist_count", { simple: true }) || 0);
    return Math.max(0, pageCount - freePages) * pageSize;
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
    const record = normalizeOperationAuditRecord(entry, {
      auditId,
      fallbackCreatedAt: existing?.created_at || ""
    });
    if (existing) {
      if (!operationAuditRecordsEqual(existing, record)) {
        throw new OperationAuditIdempotencyConflictError(auditId);
      }
      return {
        auditId,
        replayed: true,
        deletedCount: 0,
        capacity: null
      };
    }

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
    const auditId = String(entry.auditId || `op_audit_${crypto.randomUUID()}`);
    const record = normalizeOperationAuditRecord(entry, { auditId });
    const values = operationAuditRecordValues(record);
    const bytes = recordBytes(values);
    if (bytes > retentionPolicy.maxLogicalBytes) {
      throw new OperationAuditCapacityError("record_bytes", retentionPolicy.maxLogicalBytes, bytes);
    }
    configureDatabaseCapacity(retentionPolicy);
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
    configureDatabaseCapacity(retentionPolicy);
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
    fs.writeFileSync(retentionPolicyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
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
      db.close();
    }
  };
}

export default createOperationAuditWorkerStore;
