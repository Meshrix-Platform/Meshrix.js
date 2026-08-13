import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createGatewayRuntime } from "../../../packages/agents/src/upstream-gateway/registry-runtime.ts";
import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { createCorePlatformProvider } from "../../../packages/server-runtime/src/composition/core-platform-provider.ts";
import {
  findHttpOperation,
  findProxyRegisteredApiRequest,
  findRpcOperation
} from "../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import {
  createOperationRouteIndex,
  getRouteIndexRefactorInstrumentation
} from "../../../packages/server-runtime/src/routing/operation-route-index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";

const cleanupTasks: any[] = [];

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()();
  }
});

function fixtureOperation(id?: any, method?: any, path?: any, rpcMethod: any = id) : any {
  return {
    id,
    target: { controller: "fixture", method: "handle" },
    http: { method, path },
    rpc: { method: rpcMethod },
  };
}

describe("runtime refactor routing and MCP discovery", () : any => {
  it("requires the map-based route index and returns immutable decoded matches", () : any => {
    const operations: any[] = [
      fixtureOperation("workspace.get", "GET", "/api/workspaces/:workspaceId", "workspace.get"),
      fixtureOperation("workspace.list", "GET", "/api/workspaces/list", "workspace.list")
    ];
    expect(findHttpOperation({ operations, method: "GET", pathname: "/api/workspaces/list" }))
      .toBeNull();
    expect(findRpcOperation({ operations, method: "workspace.get" })).toBeNull();

    const index: any = createOperationRouteIndex(operations, { strict: true });
    expect(findHttpOperation({
      operations,
      routeIndex: index,
      method: "GET",
      pathname: "/api/workspaces/team%20alpha"
    })).toMatchObject({
      operation: { id: "workspace.get" },
      pathParams: { workspaceId: "team alpha" }
    });
    expect(findRpcOperation({ operations, routeIndex: index, method: "workspace.get" })?.id)
      .toBe("workspace.get");
    expect(index.findHttpOperation("GET", "/api/workspaces/list"))
      .not.toHaveProperty("routeConfig");
  });

  it("builds one provider route snapshot per revision and reuses it for identical catalogs", () : any => {
    const first: any[] = [
      fixtureOperation("relay.send", "POST", "/api/relay/send", "relay.send")
    ];
    const provider: any = createCorePlatformProvider({ operations: [] });
    const discoveryState: Record<string, any> = {
      mode: "forward",
      advertisedBaseUrl: "https://local.example",
      forwardBaseUrl: "https://upstream.example"
    };

    const snapshotOne: any = provider.getOperationRouteSnapshot({ operations: first });
    expect(snapshotOne).toMatchObject({
      schemaVersion: "v0.0.1:server-runtime:operation-route-snapshot-1",
      size: 1,
      httpRouteCount: 1,
      rpcMethodCount: 1
    });
    const builtAfterOne: any = getRouteIndexRefactorInstrumentation().snapshotBuildCount;

    expect(provider.findProxyRegisteredApiRequest({
      operations: first,
      method: "POST",
      pathname: "/api/relay/send",
      discoveryState
    })?.operation.id).toBe("relay.send");

    const second: any[] = [
      fixtureOperation("relay.send", "POST", "/api/relay/other", "relay.send")
    ];
    const snapshotTwo: any = provider.getOperationRouteSnapshot({ operations: second });
    expect(snapshotTwo.revision).not.toBe(snapshotOne.revision);
    expect(getRouteIndexRefactorInstrumentation().snapshotBuildCount).toBeGreaterThan(builtAfterOne);

    const rebuilt: any = getRouteIndexRefactorInstrumentation().snapshotBuildCount;
    provider.findProxyRegisteredApiRequest({
      operations: second,
      method: "POST",
      pathname: "/api/relay/other",
      discoveryState
    });
    expect(getRouteIndexRefactorInstrumentation().snapshotBuildCount).toBe(rebuilt);
  });

  it("builds the visible-tool snapshot once per catalog fingerprint and serves targeted calls from the map", async () : Promise<any> => {
    const runtimeExecute: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      status: 200,
      payload: {}
    }));
    const registryGetTool: any = vi.fn();
    const tools: any[] = [
      {
        id: "kernel.workspace.read",
        status: "active",
        requiredScopes: [],
        toolsets: ["core"],
        risk: "read_only"
      },
      {
        id: "kernel.workspace.write",
        status: "active",
        requiredScopes: [],
        toolsets: ["core"],
        risk: "safe_write"
      }
    ];
    let fingerprint: any = "fp-1";
    const platform: Record<string, any> = {
      catalog: () : any => ({ fingerprint, tools }),
      registry: { getTool: registryGetTool },
      runtime: { executeTool: runtimeExecute }
    };
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: platform
    });
    const authorization: Record<string, any> = {
      grant: { id: "grant-routing-mcp", scopes: [], toolsets: ["core"], maxRisk: "safe_write", dynamicCapabilities: [] }
    };

    expect(provider.listVisibleTools({ authorization })).toEqual(tools);
    await provider.executeTool({ toolId: "kernel.workspace.write", authorization });
    await provider.executeTool({ toolId: "kernel.workspace.write", authorization });
    expect(provider.listVisibleTools({ authorization })).toEqual(tools);
    expect(provider.getRefactorInstrumentation()).toMatchObject({
      schemaVersion: "v0.0.1:capabilities:visible-tool-snapshot-1",
      snapshotBuildCount: 1,
      catalogEnumerationCount: 1
    });
    expect(registryGetTool).not.toHaveBeenCalled();

    fingerprint = "fp-2";
    await provider.executeTool({ toolId: "kernel.workspace.read", authorization });
    expect(provider.getRefactorInstrumentation()).toMatchObject({
      snapshotBuildCount: 2,
      catalogEnumerationCount: 2
    });
    expect(runtimeExecute).toHaveBeenCalledTimes(3);
  });

  it("calls upstream MCP tools through the per-service public-name map and rediscovers only on expiry", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(
      path.join(os.tmpdir(), "meshrix-routing-mcp-discovery-")
    );
    cleanupTasks.push(() : any => fs.rm(userDataPath, { force: true, recursive: true }));
    const listTools: any = vi.fn(async () : Promise<any> => ({
      tools: [{
        name: "records.list",
        title: "List records",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true }
      }]
    }));
    const callTool: any = vi.fn(async (_config?: any, request?: any) : Promise<any> => ({
      result: {
        structuredContent: {
          ok: true,
          toolName: request.name,
          arguments: request.arguments
        }
      }
    }));
    const registry: any = createUpstreamGatewayRegistry({
      userDataPath,
      mcpSessionManager: {
        listTools,
        callTool,
        async retireScope() : Promise<any> { return { retired: 0 }; },
        async close() : Promise<any> {}
      }
    });
    cleanupTasks.push(() : any => registry.close());
    installUpstreamRuntimeServices(registry, [{
      serviceId: "discovery-fixture",
      serviceProtocol: "mcp",
      label: "Discovery fixture",
      mcp: {
        transport: "http",
        url: "https://example.invalid:443/mcp",
        toolNamePrefix: "discovery-fixture",
        toolsCacheTtlMs: 150
      }
    }]);

    const publicName: any = "upstream.discovery-fixture.records.list";
    const subject: Record<string, any> = { scopes: ["gateway:read"] };
    const first: any = await registry.callMcpToolByPublicName(publicName, { arguments: { owner: "a" } }, subject);
    expect(first).toMatchObject({ ok: true, serviceId: "discovery-fixture" });
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(registry.getRefactorInstrumentation()).toMatchObject({
      targetedCallMapHits: 0,
      targetedServiceIndexHits: 1,
      serviceDiscoveryCount: 1
    });

    const second: any = await registry.callMcpToolByPublicName(publicName, { arguments: { owner: "b" } }, subject);
    expect(second).toMatchObject({ ok: true });
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(registry.getRefactorInstrumentation()).toMatchObject({
      targetedCallMapHits: 1,
      targetedServiceIndexHits: 2,
      serviceDiscoveryCount: 1
    });

    await new Promise((resolve?: any) : any => setTimeout(resolve, 200));
    const third: any = await registry.callMcpToolByPublicName(publicName, { arguments: { owner: "c" } }, subject);
    expect(third).toMatchObject({ ok: true });
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(registry.getRefactorInstrumentation()).toMatchObject({
      targetedCallMapHits: 1,
      targetedServiceIndexHits: 3,
      serviceDiscoveryCount: 2
    });
    expect(callTool.mock.calls.map(([, request]: any[]) : any => request.arguments.owner))
      .toEqual(["a", "b", "c"]);
  });

  it("migrates legacy gateway state once and deletes the verified old authority", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-gateway-migration-"));
    cleanupTasks.push(() : any => fs.rm(userDataPath, { force: true, recursive: true }));
    const filePath: any = path.join(userDataPath, "upstream-gateway", "runtime.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      schemaVersion: "v0.0.1:schema:definition-1",
      auditEvents: [{ auditId: "audit-legacy", createdAt: "2026-01-01T00:00:00.000Z" }],
      metrics: {
        totalForwardCount: 7,
        totalFailureCount: 2,
        byService: { fixture: 7 },
        byStatus: { "200": 5, "500": 2 }
      }
    }));

    const migrated: any = createGatewayRuntime({ persistenceEnabled: true, filePath });
    await migrated.close();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });

    const recovered: any = createGatewayRuntime({
      persistenceEnabled: true,
      filePath,
      auditRingLimit: 8
    });
    await recovered.persist();
    expect(recovered.metrics).toMatchObject({
      totalForwardCount: 7,
      totalFailureCount: 2,
      byService: { fixture: 7 }
    });
    expect(recovered.auditEvents).toHaveLength(1);
    await recovered.close();
  });

  it("serializes concurrent gateway flushes and preserves totals across bounded compaction", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-gateway-wal-"));
    cleanupTasks.push(() : any => fs.rm(userDataPath, { force: true, recursive: true }));
    const filePath: any = path.join(userDataPath, "upstream-gateway", "runtime.json");
    const runtime: any = createGatewayRuntime({
      persistenceEnabled: true,
      filePath,
      auditRingLimit: 8,
      flushBatchSize: 2,
      walMaxBytes: 64 * 1024
    });
    for (let batch: any = 0; batch < 20; batch += 1) {
      for (let index: any = 0; index < 2; index += 1) {
        runtime.recordMetric({ serviceId: "fixture", statusCode: 200 });
        runtime.appendAudit("fixture.forwarded", {
          serviceId: "fixture",
          operationKey: "read",
          summary: "x".repeat(2_000)
        });
      }
      await Promise.all([runtime.persist(), runtime.persist()]);
    }
    await runtime.close();
    expect(runtime.getRefactorInstrumentation()).toMatchObject({
      requestPathFullStateReads: 0,
      requestPathFullStateRewrites: 0,
      flushFailureCount: 0
    });
    expect(runtime.getRefactorInstrumentation().compactionCount).toBeGreaterThan(0);

    const recovered: any = createGatewayRuntime({
      persistenceEnabled: true,
      filePath,
      auditRingLimit: 8
    });
    await recovered.persist();
    expect(recovered.metrics.totalForwardCount).toBe(40);
    expect(recovered.auditEvents).toHaveLength(8);
    expect(recovered.getRefactorInstrumentation().walBytes).toBeLessThanOrEqual(64 * 1024);
    await recovered.close();
  });

  it("keeps proxy and local prefix selection stable under the required route index", () : any => {
    const provider: any = createCorePlatformProvider({ operations: [] });
    expect(provider.listInterfaceCatalog()).toEqual([]);
    const localOperation: any = fixtureOperation("local.jobs", "GET", "/api/jobs/:jobId", "local.jobs");
    expect(findProxyRegisteredApiRequest({
      method: "GET",
      pathname: "/api/%6Aobs/example",
      discoveryState: {
        mode: "forward",
        advertisedBaseUrl: "https://local.example",
        forwardBaseUrl: "https://upstream.example"
      },
      operations: [localOperation],
      routeIndex: createOperationRouteIndex([localOperation], { strict: true })
    })).toBeNull();
  });
});
