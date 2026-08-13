import { summarizeError } from "@meshrix/foundation/observability/runtime-logger";
import {
  authorizationGrantId,
  authorizationSubjectId,
  authorizationSubjectType,
  nowIso,
  sourceIpFromRequest
} from "./runtime-common.ts";

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
}: Record<string, any>) : Promise<any> {
  const durationMs: any = Date.now() - startedAtMs;
  const message: any = error instanceof Error ? error.message : "Tool execution failed.";
  const errorCode: any = ["tool_timeout", "tool_aborted"].includes(error?.code)
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
  await store.appendMetric({
    traceId,
    toolId: tool.id,
    grantId: authorizationGrantId(authorization),
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
