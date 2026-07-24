import { redactOperationAuditValue } from "@meshrix/foundation/security/operation-audit";
import { hashValue, executionResultSummary } from "./store-models.mjs";
import { nowIso, parseJson, randomId, stringifyJson } from "./store-utils.mjs";

const DEFAULT_METRIC_RETENTION_DAYS = 14;
const DEFAULT_MAX_TOOL_METRIC_ROWS = 100_000;
const DEFAULT_MAX_HTTP_METRIC_ROWS = 100_000;
const DEFAULT_METRIC_MAINTENANCE_INTERVAL = 256;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function metricRetentionPolicy(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    retentionDays: positiveInteger(
      source.retentionDays ?? process.env.MESHRIX_METRIC_RETENTION_DAYS,
      DEFAULT_METRIC_RETENTION_DAYS,
      3660
    ),
    maxToolMetricRows: positiveInteger(
      source.maxToolMetricRows ?? process.env.MESHRIX_MAX_TOOL_METRIC_ROWS,
      DEFAULT_MAX_TOOL_METRIC_ROWS
    ),
    maxHttpRequestMetricRows: positiveInteger(
      source.maxHttpRequestMetricRows ?? process.env.MESHRIX_MAX_HTTP_METRIC_ROWS,
      DEFAULT_MAX_HTTP_METRIC_ROWS
    ),
    maintenanceInterval: positiveInteger(
      source.maintenanceInterval,
      DEFAULT_METRIC_MAINTENANCE_INTERVAL,
      65_536
    )
  };
}

function isRoutineProbeMetricNoise(entry = {}) {
  const statusCode = Math.max(0, Number(entry.statusCode || 0));
  return ["GET", "HEAD"].includes(String(entry.method || "").toUpperCase()) &&
    String(entry.route || "") === "/api/healthz" &&
    statusCode >= 200 &&
    statusCode < 500 &&
    String(entry.completionStatus || "completed") === "completed";
}

const DELEGATED_CHILD_OPERATION_AUDIT_FIELDS = Object.freeze([
  "schemaVersion",
  "issuer",
  "binding",
  "delegatedSessionId",
  "delegatedTurnId",
  "delegatedSubjectId",
  "delegatedTargetId",
  "delegatedWorkspaceId",
  "delegatedMcpGrantId",
  "grantType",
  "grantBindingVerified",
  "missingRequestBindings",
  "requestBindingMismatches",
  "traceId",
  "parentOperationId",
  "operationId"
]);

function delegatedChildOperationAuditSummary(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const output = {};
  for (const field of DELEGATED_CHILD_OPERATION_AUDIT_FIELDS) {
    const current = value[field];
    if (Array.isArray(current)) {
      output[field] = current.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 16);
    } else if (typeof current === "boolean") {
      output[field] = current;
    } else {
      output[field] = String(current || "").trim();
    }
  }
  if (!output.delegatedMcpGrantId && !output.delegatedSessionId && !output.delegatedTurnId) {
    return null;
  }
  return output;
}

function resultSummaryForAudit(entry = {}) {
  const summary = executionResultSummary(entry);
  const redacted = redactOperationAuditValue(summary);
  const delegatedChildOperation = delegatedChildOperationAuditSummary(summary?.delegatedChildOperation);
  if (!delegatedChildOperation) {
    return redacted;
  }
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return {
      ...redacted,
      delegatedChildOperation
    };
  }
  return {
    value: redacted,
    delegatedChildOperation
  };
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function mapAuditRow(row) {
  return {
    toolExecutionId: row.tool_execution_id,
    traceId: row.trace_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    toolsetIds: parseJson(row.toolset_ids_json, []),
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    grantId: row.grant_id,
    agentId: row.agent_id,
    profileId: row.profile_id,
    operationId: row.operation_id,
    risk: row.risk,
    decision: row.decision,
    inputHash: row.input_hash,
    redactedInput: parseJson(row.redacted_input_json, {}),
    resultSummary: parseJson(row.result_summary_json, {}),
    status: row.status,
    errorCode: row.error_code,
    durationMs: row.duration_ms,
    policyDecisionId: row.policy_decision_id,
    approvalId: row.approval_id,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    ledgerEventId: row.ledger_event_id || "",
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export function createAuditStoreMethods(ctx) {
  const { db } = ctx;
  const proofSubstrate = ctx.proofSubstrate || null;
  const retention = metricRetentionPolicy(ctx.metricRetention);
  let metricWritesSinceMaintenance = retention.maintenanceInterval;

  function maintainMetricRetention() {
    metricWritesSinceMaintenance += 1;
    if (metricWritesSinceMaintenance < retention.maintenanceInterval) return;
    metricWritesSinceMaintenance = 0;
    const cutoff = new Date(
      Date.now() - retention.retentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const run = db.transaction(() => {
      db.prepare("DELETE FROM tool_metric_events WHERE created_at < ?").run(cutoff);
      db.prepare("DELETE FROM http_request_metric_events WHERE created_at < ?").run(cutoff);
      db.prepare(`
        DELETE FROM tool_metric_events
        WHERE metric_id IN (
          SELECT metric_id FROM tool_metric_events
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(retention.maxToolMetricRows);
      db.prepare(`
        DELETE FROM http_request_metric_events
        WHERE metric_id IN (
          SELECT metric_id FROM http_request_metric_events
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(retention.maxHttpRequestMetricRows);
    });
    run();
  }

  async function anchorPermissionAuditFact(entry = {}) {
    if (!proofSubstrate || typeof proofSubstrate.recordWorkspaceOperation !== "function") {
      return text(entry.ledgerEventId);
    }
    const kind = text(entry.kind, "tool_execution");
    const toolExecutionId = text(entry.toolExecutionId);
    const decisionId = text(entry.decisionId);
    const inputHash = text(entry.inputHash);
    const workspaceId = text(
      entry.workspaceId || entry.profileId || entry.grantId || "default",
      "default"
    );
    const envelope = await proofSubstrate.recordWorkspaceOperation({
      operationId: `operation-permission.audit.${kind}`,
      workspaceId: `operation-permission:${workspaceId}`,
      idempotencyKey: text(
        entry.idempotencyKey,
        `${kind}:${toolExecutionId || decisionId}:${text(entry.traceId)}:${inputHash || randomId("hash")}`
      ),
      subject: {
        type: "operation-permission-audit",
        toolId: text(entry.toolId),
        grantId: text(entry.grantId)
      },
      input: {
        kind,
        toolId: text(entry.toolId),
        operationId: text(entry.operationId),
        toolExecutionId,
        decisionId,
        inputHash,
        decision: text(entry.decision || entry.effect),
        reasonCode: text(entry.reasonCode),
        status: text(entry.status),
        risk: text(entry.risk)
      },
      policyEvidence: {
        kind,
        effect: text(entry.decision || entry.effect),
        reasonCode: text(entry.reasonCode),
        inputHash
      },
      workspaceEffectEvidence: {
        kind,
        toolExecutionId,
        decisionId,
        status: text(entry.status, "recorded")
      }
    });
    const ledgerEventId = text(envelope?.factRef?.ledgerEventId || envelope?.ledgerEventId);
    if (!ledgerEventId) {
      const error = new Error("Operation Permission audit anchoring did not produce a ledger event id.");
      error.code = "operation_permission_audit_anchor_missing";
      throw error;
    }
    return ledgerEventId;
  }

  async function provePermissionAuditInclusion(ledgerEventId = "", workspaceId = "default") {
    const eventId = text(ledgerEventId);
    if (!eventId) {
      return { ok: false, reason: "ledger_event_id_missing" };
    }
    if (typeof proofSubstrate?.proveWorkspaceMembership === "function") {
      const proof = await proofSubstrate.proveWorkspaceMembership({
        workspaceId: `operation-permission:${text(workspaceId, "default")}`,
        ledgerEventId: eventId
      });
      return {
        ok: proof?.ok !== false && proof?.exists !== false,
        proof,
        ledgerEventId: eventId
      };
    }
    if (typeof proofSubstrate?.getWorkspaceProjection === "function") {
      const projection = proofSubstrate.getWorkspaceProjection(`operation-permission:${text(workspaceId, "default")}`);
      return {
        ok: Boolean(projection),
        projection,
        ledgerEventId: eventId
      };
    }
    return { ok: Boolean(proofSubstrate), ledgerEventId: eventId };
  }

  function appendPolicyDecision(entry = {}) {
    const decisionId = entry.decisionId || randomId("policy");
    db.prepare(`
      INSERT INTO tool_policy_decisions (
        decision_id, tool_execution_id, trace_id, tool_id, grant_id, effect, reason_code,
        missing_scopes_json, missing_toolsets_json, evaluated_layers_json, ledger_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      String(entry.toolExecutionId || ""),
      String(entry.traceId || ""),
      String(entry.toolId || ""),
      String(entry.grantId || ""),
      String(entry.effect || ""),
      String(entry.reasonCode || ""),
      stringifyJson(entry.missingScopes || []),
      stringifyJson(entry.missingToolsets || []),
      stringifyJson(entry.evaluatedLayers || []),
      String(entry.ledgerEventId || ""),
      entry.createdAt || nowIso()
    );
    return { decisionId, ledgerEventId: String(entry.ledgerEventId || "") };
  }

  async function appendPolicyDecisionAnchored(entry = {}) {
    const ledgerEventId = text(entry.ledgerEventId) || await anchorPermissionAuditFact({
      ...entry,
      kind: "policy_decision",
      decision: entry.effect || entry.decision,
      status: "policy_recorded"
    });
    return appendPolicyDecision({ ...entry, ledgerEventId });
  }

  function appendExecution(entry = {}) {
    const redactedInput = entry.redactedInput || redactOperationAuditValue(entry.input || {});
    const resultSummary = resultSummaryForAudit(entry);
    const inputHash = String(entry.inputHash || hashValue(redactedInput));
    const toolExecutionId = String(entry.toolExecutionId || randomId("tool_exec"));
    db.prepare(`
      INSERT INTO tool_executions (
        tool_execution_id, trace_id, tool_id, tool_version, toolset_ids_json, subject_type,
        subject_id, grant_id, agent_id, profile_id, operation_id, risk, decision, input_hash,
        redacted_input_json, result_summary_json, status, error_code, duration_ms,
        policy_decision_id, approval_id, source_ip, user_agent, ledger_event_id, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolExecutionId,
      String(entry.traceId || ""),
      String(entry.toolId || ""),
      String(entry.toolVersion || ""),
      stringifyJson(entry.toolsetIds || []),
      String(entry.subjectType || ""),
      String(entry.subjectId || ""),
      String(entry.grantId || ""),
      String(entry.agentId || ""),
      String(entry.profileId || ""),
      String(entry.operationId || ""),
      String(entry.risk || ""),
      String(entry.decision || ""),
      inputHash,
      stringifyJson(redactedInput),
      stringifyJson(resultSummary),
      String(entry.status || ""),
      String(entry.errorCode || ""),
      Math.max(0, Number(entry.durationMs || 0)),
      String(entry.policyDecisionId || ""),
      String(entry.approvalId || ""),
      String(entry.sourceIp || ""),
      String(entry.userAgent || ""),
      String(entry.ledgerEventId || ""),
      String(entry.startedAt || nowIso()),
      String(entry.finishedAt || nowIso())
    );
    return {
      toolExecutionId,
      inputHash,
      ledgerEventId: String(entry.ledgerEventId || "")
    };
  }

  async function appendExecutionAnchored(entry = {}) {
    const redactedInput = entry.redactedInput || redactOperationAuditValue(entry.input || {});
    const inputHash = String(entry.inputHash || hashValue(redactedInput));
    const ledgerEventId = text(entry.ledgerEventId) || await anchorPermissionAuditFact({
      ...entry,
      kind: "tool_execution",
      inputHash,
      redactedInput: undefined,
      input: undefined
    });
    return appendExecution({
      ...entry,
      redactedInput,
      inputHash,
      ledgerEventId
    });
  }

  function appendMetric(entry = {}) {
    const durationMs = Math.max(0, Number(entry.durationMs || 0));
    const inputBytes = Math.max(0, Number(entry.inputBytes || 0));
    const resultBytes = Math.max(0, Number(entry.resultBytes || 0));
    const transferBytes = Math.max(0, Number(entry.transferBytes || inputBytes + resultBytes));
    const bytesPerSecond = durationMs > 0
      ? Number(((transferBytes * 1000) / durationMs).toFixed(2))
      : transferBytes;
    db.prepare(`
      INSERT INTO tool_metric_events (
        metric_id, trace_id, tool_id, grant_id, profile_id, status, risk, duration_ms,
        input_bytes, result_bytes, transfer_bytes, bytes_per_second, reason_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("metric"),
      String(entry.traceId || ""),
      String(entry.toolId || ""),
      String(entry.grantId || ""),
      String(entry.profileId || ""),
      String(entry.status || ""),
      String(entry.risk || ""),
      durationMs,
      inputBytes,
      resultBytes,
      transferBytes,
      bytesPerSecond,
      String(entry.reasonCode || ""),
      entry.createdAt || nowIso()
    );
    maintainMetricRetention();
  }

  function appendHttpRequestMetric(entry = {}) {
    if (isRoutineProbeMetricNoise(entry)) return null;
    const durationMs = Math.max(0, Number(entry.durationMs || 0));
    const requestBytes = Math.max(0, Number(entry.requestBytes || 0));
    const responseBytes = Math.max(0, Number(entry.responseBytes || 0));
    const transferBytes = Math.max(0, Number(entry.transferBytes || requestBytes + responseBytes));
    const bytesPerSecond = durationMs > 0
      ? Number(((transferBytes * 1000) / durationMs).toFixed(2))
      : transferBytes;
    const result = db.prepare(`
      INSERT INTO http_request_metric_events (
        metric_id, trace_id, request_id, transport, method, route, status_code,
        completion_status, request_bytes, response_bytes, transfer_bytes,
        duration_ms, bytes_per_second, user_agent, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("http_metric"),
      String(entry.traceId || ""),
      String(entry.requestId || ""),
      String(entry.transport || "http"),
      String(entry.method || ""),
      String(entry.route || ""),
      Math.max(0, Number(entry.statusCode || 0)),
      String(entry.completionStatus || "completed"),
      requestBytes,
      responseBytes,
      transferBytes,
      durationMs,
      bytesPerSecond,
      String(entry.userAgent || "").slice(0, 512),
      entry.createdAt || nowIso()
    );
    maintainMetricRetention();
    return result;
  }

  function saveCatalogSnapshot(catalog = {}, { notify = true } = {}) {
    if (!catalog.fingerprint) {
      return null;
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO tool_catalog_snapshots (fingerprint, catalog_json, created_at)
      VALUES (?, ?, ?)
    `).run(catalog.fingerprint, stringifyJson(catalog), nowIso());
    if (notify !== false && result.changes > 0) {
      ctx.notifyChange({
        type: "catalog_snapshot_saved",
        reasonCode: "catalog_snapshot_saved",
        catalogFingerprint: String(catalog.fingerprint || "")
      });
    }
    return { fingerprint: catalog.fingerprint };
  }

  function listAudit({ limit = 100, toolId = "", grantId = "", status = "" } = {}) {
    const clauses = [];
    const params = [];
    if (toolId) {
      clauses.push("tool_id = ?");
      params.push(String(toolId));
    }
    if (grantId) {
      clauses.push("grant_id = ?");
      params.push(String(grantId));
    }
    if (status) {
      clauses.push("status = ?");
      params.push(String(status));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT * FROM tool_executions
      ${where}
      ORDER BY started_at DESC
      LIMIT ?
    `).all(...params, Math.max(1, Math.min(Number(limit || 100), 500)));
    return rows.map(mapAuditRow);
  }

  function getAudit(toolExecutionId) {
    const row = db.prepare("SELECT * FROM tool_executions WHERE tool_execution_id = ?").get(String(toolExecutionId || ""));
    if (!row) {
      return null;
    }
    return mapAuditRow(row);
  }

  maintainMetricRetention();

  return {
    anchorPermissionAuditFact,
    provePermissionAuditInclusion,
    appendPolicyDecision,
    appendPolicyDecisionAnchored,
    appendExecution,
    appendExecutionAnchored,
    appendMetric,
    appendHttpRequestMetric,
    saveCatalogSnapshot,
    listAudit,
    getAudit
  };
}
