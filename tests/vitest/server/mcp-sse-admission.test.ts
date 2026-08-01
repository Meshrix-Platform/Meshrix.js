import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureMcpNotificationBus,
  handleMeshrixMcpHttpRequest
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import {
  MCP_SSE_CONNECTION_LIMITS,
  broadcastMcpNotification,
  getMcpSseConnectionState,
  registerMcpSseConnection,
  resetMcpSseConnectionStateForTests
} from "../../../packages/server-runtime/src/state/sse-connection-state.ts";

function responseFixture({ writeResult = true }: Record<string, any> = {}) : any {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    write: vi.fn(() : any => writeResult),
    end(chunk: any = "") : any {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
    },
    destroy: vi.fn(function destroy() : any {
      this.destroyed = true;
    })
  };
}

function connectionFixture({
  grantId,
  remoteAddress,
  writeResult = true
}: Record<string, any>) : any {
  const request: any = new EventEmitter();
  request.socket = { remoteAddress };
  const response: any = responseFixture({ writeResult });
  const registration: any = registerMcpSseConnection({
    request,
    response,
    grantId,
    grant: { id: grantId },
    privateOnly: true,
    negotiatedCapabilities: ["upstream.catalog.list_changed"],
    proxySessionId: "abcdefghijklmnopqrstuvwx"
  });
  return { request, response, registration };
}

function closeFixtures(fixtures?: any) : any {
  for (const fixture of fixtures) fixture.request.emit("close");
}

afterEach(() : any => {
  configureMcpNotificationBus();
  resetMcpSseConnectionStateForTests();
  expect(getMcpSseConnectionState().activeConnectionCount).toBe(0);
});

describe("MCP SSE admission", () : any => {
  it("requires authentication before opening a persistent MCP stream", async () : Promise<any> => {
    const request: any = new EventEmitter();
    request.method = "GET";
    request.url = "/mcp";
    request.headers = {};
    request.socket = { remoteAddress: "127.0.0.1" };
    const response: any = responseFixture();
    const authorizeRequest: any = vi.fn();

    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.alloc(0),
      method: "GET",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: { authorizeRequest }
    });

    expect(response.statusCode).toBe(401);
    expect(authorizeRequest).not.toHaveBeenCalled();
    expect(JSON.parse(response.chunks.join(""))?.error?.data?.code)
      .toBe("mcp_sse_authentication_required");
  });

  it("binds an authenticated stream to its current opaque audience partition", async () : Promise<any> => {
    configureMcpNotificationBus({ registerSseConnection: registerMcpSseConnection });
    const request: any = new EventEmitter();
    request.method = "GET";
    request.url = "/mcp?capability=upstream.catalog.list_changed";
    request.headers = {
      authorization: "Bearer redacted",
      "x-meshrix-mcp-proxy-session": "abcdefghijklmnopqrstuvwx"
    };
    request.socket = { remoteAddress: "127.0.0.2" };
    const response: any = responseFixture();
    const audiencePartitionKeys: any = vi.fn(() : any => ["opaque-partition-a"]);

    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.alloc(0),
      method: "GET",
      url: new URL("http://127.0.0.1/mcp?capability=upstream.catalog.list_changed"),
      toolSkillManagementProvider: {
        authorizeRequest: vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "grant-stream" } })),
        audiencePartitionKeys
      }
    });

    expect(response.statusCode).toBe(200);
    expect(audiencePartitionKeys).toHaveBeenCalledOnce();
    expect(getMcpSseConnectionState()).toMatchObject({
      activeConnectionCount: 1,
      partitionCount: 1
    });
    expect(broadcastMcpNotification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {
        change: {
          sourceRevision: 1,
          catalogRevision: "catalog-1",
          audienceRevision: 1,
          affectedPartitions: ["opaque-partition-a"]
        }
      }
    }, { partitionKeys: ["opaque-partition-a"] })).toMatchObject({
      deliveredConnectionCount: 1
    });
    request.emit("close");
  });

  it("authenticates and routes connector convergence acknowledgements through the server port", async () : Promise<any> => {
    const acknowledgeCatalogConvergence: any = vi.fn(() : any => ({
      ok: true,
      appliedConnectionCount: 1
    }));
    configureMcpNotificationBus({ acknowledgeCatalogConvergence });
    const request: any = new EventEmitter();
    request.method = "POST";
    request.url = "/mcp";
    request.headers = {
      authorization: "Bearer redacted",
      "x-meshrix-mcp-proxy-session": "abcdefghijklmnopqrstuvwx"
    };
    request.socket = { remoteAddress: "127.0.0.7" };
    const response: any = responseFixture();
    const message: Record<string, any> = {
      jsonrpc: "2.0",
      id: 7,
      method: "meshrix/catalog/acknowledge",
      params: {
        sourceRevision: 2,
        catalogRevision: "catalog-2",
        audienceRevision: 3,
        partitionKeys: ["opaque-partition-a"]
      }
    };
    const requestBody: any = Buffer.from(JSON.stringify(message));
    const authorizeRequest: any = vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "grant-stream" } }));

    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody,
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: { authorizeRequest }
    });

    expect(authorizeRequest).toHaveBeenCalledOnce();
    expect(acknowledgeCatalogConvergence).toHaveBeenCalledWith({
      grantId: "grant-stream",
      proxySessionId: "abcdefghijklmnopqrstuvwx",
      sourceRevision: 2,
      catalogRevision: "catalog-2",
      audienceRevision: 3,
      partitionKeys: ["opaque-partition-a"]
    });
    expect(response.statusCode).toBe(200);
  });

  it("enforces per-grant, per-address, and total connection limits", () : any => {
    const grantFixtures: any = Array.from(
      { length: MCP_SSE_CONNECTION_LIMITS.perGrant },
      (_?: any, index?: any) : any => connectionFixture({
        grantId: "grant-shared",
        remoteAddress: `127.0.1.${index + 1}`
      })
    );
    expect(grantFixtures.every(({ registration }: Record<string, any>) : any => registration.ok)).toBe(true);
    expect(connectionFixture({
      grantId: "grant-shared",
      remoteAddress: "127.0.2.1"
    }).registration).toMatchObject({
      ok: false,
      status: 429,
      code: "mcp_sse_grant_capacity_exceeded"
    });
    closeFixtures(grantFixtures);

    const addressFixtures: any = Array.from(
      { length: MCP_SSE_CONNECTION_LIMITS.perRemoteAddress },
      (_?: any, index?: any) : any => connectionFixture({
        grantId: `grant-address-${index}`,
        remoteAddress: "127.0.3.1"
      })
    );
    expect(addressFixtures.every(({ registration }: Record<string, any>) : any => registration.ok)).toBe(true);
    expect(connectionFixture({
      grantId: "grant-address-overflow",
      remoteAddress: "127.0.3.1"
    }).registration).toMatchObject({
      ok: false,
      status: 429,
      code: "mcp_sse_remote_capacity_exceeded"
    });
    closeFixtures(addressFixtures);

    const totalFixtures: any = Array.from(
      { length: MCP_SSE_CONNECTION_LIMITS.total },
      (_?: any, index?: any) : any => connectionFixture({
        grantId: `grant-total-${index}`,
        remoteAddress: `test-address-${index}`
      })
    );
    expect(totalFixtures.every(({ registration }: Record<string, any>) : any => registration.ok)).toBe(true);
    expect(connectionFixture({
      grantId: "grant-total-overflow",
      remoteAddress: "test-address-overflow"
    }).registration).toMatchObject({
      ok: false,
      status: 429,
      code: "mcp_sse_total_capacity_exceeded"
    });
    closeFixtures(totalFixtures);
    expect(getMcpSseConnectionState()).toMatchObject({
      activeConnectionCount: 0,
      heartbeatSchedulerActive: false,
      remoteAddressCount: 0,
      grantCount: 0
    });
  });

  it("closes a slow consumer instead of buffering notification fan-out", () : any => {
    const fixture: any = connectionFixture({
      grantId: "grant-slow",
      remoteAddress: "127.0.0.5",
      writeResult: false
    });
    expect(fixture.registration.ok).toBe(true);

    const delivery: any = broadcastMcpNotification(
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      { grantId: "grant-slow" }
    );

    expect(delivery).toMatchObject({
      activeConnectionCount: 0,
      matchedConnectionCount: 1,
      deliveredConnectionCount: 0
    });
    expect(fixture.response.destroy).toHaveBeenCalledOnce();
  });
});
