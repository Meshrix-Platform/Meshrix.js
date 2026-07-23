import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureMcpNotificationBus,
  handleLicoMcpHttpRequest
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import {
  MCP_SSE_CONNECTION_LIMITS,
  broadcastMcpNotification,
  getMcpSseConnectionState,
  registerMcpSseConnection,
  resetMcpSseConnectionStateForTests
} from "../../../packages/server-runtime/src/state/sse-connection-state.mjs";

function responseFixture({ writeResult = true } = {}) {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    write: vi.fn(() => writeResult),
    end(chunk = "") {
      if (chunk) this.chunks.push(String(chunk));
      this.writableEnded = true;
    },
    destroy: vi.fn(function destroy() {
      this.destroyed = true;
    })
  };
}

function connectionFixture({
  grantId,
  remoteAddress,
  writeResult = true
}) {
  const request = new EventEmitter();
  request.socket = { remoteAddress };
  const response = responseFixture({ writeResult });
  const registration = registerMcpSseConnection({
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

function closeFixtures(fixtures) {
  for (const fixture of fixtures) fixture.request.emit("close");
}

afterEach(() => {
  configureMcpNotificationBus();
  resetMcpSseConnectionStateForTests();
  expect(getMcpSseConnectionState().activeConnectionCount).toBe(0);
});

describe("MCP SSE admission", () => {
  it("requires authentication before opening a persistent MCP stream", async () => {
    const request = new EventEmitter();
    request.method = "GET";
    request.url = "/mcp";
    request.headers = {};
    request.socket = { remoteAddress: "127.0.0.1" };
    const response = responseFixture();
    const authorizeRequest = vi.fn();

    await handleLicoMcpHttpRequest({
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

  it("binds an authenticated stream to its current opaque audience partition", async () => {
    configureMcpNotificationBus({ registerSseConnection: registerMcpSseConnection });
    const request = new EventEmitter();
    request.method = "GET";
    request.url = "/mcp?capability=upstream.catalog.list_changed";
    request.headers = {
      authorization: "Bearer redacted",
      "x-licomesh-mcp-proxy-session": "abcdefghijklmnopqrstuvwx"
    };
    request.socket = { remoteAddress: "127.0.0.2" };
    const response = responseFixture();
    const audiencePartitionKeys = vi.fn(() => ["opaque-partition-a"]);

    await handleLicoMcpHttpRequest({
      request,
      response,
      requestBody: Buffer.alloc(0),
      method: "GET",
      url: new URL("http://127.0.0.1/mcp?capability=upstream.catalog.list_changed"),
      toolSkillManagementProvider: {
        authorizeRequest: vi.fn(async () => ({ ok: true, grant: { id: "grant-stream" } })),
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

  it("authenticates and routes connector convergence acknowledgements through the server port", async () => {
    const acknowledgeCatalogConvergence = vi.fn(() => ({
      ok: true,
      appliedConnectionCount: 1
    }));
    configureMcpNotificationBus({ acknowledgeCatalogConvergence });
    const request = new EventEmitter();
    request.method = "POST";
    request.url = "/mcp";
    request.headers = {
      authorization: "Bearer redacted",
      "x-licomesh-mcp-proxy-session": "abcdefghijklmnopqrstuvwx"
    };
    request.socket = { remoteAddress: "127.0.0.7" };
    const response = responseFixture();
    const message = {
      jsonrpc: "2.0",
      id: 7,
      method: "lico/catalog/acknowledge",
      params: {
        sourceRevision: 2,
        catalogRevision: "catalog-2",
        audienceRevision: 3,
        partitionKeys: ["opaque-partition-a"]
      }
    };
    const requestBody = Buffer.from(JSON.stringify(message));
    const authorizeRequest = vi.fn(async () => ({ ok: true, grant: { id: "grant-stream" } }));

    await handleLicoMcpHttpRequest({
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

  it("enforces per-grant, per-address, and total connection limits", () => {
    const grantFixtures = Array.from(
      { length: MCP_SSE_CONNECTION_LIMITS.perGrant },
      (_, index) => connectionFixture({
        grantId: "grant-shared",
        remoteAddress: `127.0.1.${index + 1}`
      })
    );
    expect(grantFixtures.every(({ registration }) => registration.ok)).toBe(true);
    expect(connectionFixture({
      grantId: "grant-shared",
      remoteAddress: "127.0.2.1"
    }).registration).toMatchObject({
      ok: false,
      status: 429,
      code: "mcp_sse_grant_capacity_exceeded"
    });
    closeFixtures(grantFixtures);

    const addressFixtures = Array.from(
      { length: MCP_SSE_CONNECTION_LIMITS.perRemoteAddress },
      (_, index) => connectionFixture({
        grantId: `grant-address-${index}`,
        remoteAddress: "127.0.3.1"
      })
    );
    expect(addressFixtures.every(({ registration }) => registration.ok)).toBe(true);
    expect(connectionFixture({
      grantId: "grant-address-overflow",
      remoteAddress: "127.0.3.1"
    }).registration).toMatchObject({
      ok: false,
      status: 429,
      code: "mcp_sse_remote_capacity_exceeded"
    });
    closeFixtures(addressFixtures);

    const totalFixtures = Array.from(
      { length: MCP_SSE_CONNECTION_LIMITS.total },
      (_, index) => connectionFixture({
        grantId: `grant-total-${index}`,
        remoteAddress: `test-address-${index}`
      })
    );
    expect(totalFixtures.every(({ registration }) => registration.ok)).toBe(true);
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

  it("closes a slow consumer instead of buffering notification fan-out", () => {
    const fixture = connectionFixture({
      grantId: "grant-slow",
      remoteAddress: "127.0.0.5",
      writeResult: false
    });
    expect(fixture.registration.ok).toBe(true);

    const delivery = broadcastMcpNotification(
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
