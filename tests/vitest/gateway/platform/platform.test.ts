import { describe, expect, it } from "vitest";
import { createGatewayExecutor } from "@meshrix/agents/upstream-gateway/gateway-executor";
import { publicUpstreamMcpTool } from "../../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import { createGatewayProtocolAdapter } from "@meshrix/protocols/mcp/adapter/gateway";
import { createPlatformGateway, createPlatformMcpGateway, executeThroughPlatformGateway } from "@meshrix/server-runtime/composition/gateway-composition";
import { context, descriptor, QueueUpstream, response } from "../support";

describe("platform composition single invoke path", () => {
  it("[CASE-A06] routes protocol, agent, and platform composition through one gateway port", async () => {
    const gateway = createPlatformGateway({ upstream: new QueueUpstream([response({ resultType: "complete", value: "ok" })]), descriptors: [descriptor()] });
    await gateway.start();
    try {
      const protocol = createGatewayProtocolAdapter(gateway);
      const executor = createGatewayExecutor(gateway);
      expect(await protocol.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "complete" });
      expect(await executor.execute(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "complete" });
      expect(await executeThroughPlatformGateway({ gateway, context, invocation: { routeRef: "route.demo", method: "tools/call", params: {} } })).toMatchObject({ kind: "complete" });
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-G01] uses operator risk for upstream routes and rebuilds the catalog without cross-subject residue", async () => {
    const service = (serviceId: string, risk: string) => ({ serviceId, mcp: { toolNamePrefix: "collision" }, operations: [{ operationKey: "tools/call", risk }] });
    const destructiveTool = publicUpstreamMcpTool({
      service: service("service-a", "destructive"),
      tool: { name: "same", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
    });
    const safeWriteTool = publicUpstreamMcpTool({
      service: service("service-b", "safe_write"),
      tool: { name: "same", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
    });
    expect(destructiveTool.annotations).toMatchObject({ readOnlyHint: true });
    expect(destructiveTool._meta["io.meshrix/gateway-policy"]).toMatchObject({ effectClass: "destructive" });
    let listed = [destructiveTool, safeWriteTool];
    const platform = createPlatformMcpGateway({
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: async () => ({ ok: true, grant: { id: "grant-platform", subjectId: "subject-platform", revision: "grant-1" } }),
        listVisibleTools: () => []
      },
      upstreamGatewayRegistry: {
        listMcpTools: async () => ({ items: listed }),
        evaluateDiscoveredMcpToolAudience: () => ({ allowed: true })
      }
    });
    await platform.gateway.start();
    try {
      const list = () => platform.adapter.handle({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
      });
      await list();
      const initialRoutes = [...platform.gateway.catalogStore.snapshot().routes.values()];
      // The platform MCP baseline publishes the two stable categorized outlets as the first
      // routes of every authorization's catalog; the upstream routes the registry contributes
      // follow them.
      expect(initialRoutes.filter((item) => item.upstreamIdentity === "meshrix-platform").map((item) => item.logicalRoute))
        .toEqual(["platform:operation:meshrix.discovery", "platform:operation:meshrix.gateway"]);
      const destructiveRoute = initialRoutes.find((item) => item.upstreamIdentity === "upstream:service-a");
      expect(destructiveRoute?.effectClass).toBe("destructive");
      expect(initialRoutes.filter((item) => item.upstreamIdentity !== "meshrix-platform")).toHaveLength(2);
      expect(new Set(initialRoutes.map((item) => item.logicalRoute)).size).toBe(initialRoutes.length);
      expect(await platform.gateway.invoke({ ...context, grant: { revision: "grant-1", routeRefs: [destructiveRoute!.logicalRoute] } }, { routeRef: destructiveRoute!.logicalRoute, method: "tools/call", params: { arguments: {} } })).toMatchObject({ kind: "failure", code: "approval_required" });
      listed = [safeWriteTool];
      const updatedList = await list();
      const rebuilt = platform.gateway.catalogStore.snapshot();
      // The source catalog may retain an earlier route for another subject, but the
      // current grant's authorization-partitioned view must omit the removed route.
      const rebuiltUpstreamRoutes = [...rebuilt.routes.values()].filter((item) => item.upstreamIdentity !== "meshrix-platform");
      expect(rebuiltUpstreamRoutes).toHaveLength(2);
      const visibleServices = (updatedList.body as { result: { tools: Array<{ _meta?: { serviceId?: string } }> } }).result.tools.map((item) => item._meta?.serviceId).filter(Boolean);
      expect(visibleServices).toEqual(["service-b"]);
      expect(rebuilt.descriptors.slice(0, 2).map((item) => item.route.logicalRoute))
        .toEqual(["platform:operation:meshrix.discovery", "platform:operation:meshrix.gateway"]);
    } finally {
      await platform.close();
    }
  });

  it("[GC-034] a malformed upstream schema cannot evict a healthy neighbor", async () => {
    const healthy = publicUpstreamMcpTool({ service: { serviceId: "healthy", operations: [{ operationKey: "tools/call", risk: "read_only" }] }, tool: { name: "read", inputSchema: { type: "object" } } });
    const malformed = { ...healthy, name: "bad", inputSchema: { $ref: "https://external.invalid/schema" }, _meta: { ...healthy._meta, serviceId: "malformed" } };
    const platform = createPlatformMcpGateway({
      toolSkillManagementProvider: { authorizeMcpClientRequest: async () => ({ ok: true, grant: { revision: "grant-1", subjectId: "synthetic" } }), listVisibleTools: () => [] },
      upstreamGatewayRegistry: { listMcpTools: async () => ({ items: [malformed, healthy] }), evaluateDiscoveredMcpToolAudience: () => ({ allowed: true }) }
    });
    await platform.gateway.start();
    try {
      const page = await platform.adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
      const tools = (page.body as { result: { tools: Array<{ _meta?: { serviceId?: string } }> } }).result.tools;
      expect(tools.some((tool) => tool._meta?.serviceId === "healthy")).toBe(true);
      expect(tools.some((tool) => tool._meta?.serviceId === "malformed")).toBe(false);
    } finally { await platform.close(); }
  });
});
