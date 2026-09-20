import { describe, expect, it } from "vitest";
import { createModernUpstreamAdapter, buildModernRequest } from "@meshrix/protocols/mcp/modern-upstream";
import { route, response } from "../support";

describe("modern MCP upstream adapter", () => {
  it("[CASE-L02] does not send initialize and preserves request-level state and full params", async () => {
    const calls: Array<{ request: Readonly<Record<string, unknown>>; headers: Readonly<Record<string, string>> }> = [];
    const adapter = createModernUpstreamAdapter({
      transport: {
        async send(input) { calls.push(input); return response({ resultType: "complete", value: { ok: true } }); }
      }
    });
    await adapter.invoke({ request: { id: 1, method: "tools/call", params: { name: "demo", arguments: { traceId: "business" } }, protocolVersion: "2026-07-28", requestState: "opaque-upstream-state", headers: {} }, route: route({ upstreamName: "server-tool" }) });
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toMatchObject({ method: "tools/call", params: { name: "demo", requestState: "opaque-upstream-state" } });
    expect(calls[0].headers).toMatchObject({ "Mcp-Method": "tools/call", "Mcp-Protocol-Version": "2026-07-28", "Mcp-Name": "server-tool" });
    expect(calls[0].request.method).not.toBe("initialize");
  });

  it("rejects initialize at the modern boundary", () => {
    expect(() => buildModernRequest({ id: 1, method: "initialize", params: {}, protocolVersion: "2026-07-28", headers: {} })).toThrowError(/initialize sessions/u);
  });
});

