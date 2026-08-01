import crypto from "node:crypto";
import path from "node:path";
import { openSqliteDatabase } from "../../storage/sqlite-database.ts";
import {
  ensurePrivateSqliteLocation,
  withPrivateFileCreationMask
} from "../../storage/private-sqlite.ts";
import { ServerConfig } from "#meshrix/server-config";

function nowIso() : any {
  return new Date().toISOString();
}

function stringifyJson(value?: any) : any {
  return JSON.stringify(value ?? null);
}

function parseJson(value?: any, fallback?: any) : any {
  try {
    const parsed: any = JSON.parse(value || "");
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function randomId(prefix?: any) : any {
  return `${prefix}_${crypto.randomUUID()}`;
}

function asLimit(value?: any, fallback: any = 100) : any {
  return Math.max(1, Math.min(Number(value || fallback) || fallback, 500));
}

function firstString(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function redactAuthorizationDecisionValue(value?: any, depth: any = 0, path: any = []) : any {
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
    return value.map((item?: any) : any => redactAuthorizationDecisionValue(item, depth + 1, path));
  }
  const output: Record<string, any> = {};
  for (const [key, nested] of (Object.entries(value) as [string, any][])) {
    const nextPath: any[] = [...path, key];
    const lowerKey: any = key.toLowerCase();
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

function subjectIdFrom(value: Record<string, any> = {}) : any {
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

function ensureSchema(db?: any) : any {
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
}

function rowToDecision(row?: any) : any {
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

function rowToReceipt(row?: any) : any {
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

function rowToLoanRecord(row?: any) : any {
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

function rowToDeniedRequest(row?: any) : any {
  return {
    deniedRequestId: row.denied_request_id,
    decisionId: row.decision_id,
    subjectId: row.subject_id,
    operationId: row.operation_id,
    toolId: row.tool_id,
    tenantId: row.tenant_id || "",
    workspaceId: row.workspace_id || "",
    reasonCode: row.reason_code,
    deniedRequest: parseJson(row.denied_json, {}),
    createdAt: row.created_at
  };
}

export function createAuthorizationStore({ userDataPath = "", rootPath = "" }: Record<string, any> = {}) : any {
  const resolvedRoot: any = rootPath ||
    path.join(userDataPath || ServerConfig.getDataDir(), "security", "authorization");
  const databasePath: any = ensurePrivateSqliteLocation(path.join(resolvedRoot, "authorization.sqlite"));
  let db: any = null;
  try {
    withPrivateFileCreationMask(() : any => {
      db = openSqliteDatabase(databasePath);
      ensureSchema(db);
      ensurePrivateSqliteLocation(databasePath);
    });
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while attempting local cleanup.
    }
    throw error;
  }
  let isClosed: any = false;

  function appendDeniedRequest(entry: Record<string, any> = {}) : any {
    const deniedRequest: any = entry.deniedRequest || entry;
    const storedDeniedRequest: any = redactAuthorizationDecisionValue(deniedRequest);
    const deniedRequestId: any = String(
      entry.deniedRequestId ||
        deniedRequest.deniedRequestId ||
        deniedRequest.auditId ||
        randomId("authz_denied")
    );
    db.prepare(`
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

  function appendDecision(decision: Record<string, any> = {}) : any {
    const decisionId: any = String(decision.decisionId || randomId("authz_decision"));
    const subject: any = decision.subject || {};
    const storedDecision: any = redactAuthorizationDecisionValue({ ...decision, decisionId });
    db.prepare(`
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
      const storedDeniedRequest: any = redactAuthorizationDecisionValue({ ...decision, decisionId });
      appendDeniedRequest({
        decisionId,
        subjectId: subject.subjectId || "",
        operationId: String(decision.operationId || decision.operation?.id || ""),
        toolId: String(decision.toolId || decision.tool?.id || ""),
        tenantId: firstString(decision.tenantId, decision.tenant?.resourceTenantId, decision.resource?.tenantId),
        workspaceId: firstString(decision.workspaceId, decision.abac?.workspaceId, decision.resource?.workspaceId),
        reasonCode: decision.reasonCode || "denied",
        deniedRequest: storedDeniedRequest
      });
    }
    return { decisionId };
  }

  function appendReceipt(receipt: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const receiptId: any = String(receipt.receiptId || options.receiptId || randomId("authz_receipt"));
    db.prepare(`
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

  function appendLoanRecord(loanRecord: Record<string, any> = {}, options: Record<string, any> = {}) : any {
    const loanRecordId: any = String(loanRecord.loanRecordId || options.loanRecordId || randomId("authz_loan"));
    db.prepare(`
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
  }: Record<string, any> = {}) : any {
    const clauses: any[] = [];
    const params: any[] = [];
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
    const where: any = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`
      SELECT * FROM authorization_decisions
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToDecision);
  }

  function listReceipts({ limit = 100, subjectId = "" }: Record<string, any> = {}) : any {
    const where: any = subjectId ? "WHERE subject_id = ?" : "";
    const params: any = subjectId ? [String(subjectId)] : [];
    return db.prepare(`
      SELECT * FROM authorization_receipts
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToReceipt);
  }

  function listLoanRecords({ limit = 100, subjectId = "" }: Record<string, any> = {}) : any {
    const where: any = subjectId ? "WHERE subject_id = ?" : "";
    const params: any = subjectId ? [String(subjectId)] : [];
    return db.prepare(`
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
  }: Record<string, any> = {}) : any {
    const clauses: any[] = [];
    const params: any[] = [];
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
    const where: any = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`
      SELECT * FROM authorization_denied_requests
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, asLimit(limit)).map(rowToDeniedRequest);
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
    close() : any {
      if (isClosed) {
        return;
      }
      isClosed = true;
      db.close();
    }
  };
}

let globalAuthorizationStore: any = null;

export function getGlobalAuthorizationStore() : any {
  if (!globalAuthorizationStore) {
    globalAuthorizationStore = createAuthorizationStore();
  }
  return globalAuthorizationStore;
}
