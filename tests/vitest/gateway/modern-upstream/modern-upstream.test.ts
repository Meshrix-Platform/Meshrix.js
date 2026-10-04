import { describe, expect, it } from "vitest";
import { createModernUpstreamAdapter, buildModernRequest } from "@meshrix/protocols/mcp/modern-upstream";
import { route, response } from "../support";

describe("modern MCP upstream adapter", () => {
  it("[CASE-L02] does not send initialize and preserves request-level state and full params", async () => {
    const calls: Array<{ request: Readonly<Record<string, unknown>>; headers: Readonly<Record<string, string>> }> = [];
    const adapter = createModernUpstreamAdapter({
      transport: {
         async send(input) { calls.push(input); return response(input.request.method === "server/discover" ? { jsonrpc: "2.0", id: input.request.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } } : { resultType: "complete", value: { ok: true } }); }
      }
    });
    await adapter.invoke({ request: { id: 1, method: "tools/call", params: { name: "demo", arguments: { traceId: "business" } }, protocolVersion: "2026-07-28", requestState: "opaque-upstream-state", headers: {} }, route: route({ upstreamName: "server-tool" }) });
    expect(calls).toHaveLength(2);
    expect(calls[0].request.method).toBe("server/discover");
    expect(calls[0].request.params).toMatchObject({ _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "meshrix-gateway" } } });
    expect(calls[1].request).toMatchObject({ method: "tools/call", params: { name: "demo", requestState: "opaque-upstream-state" } });
    expect(calls[1].headers).toMatchObject({ "Mcp-Method": "tools/call", "Mcp-Protocol-Version": "2026-07-28", "Mcp-Name": "demo" });
    expect(calls.every((call) => call.request.method !== "initialize")).toBe(true);
  });

  it("mirrors only name-bearing wire params and encodes their header values", async () => {
    const calls: Array<{ request: Readonly<Record<string, unknown>>; headers: Readonly<Record<string, string>> }> = [];
    const adapter = createModernUpstreamAdapter({
      transport: {
        async send(input) {
          calls.push(input);
          return response(input.request.method === "server/discover" ? { jsonrpc: "2.0", id: input.request.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } } : { resultType: "complete", value: { ok: true } });
        }
      }
    });
    const requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [
      { method: "tools/call", params: { name: "body-tool", arguments: {} } },
      { method: "resources/read", params: { uri: "fixture://artifact/资料" } },
      { method: "prompts/get", params: { name: "=?base64?literal?=" } },
      { method: "tools/list", params: {} }
    ];
    for (const [index, request] of requests.entries()) {
      await adapter.invoke({
        request: { id: index + 10, ...request, protocolVersion: "2026-07-28", headers: {} },
        route: route({ upstreamName: "route-target" })
      });
    }

    const actual = calls.filter((call) => call.request.method !== "server/discover");
    expect(actual).toHaveLength(4);
    expect(actual[0].request).toMatchObject({ method: "tools/call", params: { name: "body-tool" } });
    expect(actual[0].headers["Mcp-Name"]).toBe("body-tool");
    expect(actual[1].request).toMatchObject({ method: "resources/read", params: { uri: "fixture://artifact/资料" } });
    expect(actual[1].headers["Mcp-Name"]).toBe("=?base64?Zml4dHVyZTovL2FydGlmYWN0L+i1hOaWmQ==?=");
    expect(actual[2].request).toMatchObject({ method: "prompts/get", params: { name: "=?base64?literal?=" } });
    expect(actual[2].headers["Mcp-Name"]).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
    expect(actual[3].request).toMatchObject({ method: "tools/list", params: {} });
    expect(actual[3].headers).not.toHaveProperty("Mcp-Name");
  });

  it("rejects initialize at the modern boundary", () => {
    expect(() => buildModernRequest({ id: 1, method: "initialize", params: {}, protocolVersion: "2026-07-28", headers: {} })).toThrowError(/initialize sessions/u);
  });
});
