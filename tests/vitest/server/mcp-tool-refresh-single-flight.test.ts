import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

describe("MCP tool refresh single-flight", () : any => {
  it("shares a modern HTTP refresh while a canceled caller leaves another waiter active", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-modern-refresh-flight-"));
    const requests: string[] = [];
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    let startDiscovery!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => { startDiscovery = resolve; });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(wire.method);
      if (wire.method === "server/discover") {
        startDiscovery();
        await discoveryGate;
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: wire.id,
          result: { resultType: "complete", supportedVersions: ["2026-07-28"] }
        }));
        return;
      }
      if (wire.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: wire.id,
          result: { resultType: "complete", tools: [{ name: "records.list", inputSchema: { type: "object" } }] }
        }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic modern MCP peer did not bind.");
    const registry: any = createUpstreamGatewayRegistry({ userDataPath: root });

    try {
      await installUpstreamRuntimeServices(registry, [{
        serviceId: "modern-flight-service",
        serviceProtocol: "mcp",
        allowLocalNetwork: true,
        mcp: {
          transport: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          protocolVersion: "2026-07-28",
          toolsCacheTtlMs: 60_000
        }
      }]);
      const creator = new AbortController();
      const follower = new AbortController();
      const first = registry.listMcpTools({ serviceId: "modern-flight-service" }, { signal: creator.signal });
      await discoveryStarted;
      const second = registry.listMcpTools({ serviceId: "modern-flight-service" }, { signal: follower.signal });

      creator.abort();
      await expect(first).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      releaseDiscovery();

      const listed = await second;
      expect(listed.items).toEqual([
        expect.objectContaining({ name: "upstream.modern-flight-service.records.list" })
      ]);
      expect(requests).toEqual(["server/discover", "tools/list"]);
    } finally {
      releaseDiscovery();
      await registry.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a shared refresh independent of cancelling creator and follower waiters", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-refresh-flight-"));
    let listStarted: any;
    const started: any = new Promise((resolve?: any) : any => {
      listStarted = resolve;
    });
    let listCalls: any = 0;
    let shouldFail: any = false;
    const listTools: any = async (_config?: any, options?: any) : Promise<any> => {
      listCalls += 1;
      listStarted();
      if (shouldFail) {
        throw new Error("boom");
      }
      await new Promise((resolve?: any, reject?: any) : any => {
        const timer: any = setTimeout(resolve, 80);
        options?.signal?.addEventListener?.("abort", () : any => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      return {
        tools: [{ name: "records.list", inputSchema: { type: "object" } }]
      };
    };
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath: root,
      mcpSessionManager: {
        listTools,
        callTool: async () : Promise<any> => ({ result: {} }),
        async retireServiceScopes() : Promise<any> { return { retired: 0 }; },
        async close() : Promise<any> {}
      }
    });
    installUpstreamRuntimeServices(registry, [{
      serviceId: "flight-service",
      serviceProtocol: "mcp",
      mcp: {
        transport: "http",
        url: "https://example.invalid:443/mcp",
        toolNamePrefix: "flight-service",
        toolsCacheTtlMs: 60_000
      }
    }]);
    try {
      const creator: any = new AbortController();
      const follower: any = new AbortController();
      const first: any = registry.listMcpTools({ serviceId: "flight-service" }, { signal: creator.signal });
      await started;
      const second: any = registry.listMcpTools({ serviceId: "flight-service" }, { signal: follower.signal });
      creator.abort();
      await expect(first).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      const followerResult: any = await second;
      expect(followerResult.items).toEqual([
        expect.objectContaining({ name: "upstream.flight-service.records.list" })
      ]);
      expect(listCalls).toBe(1);

      const cached: any = await registry.listMcpTools({ serviceId: "flight-service" });
      expect(cached.count).toBe(1);
      expect(listCalls).toBe(1);

      const refreshA: any = new AbortController();
      const refreshB: any = new AbortController();
      const fourth: any = registry.listMcpTools({ serviceId: "flight-service", refresh: true }, { signal: refreshA.signal });
      await delay(5);
      const fifth: any = registry.listMcpTools({ serviceId: "flight-service", refresh: true }, { signal: refreshB.signal });
      refreshB.abort();
      await expect(fifth).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      const creatorRefresh: any = await fourth;
      expect(creatorRefresh.count).toBe(1);
      expect(listCalls).toBe(2);

      shouldFail = true;
      const unhandled: any[] = [];
      const onUnhandled: any = (reason?: any) : any => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        await expect(registry.listMcpTools({ serviceId: "flight-service", refresh: true }))
          .rejects.toMatchObject({ reasonCode: "upstream_mcp_discovery_failed" });
        await delay(20);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      shouldFail = false;
      const retried: any = await registry.listMcpTools({ serviceId: "flight-service", refresh: true });
      expect(retried.count).toBe(1);
      expect(listCalls).toBe(4);

      listStarted = undefined;
      const orphanStarted: any = new Promise((resolve?: any) : any => {
        listStarted = resolve;
      });
      const orphan: any = new AbortController();
      const orphanRefresh: any = registry.listMcpTools({ serviceId: "flight-service", refresh: true }, { signal: orphan.signal });
      await orphanStarted;
      orphan.abort();
      await expect(orphanRefresh).rejects.toMatchObject({ reasonCode: "upstream_mcp_cancelled" });
      await delay(20);
      const afterOrphan: any = await registry.listMcpTools({ serviceId: "flight-service", refresh: true });
      expect(afterOrphan.count).toBe(1);
      expect(listCalls).toBe(6);
    } finally {
      await registry.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
