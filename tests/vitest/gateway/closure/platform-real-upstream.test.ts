import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpstreamGatewayRegistry } from "../../../../packages/agents/src/upstream-gateway/index.ts";
import { createPlatformMcpGateway } from "@meshrix/server-runtime/composition/gateway-composition";
import { installUpstreamRuntimeServices } from "../../../helpers/upstream-runtime-snapshot.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe("configured default platform upstream transport", () => {
  it("[GC-030 GC-033 partial] uses the real versioned peer, not the retired forwarder, preserving configured headers", async () => {
    const wire: Array<{ method: string; headers: Record<string, unknown>; params: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      wire.push({ method: body.method, headers: request.headers, params: body.params });
      const result = body.method === "server/discover"
        ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
        : { resultType: "complete", content: [{ type: "text", text: "real-peer" }], structuredContent: { source: "real-peer" }, _meta: { businessId: "metadata-kept" } };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("peer has no TCP address");
    const legacyForward = vi.fn(() => { throw new Error("old forwarder must not run"); });
    const recursiveSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", $defs: { payload: { type: "object", properties: { value: { type: "string", minLength: 1 }, next: { $ref: "#/$defs/payload" } }, required: ["value"] } }, properties: { payload: { $ref: "#/$defs/payload" } }, required: ["payload"] };
    const registry = createUpstreamGatewayRegistry({ mcpSessionManager: {
      listTools: async () => ({ tools: [{ name: "echo", inputSchema: recursiveSchema, outputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } }] }),
      callTool: legacyForward, invokeGateway: async (config: { protocolVersion?: string }) => { throw new Error(`unexpected legacy protocol ${config.protocolVersion ?? "absent"}`); }, retireScope: async () => ({ retired: 0 }), close: async () => {}
    } });
    cleanup.push(() => registry.close());
    installUpstreamRuntimeServices(registry, [{ serviceId: "synthetic", serviceProtocol: "mcp", label: "synthetic", allowLocalNetwork: true,
      operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
      mcp: { transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: "2026-07-28", headers: { "X-Context-Scope": "synthetic" } }
    }]);
    const noOldForward = new Proxy(registry, { get(target, property) {
      if (property === "callMcpToolByPublicName") return legacyForward;
      return Reflect.get(target, property);
    } });
    const platform = createPlatformMcpGateway({ upstreamGatewayRegistry: noOldForward,
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: async () => ({ ok: true, credentialKind: "scoped_api_key", grant: { id: "grant-1", revision: "grant-1", subjectId: "caller", scopes: ["gateway:read"], dynamicCapabilities: ["cap:upstream:synthetic:tools-call-echo"] }, subject: { type: "tool-grant", subjectId: "caller", grantId: "grant-1", scopes: ["gateway:read"], dynamicCapabilities: ["cap:upstream:synthetic:tools-call-echo"] } }),
        listVisibleTools: async () => []
      }
    });
    cleanup.push(() => platform.close());
    await platform.gateway.start();
    const call = async (method: string, params: Record<string, unknown> = {}) => platform.adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: method, method, params } });
    const listed = await call("tools/list");
    const tools = (listed.body as { result: { tools: Array<{ name: string; _meta?: { serviceId?: string } }> } }).result.tools;
    const published = tools.find((tool) => tool._meta?.serviceId === "synthetic");
    expect(published).toBeDefined();
    expect(published?.inputSchema).toMatchObject({ $defs: { payload: { required: ["value"] } } });
    expect((await call("tools/call", { name: published!.name, arguments: { payload: { value: 2 } } })).body).toMatchObject({ error: { data: { code: "schema_validation_failed" } } });
    expect(wire).toHaveLength(0);
    const result = await call("tools/call", { name: published!.name, arguments: { payload: { value: "定義✳" }, _meta: { businessId: "input-kept" } } });
    expect(result.body).toMatchObject({ result: { resultType: "complete", structuredContent: { source: "real-peer" }, _meta: { businessId: "metadata-kept" } } });
    expect(wire.map((item) => item.method)).toEqual(["server/discover", "tools/call"]);
    expect(wire[1].headers["x-context-scope"]).toBe("synthetic");
    expect(wire[1].params._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
    expect((wire[1].params.arguments as { _meta: unknown })._meta).toEqual({ businessId: "input-kept" });
    expect((wire[1].params.arguments as { payload: { value: string } }).payload.value).toBe("定義✳");
    expect(legacyForward).not.toHaveBeenCalled();
  }, 15_000);

  it("[GC-035 GC-036 partial] uses the configured legacy session transport without calling the retired registry method", async () => {
    const calls: Array<{ method: string; session?: string }> = [];
    const peer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (chunks.length === 0) { response.writeHead(204).end(); return; }
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push({ method: wire.method, session: String(request.headers["mcp-session-id"] || "") });
      const result = wire.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic-legacy", version: "1" } }
        : wire.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "legacy-peer" }] };
      response.writeHead(wire.method === "notifications/initialized" ? 202 : 200, { "content-type": "application/json", ...(wire.method === "initialize" ? { "Mcp-Session-Id": "synthetic-session" } : {}) });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id ?? null, result }));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("legacy peer is unavailable");
    const registry = createUpstreamGatewayRegistry();
    cleanup.push(() => registry.close());
    installUpstreamRuntimeServices(registry, [{ serviceId: "legacy", serviceProtocol: "mcp", label: "legacy", allowLocalNetwork: true,
      operations: [{ operationKey: "tools/call", protocol: "mcp", risk: "read_only", requiredScopes: ["gateway:read"] }],
      mcp: { transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, protocolVersion: "2025-06-18" }
    }]);
    const platform = createPlatformMcpGateway({ upstreamGatewayRegistry: registry,
      toolSkillManagementProvider: { authorizeMcpClientRequest: async () => ({ ok: true, grant: { id: "grant-1", revision: "grant-1", subjectId: "caller", scopes: ["gateway:read"], dynamicCapabilities: ["cap:upstream:legacy:tools-call-echo"] }, subject: { type: "tool-grant", subjectId: "caller", grantId: "grant-1", scopes: ["gateway:read"], dynamicCapabilities: ["cap:upstream:legacy:tools-call-echo"] } }), listVisibleTools: async () => [] }
    });
    cleanup.push(() => platform.close());
    await platform.gateway.start();
    const send = async (method: string, params: Record<string, unknown> = {}) => platform.adapter.handle({ method: "POST", headers: { "content-type": "application/json" }, body: { jsonrpc: "2.0", id: method, method, params } });
    const listed = await send("tools/list");
    const tool = (listed.body as { result: { tools: Array<{ name: string; _meta?: { serviceId?: string } }> } }).result.tools.find((entry) => entry._meta?.serviceId === "legacy");
    expect(tool, JSON.stringify({ visibleNames: (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((entry) => entry.name), peerMethods: calls.map((entry) => entry.method) })).toBeDefined();
    expect((await send("tools/call", { name: tool!.name, arguments: {} })).body).toMatchObject({ result: { content: [{ text: "legacy-peer" }] } });
    expect(calls.filter((item) => item.method === "initialize").length).toBeGreaterThanOrEqual(1);
    expect(calls.some((item) => item.method === "notifications/initialized")).toBe(true);
    expect(calls.find((item) => item.method === "tools/call")?.session).toBe("synthetic-session");
  }, 15_000);
});
