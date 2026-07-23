import {
  nowIso,
  parseJsonObject,
  pendingResumeInput,
  sourceIpFromRequest,
  uniqueStrings
} from "./runtime-common.mjs";
import { jsonByteLength } from "./runtime-result-summary.mjs";

function handlerPendingApprovalPayload(payload = {}) {
  if (payload?.status === "pending_approval") {
    return payload;
  }
  if (payload?.result?.status === "pending_approval") {
    return payload.result;
  }
  return null;
}

export async function completeHandlerPendingApproval({
  payload,
  statusCode = 200,
  store,
  traceId = "",
  toolExecutionId = "",
  tool,
  operation,
  authorization,
  context = {},
  policy,
  policySummary,
  approvalOperationBinding,
  input = {},
  inputBytes = 0,
  durationMs = 0,
  request = null,
  startedAt = "",
  appendExecution,
  publishEvent
} = {}) {
  const handlerPending = handlerPendingApprovalPayload(payload);
  if (statusCode !== 202 || !handlerPending) {
    return null;
  }
  const escalatable = handlerPending.escalatable === true &&
    handlerPending.approval?.required === true &&
    handlerPending.approval?.escalatable === true;
  if (!escalatable) {
    const reasonCode = "handler_pending_not_escalatable";
    await appendExecution({
      toolExecutionId,
      traceId,
      toolId: tool.id,
      toolVersion: tool.version,
      toolsetIds: tool.toolsets,
      subjectType: "grant",
      subjectId: authorization.grant.id,
      grantId: authorization.grant.id,
      agentId: context.agentId || "",
      profileId: context.profileId || "",
      operationId: tool.operationId,
      risk: tool.risk,
      decision: "deny",
      input,
      resultSummary: { type: "handler_pending_rejected", reasonCode, policy: policySummary },
      status: "denied",
      errorCode: reasonCode,
      durationMs,
      policyDecisionId: policy.decisionId,
      sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
      userAgent: request?.headers?.["user-agent"] || "",
      startedAt,
      finishedAt: nowIso()
    });
    store.appendMetric({
      traceId,
      toolId: tool.id,
      grantId: authorization.grant.id,
      profileId: context.profileId || "",
      status: "denied",
      risk: tool.risk,
      durationMs,
      inputBytes,
      resultBytes: 0,
      reasonCode
    });
    return {
      ok: false,
      status: 409,
      payload: {
        schemaVersion: "v0.0.1:schema:definition-1",
        toolExecutionId,
        traceId,
        error: {
          code: reasonCode,
          message: "Tool handler pending response is not marked as eligible for approval escalation."
        },
        policy: policySummary
      }
    };
  }
  const handlerRequiredApproval = parseJsonObject(JSON.stringify(
    handlerPending.requiredApproval ||
      handlerPending.approval?.requiredApproval ||
      { reasonCode: handlerPending.reasonCode || "tool_handler_approval_required" }
  ));
  const requiredApproval = {
    ...handlerRequiredApproval,
    operationBinding: approvalOperationBinding
  };
  const approvalLayers = uniqueStrings(requiredApproval.approvalLayers || handlerPending.approvalLayers || []);
  const pendingRisk = String(handlerPending.risk || tool.risk || "");
  const pendingOperation = store.createPendingOperation({
    traceId,
    toolExecutionId,
    toolId: tool.id,
    toolVersion: tool.version,
    toolsetIds: tool.toolsets,
    operationId: tool.operationId,
    risk: pendingRisk,
    approvalScope: handlerPending.approval?.approvalScope || tool.approvalScope || operation.safety?.approvalScope || "",
    requiredApproval,
    approvalLayers,
    grantId: authorization.grant.id,
    agentId: context.agentId || context.agentProfileId || "",
    profileId: context.profileId || context.agentProfileId || "",
    idempotencyKey: context.idempotencyKey || "",
    reasonCode: handlerPending.reasonCode || "tool_handler_approval_required",
    riskReason: handlerPending.reason || "Tool handler requested approval before execution.",
    originalInput: input,
    resumeInput: pendingResumeInput(input, tool.operationId),
    context,
    sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
    userAgent: request?.headers?.["user-agent"] || "",
    expiresAt: context.expiresAt || context.approvalExpiresAt || ""
  });
  await appendExecution({
    toolExecutionId,
    traceId,
    toolId: tool.id,
    toolVersion: tool.version,
    toolsetIds: tool.toolsets,
    subjectType: "grant",
    subjectId: authorization.grant.id,
    grantId: authorization.grant.id,
    agentId: context.agentId || "",
    profileId: context.profileId || "",
    operationId: tool.operationId,
    risk: pendingRisk,
    decision: "handler_pending_approval",
    input,
    resultSummary: {
      type: "pending_operation",
      pendingOperationId: pendingOperation.pendingOperationId,
      status: pendingOperation.status,
      requiredApproval: pendingOperation.requiredApproval || {},
      approvalLayers: pendingOperation.approvalLayers || [],
      policy: policySummary
    },
    status: "pending_approval",
    errorCode: handlerPending.reasonCode || "tool_handler_approval_required",
    durationMs,
    policyDecisionId: policy.decisionId,
    approvalId: pendingOperation.pendingOperationId,
    sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
    userAgent: request?.headers?.["user-agent"] || "",
    startedAt,
    finishedAt: nowIso()
  });
  store.appendMetric({
    traceId,
    toolId: tool.id,
    grantId: authorization.grant.id,
    profileId: context.profileId || "",
    status: "pending_approval",
    risk: pendingRisk,
    durationMs,
    inputBytes,
    resultBytes: jsonByteLength(pendingOperation),
    reasonCode: handlerPending.reasonCode || "tool_handler_approval_required"
  });
  await publishEvent("tools.pending_operation", {
    pendingOperationId: pendingOperation.pendingOperationId,
    traceId,
    toolExecutionId,
    toolId: tool.id,
    operationId: tool.operationId,
    risk: pendingRisk,
    status: "pending"
  }, { type: "tools.pending_operation.created" });
  return {
    ok: true,
    status: 202,
    payload: {
      schemaVersion: "v0.0.1:schema:definition-1",
      toolExecutionId,
      traceId,
      toolId: tool.id,
      status: "pending_approval",
      pendingOperation,
      policy: policySummary
    }
  };
}
