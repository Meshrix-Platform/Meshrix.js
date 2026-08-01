import { result } from "./shared.ts";

export async function executeOperationPermissionPassthroughOperation({ operationId, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "operation_permission.http.passthrough");
  if (id !== "operation_permission.http.passthrough" && !id.startsWith("operation_permission.")) {
    return null;
  }

  const provider: any = context.toolSkillManagementProvider;
  if (!provider?.handleOperationPermissionHttpRequest) {
    return result(503, { error: "Tool/Skill management provider is unavailable." });
  }
  const handled: any = await provider.handleOperationPermissionHttpRequest({
    request: context.request,
    response: context.response,
    requestBody: context.requestBody,
    url: context.url,
    method: context.method || context.request?.method || "GET",
    signal: context.signal || null,
    dispatched: true
  });
  return handled
    ? result(200, { __responseHandled: true })
    : result(404, { error: "Operation Permission API route not found." });
}
