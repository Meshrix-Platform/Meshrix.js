import {
  authorizationGrantId,
  authorizationSubjectId,
  authorizationSubjectType,
  nowIso,
  sourceIpFromRequest
} from "./runtime-common.ts";

export async function denyInvalidInputExecution({
  schemaValidation,
  startedAtMs,
  logTool,
  traceId,
  toolExecutionId,
  tool,
  input,
  appendExecution,
  authorization,
  context,
  policy,
  policySummary,
  request,
  store,
  inputBytes,
  publishEvent,
  startedAt
}: Record<string, any>) : Promise<any> {
  const durationMs: any = Date.now() - startedAtMs;
  logTool("warn", "operation_permission.execute.denied", {
    traceId,
    toolExecutionId,
    toolId: tool.id,
    operationId: tool.operationId,
    risk: tool.risk,
    reason: "invalid_input",
    error: schemaValidation.error,
    durationMs
  });
  await appendExecution({
    toolExecutionId,
    traceId,
    toolId: tool.id,
    toolVersion: tool.version,
    toolsetIds: tool.toolsets,
    subjectType: authorizationSubjectType(authorization),
    subjectId: authorizationSubjectId(authorization),
    grantId: authorizationGrantId(authorization),
    agentId: context.agentId || "",
    profileId: context.profileId || "",
    operationId: tool.operationId,
    risk: tool.risk,
    decision: policy.effect,
    input,
    resultSummary: {
      type: "invalid_input",
      error: schemaValidation.error,
      policy: policySummary
    },
    status: "denied",
    errorCode: "invalid_input",
    durationMs,
    policyDecisionId: policy.decisionId,
    sourceIp: authorization.sourceIp || sourceIpFromRequest(request),
    userAgent: request?.headers?.["user-agent"] || "",
    startedAt,
    finishedAt: nowIso()
  });
  await store.appendMetric({
    traceId,
    toolId: tool.id,
    grantId: authorizationGrantId(authorization),
    profileId: context.profileId || "",
    status: "denied",
    risk: tool.risk,
    durationMs,
    inputBytes,
    reasonCode: "invalid_input"
  });
  await publishEvent("tools.execution", { toolExecutionId, traceId, toolId: tool.id, status: "denied" }, { type: "tools.execution.denied" });
  return {
    ok: false,
    status: 400,
    payload: {
      schemaVersion: "v0.0.1:schema:definition-1",
      traceId,
      error: {
        code: "invalid_input",
        message: schemaValidation.error,
        details: {
          toolExecutionId,
          decisionId: policy.decisionId,
          policy: policySummary
        }
      }
    }
  };
}
