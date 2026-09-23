import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createHttpServerRequestHandler } from "../../../../apps/server/runtime/http-server-routes.ts";
import { createPlatformMcpGateway } from "../../../../packages/server-runtime/src/composition/gateway-composition.ts";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME
} from "../../../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";

class CapturedResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string): unknown {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, headers: Record<string, unknown> = {}): void {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }

  write(chunk: unknown): void {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(String(chunk)));
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.emit("finish");
  }
}

function handlerFor(adapter: Record<string, unknown>): ReturnType<typeof createHttpServerRequestHandler> {
  return createHttpServerRequestHandler({
    activeApiOperations: [],
    consoleAuth: {},
    controllers: {},
    distPath: "",
    getDiscoveryState: () => ({}),
    getListenUrl: () => "http://127.0.0.1",
    getOperationPermissionPlatform: () => null,
    lifecycle: {
      beginRequest: () => new AbortController(),
      endRequest: vi.fn(),
      markSocketActive: vi.fn(),
      markSocketIdle: vi.fn()
    },
    loginRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    operationAuditStore: null,
    operationConcurrencyScope: "gateway-cutover-test",
    platformMcpGatewayAdapter: adapter,
    proxyApiRequest: vi.fn(),
    rateLimits: { windowMs: 1_000 },
    registeredCoreProvider: {
      findProxyRegisteredApiRequest: () => null,
      dispatchRegisteredHttpOperation: vi.fn()
    },
    runtimeLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    securityPermissions: {
      authorizeOperation: vi.fn(async () => ({ ok: true })),
      verifyProcessIdentity: vi.fn(async () => ({ ok: true }))
    },
    subjectRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    tenantRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    toolSkillManagementProvider: {},
    ipRateLimiter: { shouldAllow: () => ({ allowed: true }) }
  });
}

describe("default HTTP MCP gateway cutover", () => {
  it("sends /mcp tool calls through the platform gateway composition", async () => {
    const executeTool = vi.fn(async ({ toolId }: Record<string, unknown>) => ({
      ok: true,
      status: 200,
      payload: { result: { toolId, content: [{ type: "text", text: "healthy" }] } }
    }));
    const platform = createPlatformMcpGateway({
      platformName: "cutover-test",
      toolSkillManagementProvider: {
        authorizeMcpClientRequest: vi.fn(async () => ({
          ok: true,
          grant: { id: "grant-cutover", subjectId: "subject-cutover", revision: "grant-1" }
        })),
        listVisibleTools: () => [{
          id: "system.health",
          operationId: "system.health",
          description: "Health",
          inputSchema: { type: "object" },
          risk: "read_only"
        }],
        executeTool,
        getRefactorInstrumentation: () => ({ schemaVersion: "cutover-test" }),
        publicMcpToolPayload: async ({ payload }: Record<string, unknown>) => payload
      }
    });
    await platform.gateway.start();
    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "system.health", arguments: {} }
      });
      const request: any = Readable.from([Buffer.from(body)]);
      request.method = "POST";
      request.url = "/mcp";
      request.headers = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "mcp-method": "tools/call",
        "mcp-name": "system.health"
      };
      request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
      const response = new CapturedResponse();

      await handlerFor(platform.adapter as unknown as Record<string, unknown>)(request, response);

      const payload = JSON.parse(Buffer.concat(response.chunks).toString("utf8"));
      expect(response.statusCode).toBe(200);
      expect(payload).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete" }
      });
      expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ toolId: "system.health" }));
    } finally {
      await platform.close();
    }
  });

  it("does not require a downstream client product identity", async () => {
    const handle = vi.fn(async () => ({
      status: 202,
      headers: {},
      body: undefined
    }));
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "notifications/initialized"
    });
    const request: any = Readable.from([Buffer.from(body)]);
    request.method = "POST";
    request.url = "/mcp";
    request.headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body))
    };
    request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
    const response = new CapturedResponse();

    await handlerFor({ handle })(request, response);

    expect(handle).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(202);
  });

  it("keeps legacy GET/SSE admission out of the default /mcp route", async () => {
    const handle = vi.fn();
    const request: any = Readable.from([]);
    request.method = "GET";
    request.url = "/mcp";
    request.headers = { accept: "text/event-stream" };
    request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
    const response = new CapturedResponse();

    await handlerFor({ handle })(request, response);

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
    expect(handle).not.toHaveBeenCalled();
  });

  it("applies API-key authentication on the default /mcp route", async () => {
    const authorizeMcpClientRequest = vi.fn(async ({ request }: Record<string, any>) => {
      if (request?.headers?.["x-meshrix.js-api-key"] !== "key-cutover") {
        return { ok: false, status: 401, error: "MCP API key required." };
      }
      return {
        ok: true,
        credentialKind: "scoped_api_key",
        apiKeyAuthorization: {
          id: "api-key-cutover",
          workloadPrincipalId: "subject-cutover",
          policy: { scopeIds: [], toolsetIds: [], capabilityIds: [], maximumRisk: "read_only" }
        },
        grant: { id: "grant-cutover", subjectId: "subject-cutover", revision: "grant-1" }
      };
    });
    const platform = createPlatformMcpGateway({
      toolSkillManagementProvider: {
        authorizeMcpClientRequest,
        listVisibleTools: () => [{ id: "system.health", operationId: "system.health", inputSchema: { type: "object" }, risk: "read_only" }]
      }
    });
    await platform.gateway.start();
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
      const request: any = Readable.from([Buffer.from(body)]);
      request.method = "POST";
      request.url = "/mcp";
      request.headers = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-meshrix.js-api-key": "key-cutover"
      };
      request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
      const response = new CapturedResponse();

      await handlerFor(platform.adapter as unknown as Record<string, unknown>)(request, response);

      expect(response.statusCode).toBe(200);
      // The platform MCP baseline publishes the two stable categorized outlets ahead of the
      // tools this authorization sees, so the surface is the outlets and then `system.health`.
      expect(JSON.parse(Buffer.concat(response.chunks).toString("utf8"))).toMatchObject({
        result: {
          tools: [
            { name: MCP_DISCOVERY_TOOL_NAME, _meta: { mcpOutlet: MCP_DISCOVERY_TOOL_NAME, architectureCategory: "Discovery" } },
            { name: MCP_GATEWAY_TOOL_NAME, _meta: { mcpOutlet: MCP_GATEWAY_TOOL_NAME, architectureCategory: "Gateway" } },
            { name: "system.health" }
          ]
        }
      });
      expect(authorizeMcpClientRequest).toHaveBeenCalledWith(expect.objectContaining({
        method: "POST",
        request: expect.objectContaining({ headers: expect.objectContaining({ "x-meshrix.js-api-key": "key-cutover" }) })
      }));

      const deniedBody = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
      const deniedRequest: any = Readable.from([Buffer.from(deniedBody)]);
      deniedRequest.method = "POST";
      deniedRequest.url = "/mcp";
      deniedRequest.headers = { "content-type": "application/json" };
      deniedRequest.socket = { remoteAddress: "127.0.0.1", encrypted: false };
      const deniedResponse = new CapturedResponse();
      await handlerFor(platform.adapter as unknown as Record<string, unknown>)(deniedRequest, deniedResponse);
      expect(deniedResponse.statusCode).toBe(401);
    } finally {
      await platform.close();
    }
  });
});
