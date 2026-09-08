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
import { mcpModernBody, mcpModernHeaders } from "../../helpers/mcp-downstream-request.ts";

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
    negotiatedCapabilities: ["notifications/tools/list_changed"],
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

describe("MCP subscription admission", () : any => {
  it("rejects the removed GET stream registration path", async () : Promise<any> => {
    const request: any = new EventEmitter();
    request.method = "GET";
    request.url = "/mcp";
    request.headers = { authorization: "Bearer redacted" };
    request.socket = { remoteAddress: "127.0.0.9" };
    const response: any = responseFixture();
    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.alloc(0),
      method: "GET",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: {}
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe("POST");
  });

  it("requires authentication before opening a persistent MCP stream", async () : Promise<any> => {
    const request: any = new EventEmitter();
    request.method = "POST";
    request.url = "/mcp";
    request.headers = {};
    request.socket = { remoteAddress: "127.0.0.1" };
    const response: any = responseFixture();
    const authorizeMcpClientRequest: any = vi.fn();

    const listenBody: any = mcpModernBody({
      jsonrpc: "2.0",
      id: 1,
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true } }
    });
    request.headers = {
      ...request.headers,
      ...mcpModernHeaders(listenBody)
    };
    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.from(JSON.stringify(listenBody)),
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: { authorizeMcpClientRequest }
    });

    expect(response.statusCode).toBe(401);
    expect(authorizeMcpClientRequest).not.toHaveBeenCalled();
    expect(JSON.parse(response.chunks.join(""))?.error?.data?.code)
      .toBe("mcp_subscription_authentication_required");
  });

  it("binds an authenticated stream to its current opaque audience partition", async () : Promise<any> => {
    configureMcpNotificationBus({ registerSseConnection: registerMcpSseConnection });
    const request: any = new EventEmitter();
    request.method = "POST";
    request.url = "/mcp";
    const listenBody: any = mcpModernBody({
      jsonrpc: "2.0",
      id: 2,
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true } }
    });
    request.headers = {
      authorization: "Bearer redacted",
      ...mcpModernHeaders(listenBody)
    };
    request.socket = { remoteAddress: "127.0.0.2" };
    const response: any = responseFixture();
    const audiencePartitionKeys: any = vi.fn(() : any => ["opaque-partition-a"]);

    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.from(JSON.stringify(listenBody)),
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "grant-stream" } })),
        audiencePartitionKeys
      }
    });

    expect(response.statusCode).toBe(200);
    const ack: any = JSON.parse(String(response.write.mock.calls[0][0]).replace(/^event: message\ndata: /, "").replace(/\n\n$/, ""));
    expect(ack).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { toolsListChanged: true },
        _meta: { "io.modelcontextprotocol/subscriptionId": 2 }
      }
    });
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
    const delivered: any = JSON.parse(String(response.write.mock.calls.at(-1)[0]).replace(/^event: message\ndata: /, "").replace(/\n\n$/, ""));
    expect(delivered.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe(2);
    request.emit("close");
  });

  it("accepts an empty or unsupported filter without failing the stream", async () : Promise<any> => {
    configureMcpNotificationBus({ registerSseConnection: registerMcpSseConnection });
    const request: any = new EventEmitter();
    request.method = "POST";
    request.url = "/mcp";
    const listenBody: any = mcpModernBody({
      jsonrpc: "2.0",
      id: "sub-empty",
      method: "subscriptions/listen",
      params: {
        notifications: {
          toolsListChanged: false,
          promptsListChanged: true,
          unknownCapability: true
        }
      }
    });
    request.headers = {
      authorization: "Bearer redacted",
      ...mcpModernHeaders(listenBody)
    };
    request.socket = { remoteAddress: "127.0.0.8" };
    const response: any = responseFixture();
    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.from(JSON.stringify(listenBody)),
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "grant-empty" } }))
      }
    });
    expect(response.statusCode).toBe(200);
    const ack: any = JSON.parse(String(response.write.mock.calls[0][0]).replace(/^event: message\ndata: /, "").replace(/\n\n$/, ""));
    expect(ack.params.notifications).toEqual({});
    expect(ack.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe("sub-empty");
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
      "x-meshrix.js-mcp-proxy-session": "abcdefghijklmnopqrstuvwx"
    };
    request.socket = { remoteAddress: "127.0.0.7" };
    const response: any = responseFixture();
    const message: Record<string, any> = mcpModernBody({
      jsonrpc: "2.0",
      id: 7,
      method: "meshrix/catalog/acknowledge",
      params: {
        sourceRevision: 2,
        catalogRevision: "catalog-2",
        audienceRevision: 3,
        partitionKeys: ["opaque-partition-a"]
      }
    });
    const requestBody: any = Buffer.from(JSON.stringify(message));
    request.headers = {
      ...request.headers,
      ...mcpModernHeaders(message)
    };
    const authorizeMcpClientRequest: any = vi.fn(async () : Promise<any> => ({ ok: true, grant: { id: "grant-stream" } }));

    await handleMeshrixMcpHttpRequest({
      request,
      response,
      requestBody,
      method: "POST",
      url: new URL("http://127.0.0.1/mcp"),
      toolSkillManagementProvider: { authorizeMcpClientRequest }
    });

    expect(authorizeMcpClientRequest).toHaveBeenCalledOnce();
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

  it("removes a subscription when the response stream closes without a request close", () : any => {
    const request: any = new EventEmitter();
    request.socket = { remoteAddress: "127.0.0.8" };
    const response: any = new EventEmitter();
    Object.assign(response, responseFixture());
    const registration: any = registerMcpSseConnection({
      request,
      response,
      grantId: "grant-response-close",
      grant: { id: "grant-response-close" },
      privateOnly: true,
      negotiatedCapabilities: ["notifications/tools/list_changed"],
      proxySessionId: "abcdefghijklmnopqrstuvwx"
    });
    expect(registration.ok).toBe(true);
    expect(getMcpSseConnectionState()).toMatchObject({
      activeConnectionCount: 1,
      heartbeatSchedulerActive: true
    });
    response.emit("close");
    expect(getMcpSseConnectionState()).toMatchObject({
      activeConnectionCount: 0,
      heartbeatSchedulerActive: false
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
