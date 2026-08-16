import crypto from "node:crypto";
import path from "node:path";
import { openSqliteDatabase } from "../../storage/sqlite-database.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../../storage/private-sqlite.ts";
import { ServerConfig } from "#meshrix/server-config";
import { runMigrations } from "../../storage/sqlite-migrations.ts";

interface EvidenceRecord extends Record<string, unknown> {
  subject?: EvidenceRecord;
  operation?: EvidenceRecord;
  tool?: EvidenceRecord;
  grant?: EvidenceRecord;
  tenant?: EvidenceRecord;
  resource?: EvidenceRecord;
  abac?: EvidenceRecord;
  deniedRequest?: EvidenceRecord;
}
interface EvidenceQuery extends Record<string, unknown> {
  limit?: unknown; subjectId?: unknown; operationId?: unknown; effect?: unknown;
  traceId?: unknown; tenantId?: unknown; workspaceId?: unknown;
  toolId?: unknown; reasonCode?: unknown;
}
interface SqliteResult { changes?: number }
interface SqliteStatement {
  all(...params: unknown[]): EvidenceRecord[];
  get(...params: unknown[]): EvidenceRecord | undefined;
  run(...params: unknown[]): SqliteResult;
}
interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(action: (input: EvidenceRecord) => T): (input: EvidenceRecord) => T;
  close(): void;
}

function evidenceRecord(value: unknown): EvidenceRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as EvidenceRecord
    : {};
}

function nowIso() {
  return new Date().toISOString();
}

function stringifyJson(value?: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): unknown | T {
  try {
    const parsed: unknown = JSON.parse(String(value || ""));
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function randomId(prefix?: unknown): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function asLimit(value?: unknown, fallback = 100): number {
  return Math.max(1, Math.min(Number(value || fallback) || fallback, 500));
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

const DENIED_REFERENCE_SCHEMA = "authorization_decisions.decision_json";

let deniedReferenceWrites = 0;
let deniedReferencesResolved = 0;
let deniedDuplicateRowsRemoved = 0;
let deniedRowsConverted = 0;

function migrateAuthorizationDeniedReferences(db: SqliteDatabase): void {
  const duplicateGroups = db.prepare(`
    SELECT decision_id
    FROM authorization_denied_requests
    WHERE decision_id <> ''
    GROUP BY decision_id
    HAVING COUNT(*) > 1
  `).all();
  for (const group of duplicateGroups) {
    const rows = db.prepare(`
      SELECT subject_id, operation_id, tool_id, tenant_id, workspace_id, reason_code
      FROM authorization_denied_requests
      WHERE decision_id = ?
    `).all(group.decision_id);
    const uniqueProjectionCount = new Set(rows.map((row) => JSON.stringify(row))).size;
    if (uniqueProjectionCount !== 1) {
      throw new Error("Authorization denial migration found conflicting decision projections.");
    }
  }
  const deleteResult = db.prepare(`
    DELETE FROM authorization_denied_requests
    WHERE decision_id <> ''
      AND EXISTS (
        SELECT 1 FROM authorization_denied_requests AS duplicate
        WHERE duplicate.decision_id = authorization_denied_requests.decision_id
          AND (
            duplicate.created_at < authorization_denied_requests.created_at
            OR (
              duplicate.created_at = authorization_denied_requests.created_at
              AND duplicate.rowid < authorization_denied_requests.rowid
            )
          )
      )
  `).run();
  deniedDuplicateRowsRemoved += Number(deleteResult.changes || 0);
  const updateResult = db.prepare(`
    UPDATE authorization_denied_requests AS denied
    SET denied_json = json_object(
      'decisionId', denied.decision_id,
      'reference', 'authorization_decisions.decision_json',
      'redacted', json('true')
    )
    WHERE denied.decision_id <> ''
      AND (json_valid(denied.denied_json) = 0 OR json_extract(denied.denied_json, '$.reference') IS NULL)
      AND EXISTS (
        SELECT 1 FROM authorization_decisions AS canonical
        WHERE canonical.decision_id = denied.decision_id
          AND canonical.decision_json <> ''
          AND canonical.decision_json = denied.denied_json
      )
  `).run();
  deniedRowsConverted += Number(updateResult.changes || 0);
  const unconverted = db.prepare(`
    SELECT denied.denied_request_id
    FROM authorization_denied_requests AS denied
    WHERE denied.decision_id <> ''
      AND EXISTS (
        SELECT 1 FROM authorization_decisions AS canonical
        WHERE canonical.decision_id = denied.decision_id
      )
      AND (
        json_valid(denied.denied_json) = 0
        OR json_extract(denied.denied_json, '$.reference') IS NULL
        OR json_extract(denied.denied_json, '$.reference') <> ?
      )
    LIMIT 1
  `).get(DENIED_REFERENCE_SCHEMA);
  if (unconverted) {
    throw new Error("Authorization denial migration could not verify a canonical decision reference.");
  }
}

function redactAuthorizationDecisionValue(value?: unknown, depth = 0, path: string[] = []): unknown {
  if (depth > 8) {
    return "<redacted-depth>";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/ock_[A-Za-z0-9_-]+/g, "<redacted-capability-key>");
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAuthorizationDecisionValue(item, depth + 1, path));
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    const lowerKey = key.toLowerCase();
    if (/token|secret|password|authorization|cookie|api[-_]?key|csrf/i.test(key)) {
      output[key] = "<redacted>";
    } else if (["keyhash", "capabilitysethash", "runtimelookupkeybase64", "bindinglookupkeybase64"].includes(lowerKey)) {
      output[key] = "<redacted>";
    } else if (
      key === "subjectCapabilities" ||
      (key === "capabilities" && nextPath.includes("subject"))
    ) {
      output[key] = {
        redacted: true,
        count: Array.isArray(nested) ? nested.length : 0
      };
    } else {
      output[key] = redactAuthorizationDecisionValue(nested, depth + 1, nextPath);
    }
  }
  return output;
}

function subjectIdFrom(value: EvidenceRecord = {}) {
  return String(
    value.subjectId ||
      value.userId ||
      value.username ||
      value.id ||
      value.subject?.subjectId ||
      value.subject?.id ||
      ""
  );
}

function ensureSchema(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS authorization_decisions (
      decision_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL DEFAULT '',
      subject_type TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL DEFAULT '',
      tool_id TEXT NOT NULL DEFAULT '',
      grant_id TEXT NOT NULL DEFAULT '',
      tenant_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      data_class TEXT NOT NULL DEFAULT '',
      requested_egress TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      effect TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL DEFAULT '',
      missing_scopes_json TEXT NOT NULL DEFAULT '[]',
      missing_toolsets_json TEXT NOT NULL DEFAULT '[]',
      required_scopes_json TEXT NOT NULL DEFAULT '[]',
      evaluated_layers_json TEXT NOT NULL DEFAULT '[]',
      decision_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorization_receipts (
      receipt_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      access_mode TEXT NOT NULL DEFAULT '',
      receipt_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorization_loan_records (
      loan_record_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL DEFAULT '',
      decision_id TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      access_mode TEXT NOT NULL DEFAULT '',
      loan_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorization_denied_requests (
      denied_request_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL DEFAULT '',
      tool_id TEXT NOT NULL DEFAULT '',
      tenant_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL DEFAULT '',
      denied_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_authorization_decisions_created ON authorization_decisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_authorization_decisions_trace ON authorization_decisions(trace_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_decisions_subject ON authorization_decisions(subject_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_decisions_tenant ON authorization_decisions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_decisions_workspace ON authorization_decisions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_decisions_operation ON authorization_decisions(operation_id);
    CREATE INDEX IF NOT EXISTS idx_authorization_receipts_created ON authorization_receipts(created_at);
    CREATE INDEX IF NOT EXISTS idx_authorization_loans_created ON authorization_loan_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_authorization_denied_created ON authorization_denied_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_authorization_denied_tenant ON authorization_denied_requests(tenant_id);
  `);

  runMigrations(db, [
    {
      version: 1,
      up: (d: SqliteDatabase) => {
        migrateAuthorizationDeniedReferences(d);
      }
    },
    {
      version: 2,
      up: (d: SqliteDatabase) => {
        migrateAuthorizationDeniedReferences(d);
        d.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_authorization_denied_decision_unique
          ON authorization_denied_requests(decision_id)
          WHERE decision_id <> ''
        `);
      }
    }
  ]);
}

function rowToDecision(row: EvidenceRecord) {
  return {
    decisionId: row.decision_id,
    traceId: row.trace_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    operationId: row.operation_id,
    toolId: row.tool_id,
    grantId: row.grant_id,
    tenantId: row.tenant_id || "",
    workspaceId: row.workspace_id || "",
    dataClass: row.data_class || "",
    requestedEgress: row.requested_egress || "",
    action: row.action,
    effect: row.effect,
    reasonCode: row.reason_code,
    missingScopes: parseJson(row.missing_scopes_json, []),
    missingToolsets: parseJson(row.missing_toolsets_json, []),
    requiredScopes: parseJson(row.required_scopes_json, []),
    evaluatedLayers: parseJson(row.evaluated_layers_json, []),
    decision: parseJson(row.decision_json, {}),
    createdAt: row.created_at
  };
}

function rowToReceipt(row: EvidenceRecord) {
  return {
    receiptId: row.receipt_id,
    decisionId: row.decision_id,
    subjectId: row.subject_id,
    workspaceId: row.workspace_id,
    accessMode: row.access_mode,
    receipt: parseJson(row.receipt_json, {}),
    createdAt: row.created_at
  };
}

function rowToLoanRecord(row: EvidenceRecord) {
  return {
    loanRecordId: row.loan_record_id,
    receiptId: row.receipt_id,
    decisionId: row.decision_id,
    subjectId: row.subject_id,
    workspaceId: row.workspace_id,
    accessMode: row.access_mode,
    loanRecord: parseJson(row.loan_json, {}),
    createdAt: row.created_at
  };
}

function rowToDeniedRequest(row: EvidenceRecord): EvidenceRecord {
  return {
    deniedRequestId: row.denied_request_id,
    decisionId: row.decision_id,
    subjectId: row.subject_id,
    operationId: row.operation_id,
    toolId: row.tool_id,
    tenantId: row.tenant_id || "",
    workspaceId: row.workspace_id || "",
    reasonCode: row.reason_code,
    deniedRequest: evidenceRecord(parseJson(row.denied_json, {})),
    createdAt: row.created_at
  };
}

export function createAuthorizationStoreWorkerOwner({ userDataPath = "", rootPath = "" }: { userDataPath?: string; rootPath?: string } = {}) {
  const resolvedRoot = rootPath ||
    path.join(userDataPath || ServerConfig.getDataDir(), "security", "authorization");
  const databasePath = ensurePrivateSqliteLocation(path.join(resolvedRoot, "authorization.sqlite"));
  let db: SqliteDatabase | undefined;
  try {
    withPrivateFileCreationMask(() => {
      const openedDatabase: SqliteDatabase = openSqliteDatabase(databasePath);
      db = openedDatabase;
      ensureSchema(openedDatabase);
      ensurePrivateSqliteLocation(databasePath);
    });
  } catch (error) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while attempting local cleanup.
    }
    throw error;
  }
  if (!db) {
    throw new Error("Authorization evidence storage initialization failed.");
  }
  const database = db;
  const statement = (sql: string): SqliteStatement => database.prepare(sql);
  let isClosed = false;

  function appendDeniedRequest(entry: EvidenceRecord = {}) {
    const deniedRequest = entry.deniedRequest || entry;
    const storedDeniedRequest = redactAuthorizationDecisionValue(deniedRequest);
    const deniedRequestId = String(
      entry.deniedRequestId ||
        deniedRequest.deniedRequestId ||
        deniedRequest.auditId ||
        randomId("authz_denied")
    );
    statement(`
      INSERT INTO authorization_denied_requests (
        denied_request_id, decision_id, subject_id, operation_id, tool_id, tenant_id, workspace_id, reason_code, denied_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deniedRequestId,
      String(entry.decisionId || deniedRequest.decisionId || ""),
      String(entry.subjectId || subjectIdFrom(deniedRequest.subject || deniedRequest) || ""),
      String(entry.operationId || deniedRequest.operationId || ""),
      String(entry.toolId || deniedRequest.toolId || ""),
      firstString(entry.tenantId, deniedRequest.tenantId, deniedRequest.tenant?.resourceTenantId, deniedRequest.resource?.tenantId),
      firstString(entry.workspaceId, deniedRequest.workspaceId, deniedRequest.abac?.workspaceId, deniedRequest.resource?.workspaceId),
      String(entry.reasonCode || deniedRequest.reasonCode || deniedRequest.filteredReason || "denied"),
      stringifyJson(storedDeniedRequest),
      String(entry.createdAt || deniedRequest.createdAt || nowIso())
    );
    return { deniedRequestId };
  }

  const appendDecisionTransaction = database.transaction((decision: EvidenceRecord = {}) => {
    const decisionId = String(decision.decisionId || randomId("authz_decision"));
    const subject = decision.subject || {};
    const storedDecision = redactAuthorizationDecisionValue({ ...decision, decisionId });
    statement(`
      INSERT INTO authorization_decisions (
        decision_id, trace_id, subject_type, subject_id, operation_id, tool_id, grant_id, action,
        tenant_id, workspace_id, data_class, requested_egress, effect, reason_code,
        missing_scopes_json, missing_toolsets_json, required_scopes_json,
        evaluated_layers_json, decision_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      String(decision.traceId || ""),
      String(subject.type || decision.subjectType || ""),
      String(subject.subjectId || decision.subjectId || ""),
      String(decision.operationId || decision.operation?.id || ""),
      String(decision.toolId || decision.tool?.id || ""),
      String(decision.grantId || decision.grant?.id || ""),
      String(decision.action || ""),
      firstString(decision.tenantId, decision.tenant?.resourceTenantId, decision.resource?.tenantId),
      firstString(decision.workspaceId, decision.abac?.workspaceId, decision.resource?.workspaceId),
      firstString(decision.dataClass, decision.abac?.dataClass, decision.resource?.dataClass),
      firstString(decision.requestedEgress, decision.abac?.requestedEgress),
      String(decision.effect || ""),
      String(decision.reasonCode || ""),
      stringifyJson(decision.missingScopes || []),
      stringifyJson(decision.missingToolsets || []),
      stringifyJson(decision.requiredScopes || []),
      stringifyJson(decision.evaluatedLayers || []),
      stringifyJson(storedDecision),
      String(decision.createdAt || nowIso())
    );
    if (decision.allowed === false || decision.effect === "deny") {
      deniedReferenceWrites += 1;
      appendDeniedRequest({
        decisionId,
        subjectId: subject.subjectId || "",
        operationId: String(decision.operationId || decision.operation?.id || ""),
        toolId: String(decision.toolId || decision.tool?.id || ""),
        tenantId: firstString(decision.tenantId, decision.tenant?.resourceTenantId, decision.resource?.tenantId),
        workspaceId: firstString(decision.workspaceId, decision.abac?.workspaceId, decision.resource?.workspaceId),
        reasonCode: decision.reasonCode || "denied",
        deniedRequest: {
          decisionId,
          reference: DENIED_REFERENCE_SCHEMA,
          redacted: true
        }
      });
    }
    return { decisionId };
  });

  function appendDecision(decision: EvidenceRecord = {}) {
    return appendDecisionTransaction(decision);
  }

  function appendReceipt(receipt: EvidenceRecord = {}, options: EvidenceRecord = {}) {
    const receiptId = String(receipt.receiptId || options.receiptId || randomId("authz_receipt"));
    statement(`
      INSERT INTO authorization_receipts (
        receipt_id, decision_id, subject_id, workspace_id, access_mode, receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      String(options.decisionId || receipt.decisionId || ""),
      String(options.subjectId || subjectIdFrom(receipt.subject || receipt) || ""),
      String(options.workspaceId || receipt.workspaceId || ""),
      String(options.accessMode || receipt.accessMode || ""),
      stringifyJson({ ...receipt, receiptId }),
      String(options.createdAt || receipt.createdAt || nowIso())
    );
    return { receiptId };
  }

  function appendLoanRecord(loanRecord: EvidenceRecord = {}, options: EvidenceRecord = {}) {
    const loanRecordId = String(loanRecord.loanRecordId || options.loanRecordId || randomId("authz_loan"));
    statement(`
      INSERT INTO authorization_loan_records (
        loan_record_id, receipt_id, decision_id, subject_id, workspace_id, access_mode, loan_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      loanRecordId,
      String(options.receiptId || loanRecord.receiptId || ""),
      String(options.decisionId || loanRecord.decisionId || ""),
      String(options.subjectId || subjectIdFrom(loanRecord.subject || loanRecord) || ""),
      String(options.workspaceId || loanRecord.workspaceId || ""),
      String(options.accessMode || loanRecord.accessMode || ""),
      stringifyJson({ ...loanRecord, loanRecordId }),
      String(options.createdAt || loanRecord.createdAt || loanRecord.issuedAt || nowIso())
    );
    return { loanRecordId };
  }

  function listDecisions({
    limit = 100,
    subjectId = "",
    operationId = "",
    effect = "",
    traceId = "",
    tenantId = "",
    workspaceId = ""
  }: EvidenceQuery = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (subjectId) {
      clauses.push("subject_id = ?");
      params.push(String(subjectId));
    }
    if (operationId) {
      clauses.push("operation_id = ?");
      params.push(String(operationId));
    }
    if (effect) {
      clauses.push("effect = ?");
      params.push(String(effect));
    }
    if (traceId) {
      clauses.push("trace_id = ?");
      params.push(String(traceId));
    }
    if (tenantId) {
      clauses.push("tenant_id = ?");
      params.push(String(tenantId));
    }
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(String(workspaceId));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return statement(`
      SELECT * FROM authorization_decisions
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToDecision);
  }

  function listReceipts({ limit = 100, subjectId = "" }: EvidenceQuery = {}) {
    const where = subjectId ? "WHERE subject_id = ?" : "";
    const params = subjectId ? [String(subjectId)] : [];
    return statement(`
      SELECT * FROM authorization_receipts
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToReceipt);
  }

  function listLoanRecords({ limit = 100, subjectId = "" }: EvidenceQuery = {}) {
    const where = subjectId ? "WHERE subject_id = ?" : "";
    const params = subjectId ? [String(subjectId)] : [];
    return statement(`
      SELECT * FROM authorization_loan_records
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToLoanRecord);
  }

  function listDeniedRequests({
    limit = 100,
    subjectId = "",
    tenantId = "",
    workspaceId = "",
    operationId = "",
    toolId = "",
    reasonCode = ""
  }: EvidenceQuery = {}) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (subjectId) {
      clauses.push("subject_id = ?");
      params.push(String(subjectId));
    }
    if (tenantId) {
      clauses.push("tenant_id = ?");
      params.push(String(tenantId));
    }
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(String(workspaceId));
    }
    if (operationId) {
      clauses.push("operation_id = ?");
      params.push(String(operationId));
    }
    if (toolId) {
      clauses.push("tool_id = ?");
      params.push(String(toolId));
    }
    if (reasonCode) {
      clauses.push("reason_code = ?");
      params.push(String(reasonCode));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const resolveDeniedRequest = (entry: EvidenceRecord = {}) => {
      const stored = entry.deniedRequest || {};
      if (
        stored.reference !== DENIED_REFERENCE_SCHEMA ||
        !entry.decisionId
      ) {
        return stored;
      }
      const canonical = statement(
        "SELECT decision_json FROM authorization_decisions WHERE decision_id = ?"
      ).get(String(entry.decisionId));
      deniedReferencesResolved += 1;
      return canonical ? parseJson(canonical.decision_json, stored) : stored;
    };
    return statement(`
      SELECT * FROM authorization_denied_requests
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToDeniedRequest).map((entry) => ({
      ...entry,
      deniedRequest: resolveDeniedRequest(entry)
    }));
  }

  return {
    db,
    rootPath: resolvedRoot,
    appendDecision,
    appendReceipt,
    appendLoanRecord,
    appendDeniedRequest,
    listDecisions,
    listReceipts,
    listLoanRecords,
    listDeniedRequests,
    getRefactorInstrumentation: () => ({
      schemaVersion: "v0.0.1:risk-control:authorization-denied-reference-store-1",
      deniedReferenceWrites,
      deniedReferencesResolved,
      deniedDuplicateRowsRemoved,
      deniedRowsConverted
    }),
    close() {
      if (isClosed) {
        return;
      }
      isClosed = true;
      database.close();
    }
  };
}
