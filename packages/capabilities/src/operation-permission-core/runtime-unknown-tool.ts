import { nowIso, randomId } from "./runtime-common.ts";
import { appendAuthorizationDecision } from "./runtime-execution-support.ts";

export async function denyUnknownToolExecution({
  tool,
  toolId,
  logTool,
  summarizeForLog,
  input,
  appendExecution,
  store,
  traceId,
  toolExecutionId,
  startedAt,
  inputBytes,
  securityPermissions
}: Record<string, any>) : Promise<any> {
  logTool("warn", "operation_permission.execute.denied", {
    traceId,
    toolExecutionId,
    toolId: toolId || "",
    reason: tool ? "operation_missing" : "unknown_tool",
    input: summarizeForLog(input)
  });
  const status: any = tool ? 500 : 404;
  const reasonCode: any = tool ? "operation_missing" : "unknown_tool";
  await appendExecution({
    toolExecutionId,
    traceId,
    toolId: toolId || "",
    status: "denied",
    errorCode: reasonCode,
    decision: "deny",
    input,
    startedAt,
    finishedAt: nowIso()
  });
  store.appendMetric({ traceId, toolId, status: "denied", reasonCode, inputBytes });
  appendAuthorizationDecision(securityPermissions, {
    decisionId: randomId("authz_decision"),
    traceId,
    toolExecutionId,
    toolId: toolId || "",
    operationId: tool?.operationId || "",
    reasonCode,
    redactedReason: tool ? "Tool operation is not available." : "Tool is not registered.",
    subject: {
      type: "anonymous",
      subjectId: "",
      scopes: []
    },
    resource: {
      toolId: toolId || "",
      operationId: tool?.operationId || "",
      risk: tool?.risk || ""
    }
  });
  return {
    ok: false,
    status,
    payload: {
      schemaVersion: "v0.0.1:schema:definition-1",
      traceId,
      error: {
        code: reasonCode,
        message: tool ? "Tool operation is not available." : "Tool is not registered.",
        details: { toolId }
      }
    }
  };
}
