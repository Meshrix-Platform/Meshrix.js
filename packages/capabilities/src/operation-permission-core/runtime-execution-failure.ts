import { summarizeError } from "@meshrix/foundation/observability/runtime-logger";
import {
  authorizationGrantId,
  authorizationSubjectId,
  authorizationSubjectType,
  nowIso,
  sourceIpFromRequest
} from "./runtime-common.ts";

const PUBLIC_API_KEY_CAPACITY_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  api_key_concurrency_limit_reached: "API Key concurrency limit reached.",
  api_key_rate_limited: "API Key rate limit reached.",
  api_key_use_limit_reached: "API Key use limit reached."
});

function executionFailureProjection(error: any): Readonly<Record<string, any>> {
  const sourceCode: string = String(error?.code || "");
  if (sourceCode === "tool_aborted") {
    return Object.freeze({ code: sourceCode, message: error.message, status: 499 });
  }
  if (sourceCode === "tool_timeout") {
    return Object.freeze({ code: sourceCode, message: error.message, status: 500 });
  }
  if (
    Number(error?.statusCode || error?.status || 0) === 429 &&
    Object.hasOwn(PUBLIC_API_KEY_CAPACITY_FAILURES, sourceCode)
  ) {
    return Object.freeze({
      code: sourceCode,
      message: PUBLIC_API_KEY_CAPACITY_FAILURES[sourceCode],
      status: 429
    });
  }
  return Object.freeze({
    code: "tool_execution_failed",
    message: "Tool execution failed.",
    status: 500
  });
}

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
  const failure: any = executionFailureProjection(error);
  const errorCode: any = failure.code;
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
    status: failure.status,
    payload: {
      schemaVersion: "v0.0.1:schema:definition-1",
      traceId,
      error: {
        code: errorCode,
        message: failure.message,
        details: {
          toolExecutionId,
          decisionId: policy.decisionId,
          policy: policySummary
        }
      }
    }
  };
}
