import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import { openSqliteDatabase } from "../storage/sqlite-database.ts";
import {
  ABSOLUTE_PATH_PATTERN,
  SENSITIVE_KEY_PATTERN,
  redactOperationAuditValue,
  truncateOperationAuditJson
} from "./operation-audit-common.ts";

type DataRecord = Record<string, unknown>;
const PROJECTION_SCHEMA_VERSION = "meshrix-operation-audit-projection-v1";
const PROJECTION_META_TABLE = "operation_audit_projection_meta";
const MAX_OPERATION_AUDIT_SCHEMA_VERSION = 5;

export type OperationAuditProjectionInspection = Readonly<{
  state: "empty" | "legacy_unprojected" | "projected";
  projectionKeyId?: string;
}>;

function projectionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function tableExists(db: ReturnType<typeof openSqliteDatabase>, name: string): boolean {
  return Boolean(db.prepare<[string], { name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

export function inspectOperationAuditProjectionDatabase(databasePath: string): OperationAuditProjectionInspection {
  const resolvedPath = path.resolve(databasePath);
  const sidecarPaths = ["-wal", "-shm", "-journal"].map((suffix) => `${resolvedPath}${suffix}`);
  const mainStat = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (!mainStat) {
    if (sidecarPaths.some((sidecarPath) => fs.existsSync(sidecarPath))) {
      throw projectionError("operation_audit_projection_schema_invalid", "Operation audit SQLite sidecars exist without a database file.");
    }
    return Object.freeze({ state: "empty" });
  }
  if (!mainStat.isFile() || mainStat.isSymbolicLink()) {
    throw projectionError("operation_audit_projection_schema_invalid", "Operation audit database is not a regular file.");
  }

  let db: ReturnType<typeof openSqliteDatabase> | undefined;
  try {
    db = openSqliteDatabase(resolvedPath, { readonly: true, fileMustExist: true });
    const userVersion = Number(db.pragma("user_version", { simple: true }) || 0);
    if (userVersion < 0 || userVersion > MAX_OPERATION_AUDIT_SCHEMA_VERSION) {
      throw projectionError("operation_audit_projection_schema_invalid", "Operation audit schema version is unsupported.");
    }
    const hasAuditTable = tableExists(db, "operation_audit_log");
    const hasMetaTable = tableExists(db, PROJECTION_META_TABLE);
    if (!hasAuditTable) {
      const otherTables = Number(db.prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).get()?.count || 0);
      if (userVersion !== 0 || hasMetaTable || otherTables > 0) {
        throw projectionError("operation_audit_projection_schema_invalid", "Operation audit database does not contain its expected schema.");
      }
      return Object.freeze({ state: "empty" });
    }

    const columns = new Set(db.prepare<[], { name: string }>(
      "PRAGMA table_info(operation_audit_log)"
    ).all().map((column) => String(column.name || "")));
    for (const required of [
      "audit_id", "operation_id", "transport", "actor_json", "risk", "read_only", "status",
      "duration_ms", "input_hash", "redacted_input_json", "redacted_output_summary_json", "error", "created_at"
    ]) {
      if (!columns.has(required)) {
        throw projectionError("operation_audit_projection_schema_invalid", "Operation audit database is missing a required column.");
      }
    }

    if (!hasMetaTable) {
      if (columns.has("idempotency_binding_hmac")) {
        const partiallyProjected = Number(db.prepare<[], { count: number }>(`
          SELECT COUNT(*) AS count
          FROM operation_audit_log
          WHERE idempotency_binding_hmac <> '' OR input_hash LIKE 'hmac-sha256:v1:%'
        `).get()?.count || 0);
        if (partiallyProjected > 0) {
          throw projectionError("operation_audit_projection_state_invalid", "Operation audit projection metadata is missing for projected records.");
        }
      } else if (columns.has("input_hash")) {
        const partiallyProjected = Number(db.prepare<[], { count: number }>(`
          SELECT COUNT(*) AS count
          FROM operation_audit_log
          WHERE input_hash LIKE 'hmac-sha256:v1:%'
        `).get()?.count || 0);
        if (partiallyProjected > 0) {
          throw projectionError("operation_audit_projection_state_invalid", "Operation audit projection metadata is missing for projected records.");
        }
      }
      return Object.freeze({ state: "legacy_unprojected" });
    }

    const metaColumns = new Set(db.prepare<[], { name: string }>(
      `PRAGMA table_info(${PROJECTION_META_TABLE})`
    ).all().map((column) => String(column.name || "")));
    for (const required of ["singleton", "schema_version", "projection_key_id", "state", "cursor_rowid"]) {
      if (!metaColumns.has(required)) {
        throw projectionError("operation_audit_projection_state_invalid", "Operation audit projection metadata is incomplete.");
      }
    }
    const meta = db.prepare<[], {
      schema_version: string;
      projection_key_id: string;
      state: string;
    }>(`
      SELECT schema_version, projection_key_id, state
      FROM ${PROJECTION_META_TABLE}
      WHERE singleton = 1
    `).get();
    if (
      !meta ||
      meta.schema_version !== PROJECTION_SCHEMA_VERSION ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(meta.projection_key_id || "")) ||
      !["projecting", "cleanup_checkpoint_before", "cleanup_vacuum_pending", "cleanup_checkpoint_after", "cleanup_retention_policy_pending", "ready"].includes(meta.state)
    ) {
      throw projectionError("operation_audit_projection_state_invalid", "Operation audit projection metadata is invalid.");
    }
    if (!columns.has("idempotency_binding_hmac") || userVersion < MAX_OPERATION_AUDIT_SCHEMA_VERSION) {
      throw projectionError("operation_audit_projection_state_invalid", "Projected operation audit database has an incomplete schema.");
    }
    return Object.freeze({ state: "projected", projectionKeyId: meta.projection_key_id });
  } finally {
    db?.close();
  }
}

export interface OperationAuditRecord {
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
  idempotencyBindingHmac: string;
}

export interface OperationAuditProjectionContext {
  key: Uint8Array;
}

export function operationAuditProjectionKeyId(key: Uint8Array): string {
  return `sha256:${crypto.createHash("sha256").update(key).digest("hex")}`;
}

function asRecord(value: unknown): DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as DataRecord
    : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function hashValue(value?: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function hmac(key: Uint8Array, purpose: string, value: unknown): string {
  return `hmac-sha256:v1:${crypto.createHmac("sha256", key)
    .update(`meshrix.js/operation-audit-projection/v1\0${purpose}\0`, "utf8")
    .update(typeof value === "string" ? value : canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function pseudonym(key: Uint8Array, purpose: string, value: unknown): string {
  const normalized = String(value ?? "");
  return normalized ? hmac(key, purpose, normalized) : "";
}

function actorFrom(value: DataRecord = {}): DataRecord {
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

function summarizeOutput(value?: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (Buffer.isBuffer(value)) return { type: "buffer", byteLength: (value as Buffer).length };
  if (typeof value !== "object") return { value: redactOperationAuditValue(value) };
  if (Array.isArray(value)) return { type: "array", length: value.length };
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

function riskControlAuditSnapshot(value: unknown = null): DataRecord {
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

function canonicalJsonField(value: string): string {
  return canonicalJson(JSON.parse(value));
}

function canonicalBindingRecord(record: OperationAuditRecord): DataRecord {
  return {
    auditId: record.auditId,
    traceId: record.traceId,
    requestId: record.requestId,
    tenantId: record.tenantId,
    decisionId: record.decisionId,
    proofId: record.proofId,
    operationId: record.operationId,
    transport: record.transport,
    actorJson: canonicalJsonField(record.actorJson),
    risk: record.risk,
    readOnly: record.readOnly,
    status: record.status,
    durationMs: record.durationMs,
    inputHash: record.inputHash,
    redactedInputJson: canonicalJsonField(record.redactedInputJson),
    redactedOutputSummaryJson: canonicalJsonField(record.redactedOutputSummaryJson),
    error: record.error,
    riskControlAnchorDigest: record.riskControlAnchorDigest,
    riskControlLastRecordDigest: record.riskControlLastRecordDigest,
    riskControlGateCount: record.riskControlGateCount,
    riskControlEnvelopeJson: canonicalJsonField(record.riskControlEnvelopeJson)
  };
}

export function normalizeLegacyOperationAuditRecord(
  entry: DataRecord = {},
  { auditId, fallbackCreatedAt = "" }: { auditId: string; fallbackCreatedAt?: string }
): OperationAuditRecord {
  const input = entry.input ?? {};
  const inputRecord = asRecord(input);
  const actor = actorFrom(asRecord(entry.actor));
  const riskControl = riskControlAuditSnapshot(entry.riskControl || entry.riskControlEnvelope || null);
  const decisionId = String(entry.decisionId || entry.authorizationDecisionId || "");
  const proofId = String(entry.proofId || entry.ledgerEventId || "");
  const canonicalReference = Boolean(decisionId || proofId);
  const redactedInput = redactOperationAuditValue(input);
  const redactedOutput = truncateOperationAuditJson(summarizeOutput(entry.output));
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
    redactedInputJson: JSON.stringify(redactedInput),
    redactedOutputSummaryJson: JSON.stringify(redactedOutput),
    error: canonicalReference
      ? ""
      : String(entry.error || "").replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>").slice(0, 2000),
    riskControlAnchorDigest: String(riskControl.anchorDigest || ""),
    riskControlLastRecordDigest: String(riskControl.lastRecordDigest || ""),
    riskControlGateCount: Number(riskControl.gateCount || 0),
    riskControlEnvelopeJson: JSON.stringify(riskControl.envelope),
    createdAt: String(entry.createdAt || fallbackCreatedAt || new Date().toISOString()),
    idempotencyBindingHmac: ""
  };
}

function projectActor(value: unknown, key: Uint8Array): DataRecord {
  const actor = asRecord(value);
  return {
    type: ["anonymous", "console-user", "tool-grant"].includes(String(actor.type || ""))
      ? String(actor.type)
      : pseudonym(key, "actor-type", actor.type),
    userId: pseudonym(key, "user-id", actor.userId),
    username: pseudonym(key, "username", actor.username),
    roleId: pseudonym(key, "role-id", actor.roleId),
    tenantId: pseudonym(key, "tenant-id", actor.tenantId),
    orgId: pseudonym(key, "org-id", actor.orgId),
    teamIds: Array.isArray(actor.teamIds)
      ? actor.teamIds.map((id) => pseudonym(key, "team-id", id)).filter(Boolean)
      : [],
    departmentIds: Array.isArray(actor.departmentIds)
      ? actor.departmentIds.map((id) => pseudonym(key, "department-id", id)).filter(Boolean)
      : []
  };
}

function projectRiskControlEnvelope(value: unknown, key: Uint8Array): DataRecord {
  const envelope = asRecord(value);
  const records = Array.isArray(envelope.gateRecords)
    ? envelope.gateRecords.map(asRecord)
    : [];
  return {
    envelopeVersion: String(envelope.envelopeVersion || ""),
    operationId: String(envelope.operationId || ""),
    traceId: pseudonym(key, "trace-id", envelope.traceId),
    inputHash: pseudonym(key, "risk-control-input-hash", envelope.inputHash),
    operationAnchorDigest: String(envelope.operationAnchorDigest || ""),
    gateRecords: records.map((record) => ({
      recordVersion: String(record.recordVersion || ""),
      controlRef: record.controlRef || {},
      gate: String(record.gate || ""),
      decision: String(record.decision || ""),
      reasonCode: String(record.reasonCode || ""),
      subject: {},
      intent: "",
      resource: {},
      environment: {},
      enforcedBy: record.enforcedBy || {},
      factSource: record.factSource || {},
      evidence: [],
      occurredAt: String(record.occurredAt || ""),
      previousRecordDigest: String(record.previousRecordDigest || ""),
      recordDigest: String(record.recordDigest || "")
    }))
  };
}

function projectedOutputSummary(value: unknown): unknown {
  const summary = asRecord(value);
  if (summary.type === "array") return { type: "array", length: Math.max(0, Number(summary.length || 0)) };
  if (summary.type === "buffer") return { type: "buffer", byteLength: Math.max(0, Number(summary.byteLength || 0)) };
  if (summary.type === "object") return { type: "object", keyCount: Math.max(0, Number(summary.keyCount ?? Object.keys(summary).length)) };
  if (Object.hasOwn(summary, "value")) return { type: typeof summary.value };
  if (summary.redacted === true) return { type: "object", keyCount: 0 };
  return Object.keys(summary).length ? { type: "object", keyCount: Object.keys(summary).length } : {};
}

export function projectLegacyOperationAuditRecord(
  legacyRecord: Omit<OperationAuditRecord, "idempotencyBindingHmac"> | OperationAuditRecord,
  key: Uint8Array
): OperationAuditRecord {
  const record = legacyRecord as OperationAuditRecord;
  const binding = hmac(key, "idempotency-binding", canonicalBindingRecord(record));
  const actor = JSON.parse(canonicalJsonField(record.actorJson));
  const riskControlEnvelope = JSON.parse(canonicalJsonField(record.riskControlEnvelopeJson));
  const oldOutput = JSON.parse(canonicalJsonField(record.redactedOutputSummaryJson));
  const canonicalReference = Boolean(record.decisionId || record.proofId);
  return {
    ...record,
    traceId: pseudonym(key, "trace-id", record.traceId),
    requestId: pseudonym(key, "request-id", record.requestId),
    tenantId: pseudonym(key, "tenant-id", record.tenantId),
    decisionId: pseudonym(key, "decision-id", record.decisionId),
    proofId: pseudonym(key, "proof-id", record.proofId),
    actorJson: JSON.stringify(projectActor(actor, key)),
    // Hash even an empty legacy value so every projected row has a uniform,
    // non-guessable input binding and can pass the ready-state invariant.
    inputHash: hmac(key, "input-hash", record.inputHash),
    redactedInputJson: "{}",
    redactedOutputSummaryJson: JSON.stringify(projectedOutputSummary(oldOutput)),
    error: canonicalReference || !record.error ? "" : hmac(key, "error", record.error),
    riskControlEnvelopeJson: JSON.stringify(projectRiskControlEnvelope(riskControlEnvelope, key)),
    idempotencyBindingHmac: binding
  };
}

export function projectOperationAuditEntry(
  entry: DataRecord = {},
  { key, auditId, createdAt }: OperationAuditProjectionContext & { auditId: string; createdAt?: string }
): OperationAuditRecord {
  const normalized = normalizeLegacyOperationAuditRecord(entry, {
    auditId,
    fallbackCreatedAt: createdAt || ""
  });
  if (createdAt !== undefined) normalized.createdAt = createdAt;
  return projectLegacyOperationAuditRecord(normalized, key);
}

export function projectOperationAuditFilter(
  input: DataRecord = {},
  key: Uint8Array
): DataRecord {
  const projected: DataRecord = {};
  if (input.limit !== undefined) projected.limit = Number(input.limit);
  for (const field of ["operationId", "status", "createdFrom", "createdTo"] as const) {
    if (input[field] !== undefined) projected[field] = String(input[field] ?? "");
  }
  if (input.traceId) projected.traceId = pseudonym(key, "trace-id", input.traceId);
  if (input.tenantId) projected.tenantId = pseudonym(key, "tenant-id", input.tenantId);
  if (input.userId) projected.userId = pseudonym(key, "user-id", input.userId);
  return projected;
}

export function projectOperationAuditRetentionPolicy(
  input: DataRecord = {},
  key: Uint8Array
): DataRecord {
  const updatedBy = asRecord(input.updatedBy);
  const user = asRecord(updatedBy.user || updatedBy);
  const projected: DataRecord = {};
  for (const field of [
    "retentionDays", "maxExportItems", "maxRecords", "maxLogicalBytes", "maxDatabaseBytes",
    "cleanupBatchSize", "maintenanceEveryAppends"
  ] as const) {
    if (input[field] !== undefined) projected[field] = Number(input[field]);
  }
  const projectedActor: DataRecord = {};
  const actorType = ["anonymous", "console-user", "tool-grant"].includes(String(updatedBy.type || ""))
    ? String(updatedBy.type)
    : pseudonym(key, "actor-type", updatedBy.type);
  for (const [field, value] of Object.entries({
    type: actorType,
    userId: pseudonym(key, "user-id", user.userId),
    username: pseudonym(key, "username", user.username),
    roleId: pseudonym(key, "role-id", user.roleId),
    tenantId: pseudonym(key, "tenant-id", user.tenantId),
    orgId: pseudonym(key, "org-id", user.orgId)
  })) {
    if (value) projectedActor[field] = value;
  }
  return {
    ...projected,
    updatedBy: projectedActor
  };
}
