import { describe, expect, it } from "vitest";
import { createLegacyMcpAdapter, LEGACY_MCP_VERSIONS } from "@meshrix/protocols/mcp/legacy";
import { response, route } from "../support";

describe("isolated legacy MCP adapter", () => {
  it("[CASE-P08] supports declared legacy versions with one initialization and exact state forwarding", async () => {
    const calls: Array<{ request: Readonly<Record<string, unknown>>; headers: Readonly<Record<string, string>> }> = [];
    const adapter = createLegacyMcpAdapter({
      version: LEGACY_MCP_VERSIONS[0],
      transport: {
        async send(input) { calls.push(input); return calls.length === 1 ? response({ result: { sessionId: "legacy-session" } }) : response({ resultType: "complete", value: { ok: true } }); }
      }
    });
    await adapter.invoke({ request: { id: 1, method: "tools/call", params: { name: "demo" }, protocolVersion: "2026-07-28", requestState: "opaque", headers: {} }, route: route({ protocolVersion: LEGACY_MCP_VERSIONS[0] }) });
    await adapter.invoke({ request: { id: 2, method: "tools/call", params: { name: "demo" }, protocolVersion: LEGACY_MCP_VERSIONS[0], requestState: "opaque", headers: {} }, route: route({ protocolVersion: LEGACY_MCP_VERSIONS[0] }) });
    expect(calls).toHaveLength(3);
    expect(calls[0].request.method).toBe("initialize");
    expect(calls[2].headers["Mcp-Session-Id"]).toBe("legacy-session");
    expect(calls[2].request.params).toMatchObject({ requestState: "opaque" });
    await adapter.close();
  });

  it("rejects an undeclared legacy version rather than silently using modern semantics", () => {
    expect(() => createLegacyMcpAdapter({ version: "2024-01-01", transport: { send: async () => response({}) } })).toThrowError(/Unsupported legacy/u);
  });
});
