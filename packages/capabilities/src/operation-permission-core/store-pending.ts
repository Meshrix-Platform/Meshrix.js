import { redactOperationAuditValue } from "@meshrix/foundation/security/operation-audit";
import { rowToPendingOperation } from "./store-models.ts";
import {
  normalizePendingOperationStatus,
  nowIso,
  parseJson,
  randomId,
  safeCompare,
  sourceIpFromRequest,
  stringifyJson
} from "./store-utils.ts";

const LOCAL_MCP_AUTHORIZATION_ACTIVE_LIMIT: any = 256;
const LOCAL_MCP_AUTHORIZATION_ACTIVE_BYTES_LIMIT: any = 2 * 1024 * 1024;
const LOCAL_MCP_AUTHORIZATION_ISSUE_LEASE_MS: any = 15 * 60 * 1000;
const LOCAL_MCP_AUTHORIZATION_PAYLOAD_BYTES_LIMIT: any = 64 * 1024;
const LOCAL_MCP_AUTHORIZATION_REPLAY_BYTES_LIMIT: any = 512 * 1024;
const LOCAL_MCP_AUTHORIZATION_REPLAY_TOTAL_BYTES_LIMIT: any = 4 * 1024 * 1024;
const LOCAL_MCP_AUTHORIZATION_REPLAY_MAX_TTL_MS: any = 5 * 60 * 1000;
const LOCAL_MCP_AUTHORIZATION_SOURCE_LIMIT: any = 16;
const LOCAL_MCP_AUTHORIZATION_SOURCE_BYTES_LIMIT: any = 512 * 1024;
const LOCAL_MCP_AUTHORIZATION_RETAINED_LIMIT: any = 2_048;
const LOCAL_MCP_AUTHORIZATION_RETAINED_BYTES_LIMIT: any = 32 * 1024 * 1024;
const LOCAL_MCP_AUTHORIZATION_RETENTION_MS: any = 24 * 60 * 60 * 1000;

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
    return {
      requiredApproval: {
        ...redactOperationAuditValue(requiredApproval),
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
    const approval: any = approvalRequirements(entry);
    db.prepare(`
      INSERT INTO tool_pending_operations (
        pending_operation_id, trace_id, tool_execution_id, tool_id, tool_version,
        toolset_ids_json, operation_id, risk, approval_scope, approval_requirements_json,
        approval_layers_json, grant_id, agent_id,
        profile_id, idempotency_key, reason_code, risk_reason, original_input_json,
        resume_input_json, redacted_input_json, context_json, status, source_ip, user_agent, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  function createMcpAuthorizationRequest(input: Record<string, any> = {}) : any {
    const requestId: any = randomId("mcp_auth_req");
    const sourceIp: any = sourceIpFromRequest(input.request);
    const createdAt: any = String(input.createdAt || nowIso());
    const expiresAt: any = String(input.expiresAt || "");
    const requestKind: any = String(input.requestKind || "generic");
    const clientName: any = String(input.clientName || "");
    const reason: any = String(input.reason || "");
    const requestedScopesJson: any = stringifyJson(input.requestedScopes || []);
    const requestedToolsJson: any = stringifyJson(input.requestedTools || []);
    const requestPayloadJson: any = stringifyJson(input.requestPayload || {});
    const persistedRequestBytes: any = Buffer.byteLength(
      `${clientName}\0${reason}\0${requestedScopesJson}\0${requestedToolsJson}\0${requestPayloadJson}`,
      "utf8"
    );
    expireMcpAuthorizationRequests(createdAt);
    if (requestKind === "local_mcp_install") {
      if (persistedRequestBytes > LOCAL_MCP_AUTHORIZATION_PAYLOAD_BYTES_LIMIT) {
        throw new Error("local_mcp_authorization_payload_too_large");
      }
      const retentionCutoff: any = new Date(Date.parse(createdAt) - LOCAL_MCP_AUTHORIZATION_RETENTION_MS).toISOString();
      db.prepare(`
        DELETE FROM mcp_authorization_requests
        WHERE request_kind = 'local_mcp_install'
          AND status IN ('rejected', 'expired', 'consumed', 'failed')
          AND created_at < ?
      `).run(retentionCutoff);
      const retainedUsage: any = db.prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(
            length(CAST(request_payload_json AS BLOB)) +
            length(CAST(requested_scopes_json AS BLOB)) +
            length(CAST(requested_tools_json AS BLOB)) +
            length(CAST(client_name AS BLOB)) +
            length(CAST(reason AS BLOB)) +
            length(CAST(replay_envelope_json AS BLOB))
          ), 0) AS bytes
        FROM mcp_authorization_requests
        WHERE request_kind = 'local_mcp_install'
      `).get() || { count: 0, bytes: 0 };
      const requiredCountRemoval: any = Math.max(
        0,
        Number(retainedUsage.count || 0) + 1 - LOCAL_MCP_AUTHORIZATION_RETAINED_LIMIT
      );
      const requiredByteRemoval: any = Math.max(
        0,
        Number(retainedUsage.bytes || 0) + persistedRequestBytes - LOCAL_MCP_AUTHORIZATION_RETAINED_BYTES_LIMIT
      );
      if (requiredCountRemoval > 0 || requiredByteRemoval > 0) {
        const removableRows: any = db.prepare(`
          SELECT
            request_id,
            length(CAST(request_payload_json AS BLOB)) +
              length(CAST(requested_scopes_json AS BLOB)) +
              length(CAST(requested_tools_json AS BLOB)) +
              length(CAST(client_name AS BLOB)) +
              length(CAST(reason AS BLOB)) +
              length(CAST(replay_envelope_json AS BLOB)) AS bytes
          FROM mcp_authorization_requests
          WHERE request_kind = 'local_mcp_install'
            AND status IN ('rejected', 'expired', 'consumed', 'failed')
          ORDER BY created_at ASC
        `).all();
        const removableIds: any[] = [];
        let removableBytes: any = 0;
        for (const row of removableRows) {
          if (
            removableIds.length >= requiredCountRemoval &&
            removableBytes >= requiredByteRemoval
          ) {
            break;
          }
          removableIds.push(row.request_id);
          removableBytes += Number(row.bytes || 0);
        }
        if (removableIds.length > 0) {
          const placeholders: any = removableIds.map(() : any => "?").join(", ");
          db.prepare(`DELETE FROM mcp_authorization_requests WHERE request_id IN (${placeholders})`)
            .run(...removableIds);
        }
      }
      const boundedRetainedUsage: any = db.prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(
            length(CAST(request_payload_json AS BLOB)) +
            length(CAST(requested_scopes_json AS BLOB)) +
            length(CAST(requested_tools_json AS BLOB)) +
            length(CAST(client_name AS BLOB)) +
            length(CAST(reason AS BLOB)) +
            length(CAST(replay_envelope_json AS BLOB))
          ), 0) AS bytes
        FROM mcp_authorization_requests
        WHERE request_kind = 'local_mcp_install'
      `).get() || { count: 0, bytes: 0 };
      const activeUsage: any = db.prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(
            length(CAST(request_payload_json AS BLOB)) +
            length(CAST(requested_scopes_json AS BLOB)) +
            length(CAST(requested_tools_json AS BLOB)) +
            length(CAST(client_name AS BLOB)) +
            length(CAST(reason AS BLOB))
          ), 0) AS bytes
        FROM mcp_authorization_requests
        WHERE request_kind = 'local_mcp_install'
          AND status IN ('pending', 'approved', 'issuing')
      `).get() || { count: 0, bytes: 0 };
      const sourceUsage: any = db.prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(
            length(CAST(request_payload_json AS BLOB)) +
            length(CAST(requested_scopes_json AS BLOB)) +
            length(CAST(requested_tools_json AS BLOB)) +
            length(CAST(client_name AS BLOB)) +
            length(CAST(reason AS BLOB))
          ), 0) AS bytes
        FROM mcp_authorization_requests
        WHERE request_kind = 'local_mcp_install'
          AND source_ip = ?
          AND status IN ('pending', 'approved', 'issuing')
      `).get(sourceIp) || { count: 0, bytes: 0 };
      if (
        Number(boundedRetainedUsage.count || 0) >= LOCAL_MCP_AUTHORIZATION_RETAINED_LIMIT ||
        Number(boundedRetainedUsage.bytes || 0) + persistedRequestBytes > LOCAL_MCP_AUTHORIZATION_RETAINED_BYTES_LIMIT ||
        Number(activeUsage.count || 0) >= LOCAL_MCP_AUTHORIZATION_ACTIVE_LIMIT ||
        Number(activeUsage.bytes || 0) + persistedRequestBytes > LOCAL_MCP_AUTHORIZATION_ACTIVE_BYTES_LIMIT ||
        Number(sourceUsage.count || 0) >= LOCAL_MCP_AUTHORIZATION_SOURCE_LIMIT ||
        Number(sourceUsage.bytes || 0) + persistedRequestBytes > LOCAL_MCP_AUTHORIZATION_SOURCE_BYTES_LIMIT
      ) {
        throw new Error("local_mcp_authorization_capacity_exceeded");
      }
    }

    db.prepare(`
      INSERT INTO mcp_authorization_requests (
        request_id, client_name, requested_scopes_json, requested_tools_json,
        reason, request_kind, request_payload_json, claim_token_hash,
        status, source_ip, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      clientName,
      requestedScopesJson,
      requestedToolsJson,
      reason,
      requestKind,
      requestPayloadJson,
      String(input.claimTokenHash || ""),
      "pending",
      sourceIp,
      expiresAt,
      createdAt
    );

    return { requestId, status: "pending", createdAt, expiresAt };
  }

  function expireMcpAuthorizationRequests(now: any = nowIso()) : any {
    db.prepare(`
      UPDATE mcp_authorization_requests
      SET status = 'expired', error_code = 'authorization_request_expired'
      WHERE status IN ('pending', 'approved')
        AND expires_at <> ''
        AND expires_at <= ?
    `).run(now);
    const parsedNow: any = Date.parse(now);
    const staleIssueCutoff: any = new Date(
      (Number.isFinite(parsedNow) ? parsedNow : Date.now()) - LOCAL_MCP_AUTHORIZATION_ISSUE_LEASE_MS
    ).toISOString();
    db.prepare(`
      UPDATE mcp_authorization_requests
      SET status = 'failed', error_code = 'authorization_issue_interrupted'
      WHERE status = 'issuing'
        AND issuing_at <> ''
        AND issuing_at <= ?
    `).run(staleIssueCutoff);
    db.prepare(`
      UPDATE mcp_authorization_requests
      SET replay_envelope_json = '', replay_expires_at = ''
      WHERE replay_envelope_json <> ''
        AND replay_expires_at <> ''
        AND replay_expires_at <= ?
    `).run(now);
  }

  function projectMcpAuthorizationRequest(row?: any, { includePayload = false, includeReplay = false }: Record<string, any> = {}) : any {
    if (!row) {
      return null;
    }
    const requestPayload: any = parseJson(row.request_payload_json, {});
    const summary: any = requestPayload?.summary && typeof requestPayload.summary === "object"
      ? requestPayload.summary
      : {};
    return {
      requestId: row.request_id,
      requestKind: row.request_kind || "generic",
      clientName: row.client_name,
      requestedScopes: parseJson(row.requested_scopes_json, []),
      requestedTools: parseJson(row.requested_tools_json, []),
      reason: row.reason,
      status: row.status,
      sourceIp: row.source_ip,
      grantId: row.grant_id,
      grantIds: parseJson(row.grant_ids_json, []),
      targets: Array.isArray(summary.targets) ? summary.targets : [],
      toolsets: Array.isArray(summary.toolsets) ? summary.toolsets : [],
      maxRisk: String(summary.maxRisk || ""),
      verificationCode: String(summary.verificationCode || ""),
      processKeyFingerprints: Array.isArray(summary.processKeyFingerprints)
        ? summary.processKeyFingerprints
        : [],
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      issuingAt: row.issuing_at,
      consumedAt: row.consumed_at,
      errorCode: row.error_code,
      ...(includePayload ? { requestPayload } : {}),
      ...(includeReplay ? {
        replayEnvelope: String(row.replay_envelope_json || ""),
        replayExpiresAt: String(row.replay_expires_at || "")
      } : {})
    };
  }

  function getMcpAuthorizationRequest(requestId?: any, options: Record<string, any> = {}) : any {
    expireMcpAuthorizationRequests();
    const row: any = db.prepare("SELECT * FROM mcp_authorization_requests WHERE request_id = ?")
      .get(String(requestId || ""));
    return projectMcpAuthorizationRequest(row, options);
  }

  function normalizeMcpAuthorizationRequestStatus(value: any = "pending") : any {
    const status: any = String(value || "pending").trim().toLowerCase();
    if (!status || status === "pending") return "pending";
    if (status === "all" || status === "*") return "all";
    if (status === "denied") return "rejected";
    if (["approved", "rejected", "expired", "issuing", "consumed", "failed"].includes(status)) return status;
    return "pending";
  }

  function listMcpAuthorizationRequests({ status = "pending" }: Record<string, any> = {}) : any {
    expireMcpAuthorizationRequests();
    const normalizedStatus: any = normalizeMcpAuthorizationRequestStatus(status);
    const rows: any = normalizedStatus === "all"
      ? db.prepare("SELECT * FROM mcp_authorization_requests ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM mcp_authorization_requests WHERE status = ? ORDER BY created_at DESC").all(normalizedStatus);
    return rows.map((row?: any) : any => projectMcpAuthorizationRequest(row));
  }

  function resolveMcpAuthorizationRequest({ requestId, resolution, grantId = "", resolvedBy = "" }: Record<string, any>) : any {
    if (!["approved", "rejected"].includes(resolution)) {
      throw new Error("Invalid resolution status");
    }

    expireMcpAuthorizationRequests();
    const info: any = db.prepare(`
      UPDATE mcp_authorization_requests
      SET status = ?, resolved_at = ?, resolved_by = ?, grant_id = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(resolution, nowIso(), String(resolvedBy || ""), String(grantId), String(requestId));

    return info.changes > 0;
  }

  function claimMcpAuthorizationRequest({ requestId, claimTokenHash }: Record<string, any>) : any {
    expireMcpAuthorizationRequests();
    const row: any = db.prepare("SELECT * FROM mcp_authorization_requests WHERE request_id = ?")
      .get(String(requestId || ""));
    if (!row || row.request_kind !== "local_mcp_install" || !safeCompare(row.claim_token_hash, claimTokenHash)) {
      return { claimed: false, status: "not_found", request: null };
    }
    if (
      row.status === "consumed" &&
      row.replay_envelope_json &&
      Date.parse(row.replay_expires_at) > Date.now()
    ) {
      return {
        claimed: false,
        replayable: true,
        status: "consumed",
        request: projectMcpAuthorizationRequest(row, { includeReplay: true })
      };
    }
    if (row.status !== "approved") {
      return {
        claimed: false,
        status: row.status,
        request: projectMcpAuthorizationRequest(row)
      };
    }
    const info: any = db.prepare(`
      UPDATE mcp_authorization_requests
      SET status = 'issuing', issuing_at = ?
      WHERE request_id = ? AND status = 'approved' AND claim_token_hash = ?
    `).run(nowIso(), String(requestId || ""), String(claimTokenHash || ""));
    if (info.changes <= 0) {
      const current: any = db.prepare("SELECT * FROM mcp_authorization_requests WHERE request_id = ?")
        .get(String(requestId || ""));
      return {
        claimed: false,
        status: current?.status || "not_found",
        request: projectMcpAuthorizationRequest(current)
      };
    }
    const claimed: any = db.prepare("SELECT * FROM mcp_authorization_requests WHERE request_id = ?")
      .get(String(requestId || ""));
    return {
      claimed: true,
      status: "issuing",
      request: projectMcpAuthorizationRequest(claimed, { includePayload: true })
    };
  }

  function completeMcpAuthorizationRequest({
    requestId,
    status,
    grantIds = [],
    errorCode = "",
    replayEnvelope = "",
    replayExpiresAt = ""
  }: Record<string, any>) : any {
    if (!["consumed", "failed"].includes(status)) {
      throw new Error("Invalid MCP authorization completion status");
    }
    const timestamp: any = nowIso();
    const normalizedGrantIds: any = Array.isArray(grantIds)
      ? [...new Set<any>(grantIds.map((value?: any) : any => String(value || "").trim()).filter(Boolean))]
      : [];
    const normalizedReplayEnvelope: any = status === "consumed" ? String(replayEnvelope || "") : "";
    const normalizedReplayExpiresAt: any = status === "consumed" ? String(replayExpiresAt || "") : "";
    if (status === "consumed") {
      const replayBytes: any = Buffer.byteLength(normalizedReplayEnvelope, "utf8");
      const now: any = Date.now();
      const replayExpiry: any = Date.parse(normalizedReplayExpiresAt);
      if (
        replayBytes <= 0 ||
        replayBytes > LOCAL_MCP_AUTHORIZATION_REPLAY_BYTES_LIMIT ||
        !Number.isFinite(replayExpiry) ||
        replayExpiry <= now ||
        replayExpiry > now + LOCAL_MCP_AUTHORIZATION_REPLAY_MAX_TTL_MS
      ) {
        throw new Error("local_mcp_authorization_replay_invalid");
      }
      const replayUsage: any = Number(db.prepare(`
        SELECT COALESCE(SUM(length(CAST(replay_envelope_json AS BLOB))), 0) AS bytes
        FROM mcp_authorization_requests
        WHERE replay_envelope_json <> ''
          AND replay_expires_at > ?
          AND request_id <> ?
      `).get(nowIso(), String(requestId || ""))?.bytes || 0);
      if (replayUsage + replayBytes > LOCAL_MCP_AUTHORIZATION_REPLAY_TOTAL_BYTES_LIMIT) {
        throw new Error("local_mcp_authorization_replay_capacity_exceeded");
      }
    }
    const info: any = db.prepare(`
      UPDATE mcp_authorization_requests
      SET status = ?,
          grant_id = ?,
          grant_ids_json = ?,
          consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE consumed_at END,
          replay_envelope_json = ?,
          replay_expires_at = ?,
          error_code = ?
      WHERE request_id = ? AND status = 'issuing'
    `).run(
      status,
      normalizedGrantIds[0] || "",
      stringifyJson(normalizedGrantIds),
      status,
      timestamp,
      normalizedReplayEnvelope,
      normalizedReplayExpiresAt,
      String(errorCode || ""),
      String(requestId || "")
    );
    return info.changes > 0;
  }

  return {
    expirePendingOperations,
    createPendingOperation,
    getPendingOperation,
    listPendingOperations,
    resolvePendingOperation,
    createMcpAuthorizationRequest,
    getMcpAuthorizationRequest,
    listMcpAuthorizationRequests,
    resolveMcpAuthorizationRequest,
    claimMcpAuthorizationRequest,
    completeMcpAuthorizationRequest
  };
}
