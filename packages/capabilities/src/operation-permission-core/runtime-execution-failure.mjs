import { summarizeError } from "@lico/foundation/observability/runtime-logger";
import { nowIso, sourceIpFromRequest } from "./runtime-common.mjs";

export async function completeToolExecutionFailure({
  error,
  startedAtMs,
  logTool,
  traceId,
  toolExecutionId,
  tool,
  appendExecution,
  authorization,
  context,
  policy,
  policySummary,
  input,
  request,
  store,
  inputBytes,
  publishEvent,
  startedAt
}) {
  const durationMs = Date.now() - startedAtMs;
  const message = error instanceof Error ? error.message : "Tool execution failed.";
  const errorCode = ["tool_timeout", "tool_aborted"].includes(error?.code)
    ? error.code
    : "tool_execution_failed";
  logTool("error", "operation_permission.execute.failed", {
    traceId,
    toolExecutionId,
    toolId: tool.id,
    operationId: tool.operationId,
    risk: tool.risk,
    reason: errorCode,
    durationMs,
    error: summarizeError(error)
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
    risk: tool.risk,
    decision: policy.effect,
    input,
    resultSummary: {
      type: "runtime_error",
      errorCode,
      policy: policySummary
    },
    status: "failed",
    errorCode,
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
    status: "failed",
    risk: tool.risk,
    durationMs,
    inputBytes,
    reasonCode: errorCode
  });
  await publishEvent(
    "tools.execution",
    { toolExecutionId, traceId, toolId: tool.id, status: "failed" },
    { type: "tools.execution.failed" }
  );
  return {
    ok: false,
    status: errorCode === "tool_aborted" ? 499 : 500,
    payload: {
      schemaVersion: "v0.0.1:schema:definition-1",
      traceId,
      error: {
        code: errorCode,
        message,
        details: {
          toolExecutionId,
          decisionId: policy.decisionId,
          policy: policySummary
        }
      }
    }
  };
}
