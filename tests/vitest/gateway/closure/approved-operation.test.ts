import { describe, expect, it, vi } from "vitest";
import { createPlatformMcpGateway } from "@meshrix/server-runtime/composition/gateway-composition";
import { publicUpstreamMcpTool } from "../../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import { createToolSkillManagementProvider } from "../../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";

const tool = publicUpstreamMcpTool({
  service: { serviceId: "synthetic", operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "repair_write", requiredScopes: ["gateway:write"], requiresApproval: true }] },
  tool: { name: "destructive", inputSchema: { type: "object", properties: { value: { type: "string" } } } }
});

function fixture() {
  let active = true;
  let verificationCount = 0;
  const sink = vi.fn(async () => ({ status: 200, body: { jsonrpc: "2.0", id: "peer", result: { resultType: "complete", content: [{ type: "text", text: "approved" }] } } }));
  const evidence = vi.fn(async ({ request, toolId, operationInput }: Record<string, any>) => {
    verificationCount += 1;
    if (!active || !request?.__meshrixToolRuntimeAuthorization?.approvedPendingOperation || toolId !== tool._meta.toolId || operationInput?.arguments?.value !== "match") return null;
    return { status: "approved", ref: "synthetic-pending", revision: "decision-1", expiresAt: Date.now() + 60_000,
      approvedPendingOperation: { pendingOperationId: "synthetic-pending", status: "approved", operationId: "upstream_operation.synthetic", approvalScope: "gateway:write" } };
  });
  const platform = createPlatformMcpGateway({
    upstreamGatewayRegistry: { listMcpTools: async () => ({ items: [tool] }), evaluateDiscoveredMcpToolAudience: () => ({ allowed: true }), executePublishedMcpRoute: sink },
    toolSkillManagementProvider: {
      authorizeMcpClientRequest: async () => ({ ok: true, grant: { id: "grant-1", revision: "grant-1", subjectId: "caller", scopes: ["gateway:write"] }, subject: { type: "tool-grant", subjectId: "caller", grantId: "grant-1", scopes: ["gateway:write"] } }),
      listVisibleTools: async () => [], verifyCurrentApprovedMcpOperation: evidence,
      executeTool: async () => ({ ok: false, payload: { status: "pending_approval" } })
    }
  });
  return { platform, sink, evidence, revoke: () => { active = false; }, count: () => verificationCount };
}

async function call(platform: ReturnType<typeof createPlatformMcpGateway>, value: string, runtimeApproval = true) {
  const rawRequest = runtimeApproval ? { __meshrixToolRuntimeAuthorization: { approvedPendingOperation: { pendingOperationId: "synthetic-pending" } } } : {};
  return platform.adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, rawRequest, body: { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: tool.name, arguments: { value } } } });
}

describe("verified current approved operation", () => {
  it("[GC-012] validates a live Operation Permission record and rejects a revoked governance approval", async () => {
    let revokedAt = "";
    const operationInput = { toolName: "synthetic", arguments: { value: "match" } };
    const pending = { pendingOperationId: "pending-synthetic", status: "approved", toolId: "upstream.synthetic.tools-call", grantId: "grant-1",
      operationId: "upstream_operation.synthetic", approvalScope: "gateway:write", resolvedAt: "2026-09-23T05:00:00Z", resolvedBy: "approver",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), approvalLayers: ["owner"], originalInput: operationInput,
      requiredApproval: { operationBinding: { bindingDigest: "synthetic-binding", approvalActorId: "approver" } } };
    const securityPermissions = { getGovernanceApproval: async () => ({ effect: "allow", revokedAt, expiresAt: pending.expiresAt, approvalLayers: ["owner"] }) };
    const provider = createToolSkillManagementProvider({ operationPermissionPlatform: { store: { getPendingOperation: async () => pending } }, securityPermissions });
    const request = { __meshrixToolRuntimeAuthorization: { approvedPendingOperation: { ...pending, requiredApproval: { operationBinding: { bindingDigest: "synthetic-binding" } } } } };
    const input = { request, authorization: { ok: true, grant: { id: "grant-1" } }, toolId: pending.toolId, operationInput };
    expect(await provider.verifyCurrentApprovedMcpOperation(input)).toMatchObject({ status: "approved", ref: "pending-synthetic" });
    expect(await provider.verifyCurrentApprovedMcpOperation({ ...input, operationInput: { ...operationInput, arguments: { value: "forged" } } })).toBeNull();
    revokedAt = new Date().toISOString();
    expect(await provider.verifyCurrentApprovedMcpOperation(input)).toBeNull();
  });

  it("[GC-012 GC-013] permits a matching stored approval exactly through the protected platform sink", async () => {
    const { platform, sink, evidence } = fixture();
    await platform.gateway.start();
    try {
      expect((await call(platform, "match")).body).toMatchObject({ result: { resultType: "complete", content: [{ text: "approved" }] } });
      expect(evidence).toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(1);
    } finally { await platform.close(); }
  });

  it("[GC-013 partial] denies forged, mismatched and revoked approvals before dispatch", async () => {
    const fixtureSet = fixture();
    await fixtureSet.platform.gateway.start();
    try {
      await call(fixtureSet.platform, "match", false);
      await call(fixtureSet.platform, "changed");
      expect(fixtureSet.sink).not.toHaveBeenCalled();
      fixtureSet.revoke();
      await call(fixtureSet.platform, "match");
      expect(fixtureSet.sink).not.toHaveBeenCalled();
    } finally { await fixtureSet.platform.close(); }
  });
});
