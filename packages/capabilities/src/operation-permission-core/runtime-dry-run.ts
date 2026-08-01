import { nowIso, sourceIpFromRequest } from "./runtime-common.ts";
import { jsonByteLength } from "./runtime-result-summary.ts";

export async function completeDryRunExecution({
  startedAtMs,
  appendExecution,
  store,
  logTool,
  traceId,
  toolExecutionId,
  tool,
  authorization,
  context,
  policy,
  input,
  inputBytes,
  policySummary,
  request,
  startedAt
}: Record<string, any>) : Promise<any> {
  const durationMs: any = Date.now() - startedAtMs;
  const result: Record<string, any> = {
    wouldExecute: true,
    tool: {
      id: tool.id,
      operationId: tool.operationId,
      risk: tool.risk,
      requiredScopes: tool.requiredScopes,
      toolsets: tool.toolsets
    },
    policy
  };
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
    result,
    status: "ok",
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
    status: "ok",
    risk: tool.risk,
    durationMs,
    inputBytes,
    resultBytes: jsonByteLength(result)
  });
  logTool("info", "operation_permission.execute.dry_run_completed", {
    traceId,
    toolExecutionId,
    toolId: tool.id,
    operationId: tool.operationId,
    risk: tool.risk,
    decisionId: policy.decisionId,
    durationMs
  });
  return {
    ok: true,
    status: 200,
    payload: {
      schemaVersion: "v0.0.1:schema:definition-1",
      toolExecutionId,
      traceId,
      toolId: tool.id,
      status: "ok",
      result,
      grant: authorization.grant,
      policy: policySummary
    }
  };
}
