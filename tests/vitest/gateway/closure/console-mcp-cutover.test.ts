import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { upstreamProjectedOperationId } from "../../../../packages/agents/src/upstream-gateway/operation-projection.ts";
import { createUpstreamGatewayOperationExecutor } from "../../../../packages/server-runtime/src/composition/console-domain/operation-executors/upstream-gateway-executor.ts";
import { installUpstreamRuntimeServices } from "../../../helpers/upstream-runtime-snapshot.ts";

describe("Console MCP final-effect transport", () => {
  it("[NODE011] defaults to denying a registered MCP write without a final protected-sink permit", async () => {
    let effects = 0;
    const registry = createUpstreamGatewayRegistry({ mcpSessionManager: { listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
      invokeGateway: async () => { effects += 1; return { result: { content: [] } }; }, retireScope: async () => ({ retired: 0 }), close: async () => {} } });
    installUpstreamRuntimeServices(registry, [{ serviceId: "console", serviceProtocol: "mcp", label: "console", allowLocalNetwork: true,
      operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "safe_write", requiredScopes: ["gateway:write"] }],
      mcp: { transport: "http", url: "http://127.0.0.1:9/mcp", protocolVersion: "2025-06-18" }
    }]);
    const subject = { type: "tool-grant", subjectId: "operator", grantId: "grant", grant: { id: "grant", subjectId: "operator", dynamicCapabilities: ["cap:upstream:console:tools-call-echo"] }, scopes: ["gateway:write"], dynamicCapabilities: ["cap:upstream:console:tools-call-echo"] };
    try {
      await expect(registry.forward({ serviceId: "console", operationKey: "tools/call", toolName: "echo", arguments: {} }, subject)).rejects.toMatchObject({ status: 403, reasonCode: "upstream_final_effect_authority_required" });
      expect(effects).toBe(0);
    } finally { await registry.close(); }
  });

  it("[NODE011] gateway.forward and projected operation share typed transport while claiming current permits", async () => {
    let effects = 0;
    const peerMethods: string[] = [];
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      peerMethods.push(wire.method);
      const result = wire.method === "server/discover" ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
        : { resultType: "complete", structuredContent: { value: ++effects }, content: [{ type: "text", text: "peer" }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("Synthetic Console peer is unavailable.");
    const events: string[] = [];
    const consumed = new Set<string>();
    const registry = createUpstreamGatewayRegistry({ mcpSessionManager: { listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] }),
      invokeGateway: async () => { throw new Error("Modern Console path must not use legacy session transport."); }, retireScope: async () => ({ retired: 0 }), close: async () => {} },
      claimProtectedSinkAttempt: async ({ attempt, resourceRevision, resolveCurrentResource }: Record<string, any>) => {
        events.push("claim");
        const current = await resolveCurrentResource();
        if (!attempt?.id || attempt.revoked === true || consumed.has(attempt.id) || current.resourceRevision !== resourceRevision ||
            attempt.expectedResourceRevision && attempt.expectedResourceRevision !== resourceRevision) throw Object.assign(new Error("final sink permit rejected"), { status: 403, reasonCode: "final_sink_denied" });
        consumed.add(attempt.id);
        return Object.freeze({ id: attempt.id, consumed: true });
      }
    });
    installUpstreamRuntimeServices(registry, [{ serviceId: "console", serviceProtocol: "mcp", label: "console", allowLocalNetwork: true,
      operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "safe_write", requiredScopes: ["gateway:write"], inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
      mcp: { transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: "2026-07-28" }
    }]);
    const subject = { type: "tool-grant", subjectId: "operator", grantId: "grant", grant: { id: "grant", subjectId: "operator", dynamicCapabilities: ["cap:upstream:console:tools-call-echo"] },
      scopes: ["gateway:write"], dynamicCapabilities: ["cap:upstream:console:tools-call-echo"] };
    const executor = createUpstreamGatewayOperationExecutor({
      errorPayload: (error: { reasonCode?: string; code?: string; message?: string }, message: string) => ({ error: { code: error.reasonCode ?? error.code ?? "rejected", message, detail: error.message } }),
      objectOrNull: (value: unknown) => value && typeof value === "object" ? value : null,
      protocolPayload: (value: unknown) => value,
      result: (status: number, body: unknown) => ({ status, body }),
      subjectFromAuthSession: () => subject,
      upstreamGatewayRegistryFor: () => registry
    });
    const invoke = (operationId: string, permit?: Record<string, unknown>, transport = "mcp", value: unknown = "synthetic") => executor({ operationId,
      input: { serviceId: "console", operationKey: "tools/call", toolName: "echo", arguments: { value } },
      context: { authSession: {}, subject, transport, finalProtectedSinkPermit: permit ?? null } });
    try {
      const first = await invoke("gateway.forward", { id: "permit-1" });
      expect(first).toMatchObject({ status: 200, body: { response: { structuredContent: { value: 1 } } } });
      const projected = await invoke(upstreamProjectedOperationId("console", "tools/call"), { id: "permit-2" });
      expect(projected).toMatchObject({ status: 200, body: { response: { structuredContent: { value: 2 } } } });
      const structured = await invoke("gateway.forward", { id: "permit-3" }, "http");
      expect(structured).toMatchObject({ status: 200, body: { response: { structuredContent: { value: 3 }, content: [{ text: "peer" }] } } });
      expect(events).toEqual(["claim", "claim", "claim"]);
      expect(peerMethods).toEqual(["server/discover", "tools/call", "server/discover", "tools/call", "server/discover", "tools/call"]);
      expect((await invoke("gateway.forward")).status).toBe(403);
      expect((await invoke("gateway.forward", { id: "permit-1" })).status).toBe(403);
      expect((await invoke("gateway.forward", { id: "revoked", revoked: true })).status).toBe(403);
      expect((await invoke("gateway.forward", { id: "stale", expectedResourceRevision: "stale" })).status).toBe(403);
      expect((await invoke("gateway.forward", { id: "invalid-input" }, "mcp", 42)).status).toBe(400);
      expect(consumed.has("invalid-input")).toBe(false);
      expect(effects).toBe(3);
    } finally { await registry.close(); await new Promise<void>((resolve) => peer.close(() => resolve())); }
  }, 20_000);
});
