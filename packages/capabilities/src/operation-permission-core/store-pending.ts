import { redactOperationAuditValue } from "@meshrix/foundation/security/operation-audit";
import { rowToPendingOperation } from "./store-models.ts";
import {
  normalizePendingOperationStatus,
  nowIso,
  randomId,
  stringifyJson
} from "./store-utils.ts";

function pendingCredentialAuthorization(value: any): any {
  if (!value) return {};
  if (value?.credentialKind !== "scoped_api_key") {
    throw new TypeError("Pending credential authorization must be a scoped API Key snapshot.");
  }
  const snapshot: Record<string, any> = {
    credentialKind: "scoped_api_key",
    keyId: String(value.keyId || "").trim(),
    workloadPrincipalId: String(value.workloadPrincipalId || "").trim(),
    organizationNodeId: String(value.organizationNodeId || "").trim(),
    lifecycleRevision: Number(value.lifecycleRevision || 0),
    policyFingerprint: String(value.policyFingerprint || "").trim(),
    policy: value.policy && typeof value.policy === "object" && !Array.isArray(value.policy)
      ? JSON.parse(JSON.stringify(value.policy))
      : null
  };
  if (!snapshot.keyId || !snapshot.workloadPrincipalId || !snapshot.organizationNodeId ||
      !Number.isSafeInteger(snapshot.lifecycleRevision) || snapshot.lifecycleRevision < 1 ||
      !snapshot.policyFingerprint || !snapshot.policy) {
    throw new TypeError("Pending API Key authorization snapshot is incomplete.");
  }
  return snapshot;
}

export function createPendingStoreMethods(ctx?: any) : any {
  const { db } = ctx;

  function approvalRequirements(entry: Record<string, any> = {}) : any {
    const requiredApproval: any = entry.requiredApproval && typeof entry.requiredApproval === "object" && !Array.isArray(entry.requiredApproval)
      ? entry.requiredApproval
      : {};
    const approvalLayers: any[] = [...new Set<any>([]
      .concat(requiredApproval.approvalLayers || [])
      .map((item?: any) : any => String(item || "").trim())
      .filter(Boolean))];
    const redactedApproval = redactOperationAuditValue(requiredApproval);
    return {
      requiredApproval: {
        ...(redactedApproval && typeof redactedApproval === "object" && !Array.isArray(redactedApproval)
          ? redactedApproval
          : {}),
        ...(approvalLayers.length ? { approvalLayers } : {})
      },
      approvalLayers
    };
  }

  function expirePendingOperations(now: any = nowIso()) : any {
    db.prepare(`
      UPDATE tool_pending_operations
      SET status = 'expired', completed_at = ?, error_code = 'pending_operation_expired'
      WHERE status = 'pending'
        AND expires_at <> ''
        AND expires_at <= ?
    `).run(now, now);
  }

  function createPendingOperation(entry: Record<string, any> = {}) : any {
    const pendingOperationId: any = String(entry.pendingOperationId || randomId("pending_op"));
    const createdAt: any = entry.createdAt || nowIso();
    const expiresAt: any = String(entry.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString());
    const resumeInput: any = entry.resumeInput || entry.originalInput || entry.input || {};
    const originalInput: any = redactOperationAuditValue(resumeInput);
    const redactedInput: any = entry.redactedInput || redactOperationAuditValue(entry.input || entry.originalInput || {});
    const redactedContext: any = redactOperationAuditValue(entry.context || {});
    const credentialAuthorization: any = pendingCredentialAuthorization(entry.credentialAuthorization);
    const approval: any = approvalRequirements(entry);
    db.prepare(`
      INSERT INTO tool_pending_operations (
        pending_operation_id, trace_id, tool_execution_id, tool_id, tool_version,
        toolset_ids_json, operation_id, risk, approval_scope, approval_requirements_json,
        approval_layers_json, grant_id, agent_id,
        profile_id, idempotency_key, reason_code, risk_reason, original_input_json,
        resume_input_json, credential_authorization_json, redacted_input_json, context_json,
        status, source_ip, user_agent, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pendingOperationId,
      String(entry.traceId || ""),
      String(entry.toolExecutionId || ""),
      String(entry.toolId || ""),
      String(entry.toolVersion || ""),
      stringifyJson(entry.toolsetIds || []),
      String(entry.operationId || ""),
      String(entry.risk || ""),
      String(entry.approvalScope || ""),
      stringifyJson(approval.requiredApproval),
      stringifyJson(approval.approvalLayers),
      String(entry.grantId || ""),
      String(entry.agentId || ""),
      String(entry.profileId || ""),
      String(entry.idempotencyKey || ""),
      String(entry.reasonCode || "approval_required"),
      String(entry.riskReason || ""),
      stringifyJson(originalInput),
      stringifyJson(resumeInput),
      stringifyJson(credentialAuthorization),
      stringifyJson(redactedInput),
      stringifyJson(redactedContext),
      "pending",
      String(entry.sourceIp || ""),
      String(entry.userAgent || ""),
      expiresAt,
      createdAt
    );
    return getPendingOperation(pendingOperationId);
  }

  function getPendingOperation(pendingOperationId?: any, { includeOriginalInput = false }: Record<string, any> = {}) : any {
    expirePendingOperations();
    const row: any = db.prepare("SELECT * FROM tool_pending_operations WHERE pending_operation_id = ?")
      .get(String(pendingOperationId || ""));
    return rowToPendingOperation(row, { includeOriginalInput });
  }

  function listPendingOperations({ status = "pending", limit = 100 }: Record<string, any> = {}) : any {
    expirePendingOperations();
    const normalizedLimit: any = Math.max(1, Math.min(Number(limit || 100) || 100, 1000));
    const normalizedStatus: any = String(status || "pending").trim();
    const rows: any = normalizedStatus === "all"
      ? db.prepare("SELECT * FROM tool_pending_operations ORDER BY created_at DESC LIMIT ?").all(normalizedLimit)
      : db.prepare("SELECT * FROM tool_pending_operations WHERE status = ? ORDER BY created_at DESC LIMIT ?")
        .all(normalizePendingOperationStatus(normalizedStatus), normalizedLimit);
    return rows.map((row?: any) : any => rowToPendingOperation(row));
  }

  function resolvePendingOperation({
    pendingOperationId,
    resolution,
    resolvedBy = "",
    reason = "",
    resultSummary = {},
    errorCode = "",
    resumedToolExecutionId = "",
    requiredApproval = null
  }: Record<string, any> = {}) : any {
    expirePendingOperations();
    const normalizedResolution: any = normalizePendingOperationStatus(resolution);
    if (![
      "approved",
      "rejected",
      "cancelled",
      "completed",
      "failed",
      "payload_mismatch",
      "replayed"
    ].includes(normalizedResolution)) {
      throw new Error("Invalid pending operation resolution status.");
    }
    const timestamp: any = nowIso();
    const completedAt: any = [
      "rejected",
      "cancelled",
      "completed",
      "failed",
      "payload_mismatch",
      "replayed"
    ].includes(normalizedResolution) ? timestamp : "";
    const sourceStatuses: any = normalizedResolution === "approved"
      ? ["pending"]
      : ["pending", "approved"];
    const sourceStatusPlaceholders: any = sourceStatuses.map(() : any => "?").join(", ");
    const info: any = db.prepare(`
      UPDATE tool_pending_operations
      SET status = ?,
          resolved_at = CASE WHEN resolved_at = '' THEN ? ELSE resolved_at END,
          resolved_by = CASE WHEN ? <> '' THEN ? ELSE resolved_by END,
          resolution_reason = CASE WHEN ? <> '' THEN ? ELSE resolution_reason END,
          result_summary_json = CASE WHEN ? <> '{}' THEN ? ELSE result_summary_json END,
          error_code = CASE WHEN ? <> '' THEN ? ELSE error_code END,
          resumed_tool_execution_id = CASE WHEN ? <> '' THEN ? ELSE resumed_tool_execution_id END,
          approval_requirements_json = CASE WHEN ? <> '' THEN ? ELSE approval_requirements_json END,
          completed_at = CASE WHEN ? <> '' THEN ? ELSE completed_at END
      WHERE pending_operation_id = ? AND status IN (${sourceStatusPlaceholders})
    `).run(
      normalizedResolution,
      timestamp,
      String(resolvedBy || ""),
      String(resolvedBy || ""),
      String(reason || ""),
      String(reason || ""),
      stringifyJson(resultSummary || {}),
      stringifyJson(resultSummary || {}),
      String(errorCode || ""),
      String(errorCode || ""),
      String(resumedToolExecutionId || ""),
      String(resumedToolExecutionId || ""),
      requiredApproval ? stringifyJson(approvalRequirements({ requiredApproval }).requiredApproval) : "",
      requiredApproval ? stringifyJson(approvalRequirements({ requiredApproval }).requiredApproval) : "",
      completedAt,
      completedAt,
      String(pendingOperationId || ""),
      ...sourceStatuses
    );
    if (info.changes <= 0) {
      return null;
    }
    return getPendingOperation(pendingOperationId);
  }

  return {
    expirePendingOperations,
    createPendingOperation,
    getPendingOperation,
    listPendingOperations,
    resolvePendingOperation
  };
}
