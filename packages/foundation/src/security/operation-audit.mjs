import { canonicalJson as stableJson } from "@lico/contracts/serialization/canonical-json";
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
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

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
      created_at TEXT NOT NULL
    );
  `);

  // Version-controlled migrations.
  runMigrations(db, [
    {
      version: 1,
      up: (d) => {
        ensureOperationAuditColumns(d);
      }
    }
  ]);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operation_audit_created ON operation_audit_log(created_at);
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return { db, insertStmt };
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

  function append(entry = {}) {
    const input = entry.input ?? {};
    const redactedInput = redactOperationAuditValue(input);
    const outputSummary = summarizeOutput(entry.output);
    const auditId = entry.auditId || `op_audit_${crypto.randomUUID()}`;
    const actor = actorFrom(entry.actor || {});
    const riskControl = riskControlAuditSnapshot(entry.riskControl || entry.riskControlEnvelope || null);
    insertStmt.run(
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
    );
    return { auditId };
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
    try {
      const parsed = JSON.parse(fs.readFileSync(retentionPolicyPath, "utf8"));
      return {
        policyVersion: "v0.0.1:platform:audit-retention-1",
        retentionDays: Math.max(1, Math.min(Number(parsed.retentionDays || DEFAULT_RETENTION_DAYS), 3650)),
        maxExportItems: Math.max(1, Math.min(Number(parsed.maxExportItems || DEFAULT_MAX_EXPORT_ITEMS), 10000)),
        updatedAt: parsed.updatedAt || "",
        updatedBy: redactOperationAuditValue(parsed.updatedBy || {})
      };
    } catch {
      return {
        policyVersion: "v0.0.1:platform:audit-retention-1",
        retentionDays: DEFAULT_RETENTION_DAYS,
        maxExportItems: DEFAULT_MAX_EXPORT_ITEMS,
        updatedAt: "",
        updatedBy: {}
      };
    }
  }

  function setRetentionPolicy(input = {}) {
    const policy = {
      policyVersion: "v0.0.1:platform:audit-retention-1",
      retentionDays: Math.max(1, Math.min(Number(input.retentionDays || DEFAULT_RETENTION_DAYS), 3650)),
      maxExportItems: Math.max(1, Math.min(Number(input.maxExportItems || DEFAULT_MAX_EXPORT_ITEMS), 10000)),
      updatedAt: nowIso(),
      updatedBy: redactOperationAuditValue(input.updatedBy || {})
    };
    fs.writeFileSync(retentionPolicyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    return policy;
  }

  function pruneExpired(input = {}) {
    const policy = input.retentionDays ? setRetentionPolicy(input) : getRetentionPolicy();
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare("DELETE FROM operation_audit_log WHERE created_at < ?").run(cutoff);
    return {
      policyVersion: policy.policyVersion,
      retentionDays: policy.retentionDays,
      cutoff,
      deletedCount: Number(result.changes || 0)
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
        producer: "licomesh-core-operation-audit",
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
