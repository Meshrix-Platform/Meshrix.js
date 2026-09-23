import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createLegacyMcpAdapter, LEGACY_MCP_VERSIONS } from "@meshrix/protocols/mcp/legacy";
import { context, route } from "../support";

function request(version: string, id: number) {
  return { context, route: route({ protocolVersion: version }), request: { id, method: "tools/call", params: { name: "demo" }, headers: {}, protocolVersion: version } };
}

describe("legacy sessions in the declared profiles", () => {
  for (const version of LEGACY_MCP_VERSIONS) {
    it(`[GC-035 GC-036 GC-037] ${version} negotiates once, sends initialized and isolates credentials`, async () => {
      const calls: Array<{ method: unknown; headers: Readonly<Record<string, string>> }> = [];
      const adapter = createLegacyMcpAdapter({ version, transport: { async send(input) {
        calls.push({ method: input.request.method, headers: input.headers });
        if (input.request.method === "initialize") return { status: 200, headers: { "mcp-session-id": "synthetic-session" }, body: { result: { protocolVersion: version } } };
        return { status: 200, body: { result: { content: [{ type: "text", text: "ok" }] } } };
      } } });
      try {
        await Promise.all(Array.from({ length: 20 }, (_, id) => adapter.invoke({ ...request(version, id), credential: { Authorization: "Bearer synthetic" } })));
        expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "notifications/initialized")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(20);
        expect(calls.every((call) => call.headers.Authorization === "Bearer synthetic")).toBe(true);
        expect(calls.filter((call) => call.method === "tools/call").every((call) => call.headers["Mcp-Session-Id"] === "synthetic-session")).toBe(true);
      } finally { await adapter.close(); }
    });
  }

  for (const version of LEGACY_MCP_VERSIONS) {
    it(`[GC-035 GC-036 GC-037 GC-038] ${version} uses a real HTTP peer and never silently recreates a lost session`, async () => {
      let initializeCount = 0;
      let effectCount = 0;
      const peer = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (request.headers["mcp-protocol-version"] !== version || request.headers.authorization !== "Bearer synthetic") { response.writeHead(403).end(); return; }
        if (wire.method === "initialize") initializeCount += 1;
        if (wire.method === "tools/call") effectCount += 1;
        const status = wire.method === "tools/call" && effectCount > 2 ? 404 : wire.method === "notifications/initialized" ? 202 : 200;
        const result = wire.method === "initialize" ? { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
          : { content: [{ type: "text", text: "peer" }] };
        response.writeHead(status, { "content-type": "application/json", ...(wire.method === "initialize" ? { "Mcp-Session-Id": "session-synthetic" } : {}) });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id ?? null, result }));
      });
      await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("Synthetic legacy peer has no listener.");
      const endpoint = `http://127.0.0.1:${address.port}/mcp`;
      const adapter = createLegacyMcpAdapter({ version, transport: { async send(input) {
        const response = await fetch(endpoint, { method: "POST", headers: input.headers, body: JSON.stringify(input.request), signal: input.signal });
        const text = await response.text();
        return { status: response.status, headers: Object.fromEntries(response.headers), body: text ? JSON.parse(text) : null };
      } } });
      try {
        const invoke = (id: number) => adapter.invoke({ ...request(version, id), credential: { Authorization: "Bearer synthetic" } });
        expect((await invoke(1)).status).toBe(200);
        expect((await invoke(2)).status).toBe(200);
        expect((await invoke(3)).status).toBe(404);
        await expect(invoke(4)).rejects.toMatchObject({ code: "legacy_session_lost" });
        expect(initializeCount).toBe(1);
        expect(effectCount).toBe(3);
      } finally { await adapter.close(); await new Promise<void>((resolve) => peer.close(() => resolve())); }
    }, 10_000);
  }

  it("[GC-038] never reconstructs lost sessions after an upstream 404", async () => {
    let initializeCount = 0;
    const version = LEGACY_MCP_VERSIONS[0];
    const adapter = createLegacyMcpAdapter({ version, transport: { async send(input) {
      if (input.request.method === "initialize") { initializeCount += 1; return { status: 200, headers: { "Mcp-Session-Id": "synthetic" }, body: { result: { protocolVersion: version } } }; }
      return { status: input.request.method === "tools/call" ? 404 : 202, body: {} };
    } } });
    try {
      expect((await adapter.invoke(request(version, 1))).status).toBe(404);
      await expect(adapter.invoke(request(version, 2))).rejects.toMatchObject({ code: "legacy_session_lost" });
      expect(initializeCount).toBe(1);
    } finally { await adapter.close(); }
  });
});
