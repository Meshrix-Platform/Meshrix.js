import { result } from "./shared.ts";

export async function executeOperationPermissionAuthorizationOperation({ operationId, input = {}, context }: Record<string, any>) : Promise<any> {
  const id: any = String(operationId || "");
  const handledOperations: any = new Set<any>([
    "operation_permission.mcp.request_authorization",
    "operation_permission.mcp.list_requests",
    "operation_permission.mcp.resolve_request"
  ]);
  if (!handledOperations.has(id)) {
    return null;
  }

  const provider: any = context.toolSkillManagementProvider;
  if (!provider) {
    return result(503, { error: "Tool/Skill management provider is unavailable." });
  }

  if (id === "operation_permission.mcp.request_authorization") {
    return result(200, provider.createMcpAuthorizationRequest(input, {
      request: context.request || null
    }));
  }

  if (id === "operation_permission.mcp.list_requests") {
    return result(200, {
      requests: provider.listMcpAuthorizationRequests(input)
    });
  }

  if (id === "operation_permission.mcp.resolve_request") {
    const { success, grantId } = await provider.resolveMcpAuthorizationRequest(input, {
      authSession: context.authSession || null
    });
    if (!success) {
      return result(404, { error: "Request not found or already resolved." });
    }
    return result(200, { ok: true, grantId });
  }

  return null;
}
