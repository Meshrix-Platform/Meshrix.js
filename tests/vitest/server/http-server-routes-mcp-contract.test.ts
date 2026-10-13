import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createModernDownstreamAdapter } from "../../../packages/protocols/mcp/modern-downstream/index.ts";
import {
  broadcastMcpToolListChanged,
  configureMcpNotificationBus
} from "../../../packages/protocols/mcp/notifications.ts";
import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";
import { context, modernHttpRequest } from "../gateway/support.ts";

class CapturedResponse extends EventEmitter {
  readonly headers: Record<string, unknown> = {};
  readonly chunks: Buffer[] = [];
  statusCode = 200;
  headersSent = false;

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string): unknown {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, headers: Record<string, unknown> = {}): void {
    this.statusCode = statusCode;
    this.headersSent = true;
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

function routeHandler(adapter: ReturnType<typeof createModernDownstreamAdapter>, overrides: Record<string, any> = {}) {
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
    operationAuditStore: null,
    operationConcurrencyScope: "mcp-contract-route-test",
    proxyApiRequest: vi.fn(),
    rateLimits: { windowMs: 1_000 },
    runtimeLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    securityPermissions: {
      authorizeOperation: vi.fn(async () => ({ ok: true })),
      verifyProcessIdentity: vi.fn(async () => ({ ok: true }))
    },
    subjectRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    tenantRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    toolSkillManagementProvider: {},
    platformMcpGatewayAdapter: adapter,
    upstreamGatewayRegistryForMcp: null,
    ipRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    ...overrides
  });
}

async function post(handler: ReturnType<typeof routeHandler>, message: Record<string, unknown>, headers: Record<string, string> = {}) {
  const body = JSON.stringify(message);
  const request: any = Readable.from([Buffer.from(body)]);
  request.method = "POST";
  request.url = "/mcp";
  request.headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    ...headers
  };
  request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  const response = new CapturedResponse();
  await handler(request, response);
  const encoded = Buffer.concat(response.chunks).toString("utf8");
  return { status: response.statusCode, body: encoded ? JSON.parse(encoded) as Record<string, any> : undefined };
}

describe("ordinary production /mcp route enforces the modern request contract", () => {
  it("binds API Key notification subscriptions to their audience workload principal", async () => {
    const delivered: Array<{ context: any; event: any }> = [];
    let subscriptionSequence = 0;
    const gateway: any = {
      subscribe: vi.fn(() => ({
        id: `subscription-${++subscriptionSequence}`,
        events: {
          [Symbol.asyncIterator]: () => ({ next: async () => new Promise(() => {}) })
        },
        close: vi.fn()
      })),
      publishEvent: (eventContext?: any, event?: any) => delivered.push({ context: eventContext, event })
    };
    const apiKeyContext = (workloadPrincipalId: string, keyId: string) => ({
      ...context,
      principal: workloadPrincipalId,
      grant: Object.freeze({ revision: `policy-${workloadPrincipalId}`, routes: "all" }),
      metadata: Object.freeze({
        authorization: Object.freeze({
          credentialKind: "scoped_api_key",
          apiKeyAuthorization: Object.freeze({ keyId, workloadPrincipalId })
        })
      })
    });
    const firstContext: any = apiKeyContext("workload-a", "key-a");
    const secondContext: any = apiKeyContext("workload-b", "key-b");
    const firstAdapter = createModernDownstreamAdapter({ gateway });
    const secondAdapter = createModernDownstreamAdapter({ gateway });
    let first: any;
    let second: any;
    configureMcpNotificationBus();
    try {
      first = await firstAdapter.handle({
        ...modernHttpRequest("subscriptions/listen", "sub-a", { notifications: { toolsListChanged: true } }),
        context: firstContext
      });
      second = await secondAdapter.handle({
        ...modernHttpRequest("subscriptions/listen", "sub-b", { notifications: { toolsListChanged: true } }),
        context: secondContext
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      broadcastMcpToolListChanged({
        grantId: "workload-a",
        sourceRevision: 1,
        catalogRevision: "catalog-a",
        audienceRevision: 1
      });

      expect(delivered).toHaveLength(1);
      expect(delivered[0].context).toBe(firstContext);
      expect(delivered[0].event.type).toBe("tools/list_changed");
    } finally {
      first?.close?.();
      second?.close?.();
      configureMcpNotificationBus();
    }
  });

  it("records a denied health request instead of suppressing it as probe noise", async () => {
    const appendHttpRequestMetric = vi.fn(async (_entry: any) => {});
    const adapter = createModernDownstreamAdapter({ gateway: { catalog: () => ({ items: [] }) } as any, authenticate: () => context });
    const handler = routeHandler(adapter, {
      ipRateLimiter: { shouldAllow: () => ({ allowed: false, retryAfterSec: 1 }) },
      getOperationPermissionPlatform: () => ({ store: { appendHttpRequestMetric } })
    });
    const request: any = Readable.from([]);
    request.method = "GET"; request.url = "/api/healthz"; request.headers = {};
    request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
    const response = new CapturedResponse();
    await handler(request, response);
    expect(response.statusCode).toBe(429);
    expect(appendHttpRequestMetric).toHaveBeenCalledOnce();
    expect(appendHttpRequestMetric.mock.calls[0]?.[0]).toMatchObject({ statusCode: 429, completionStatus: "completed" });
  });

  it("rejects a disallowed browser origin before reading the request body", async () => {
    const catalog = vi.fn(() => ({ items: [] }));
    const authenticate = vi.fn(() => context);
    const adapter = createModernDownstreamAdapter({ gateway: { catalog } as any, authenticate });
    const handler = routeHandler(adapter);
    let bodyReadCount = 0;
    const request: any = new Readable({
      read() {
        bodyReadCount += 1;
        this.push(Buffer.from("{}"));
        this.push(null);
      }
    });
    request.method = "POST";
    request.url = "/mcp";
    request.headers = {
      origin: "https://untrusted.invalid",
      "content-type": "application/json",
      "content-length": "2"
    };
    request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
    const response = new CapturedResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(403);
    expect(bodyReadCount).toBe(0);
    expect(authenticate).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });

  it("rejects bad request metadata before authorization and side effects, then serves a conforming client", async () => {
    const catalog = vi.fn(() => ({ items: [] }));
    const authenticate = vi.fn(() => context);
    const adapter = createModernDownstreamAdapter({ gateway: { catalog } as any, authenticate });
    const handler = routeHandler(adapter);

    const validList = modernHttpRequest("tools/list", 1);
    const missingHeaders = await post(handler, validList.body);
    expect(missingHeaders).toMatchObject({ status: 400, body: { error: { code: -32020 } } });

    const malformedMetadata = modernHttpRequest("tools/list", 2);
    const malformedBody = { ...malformedMetadata.body, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": [] } } };
    expect(await post(handler, malformedBody, malformedMetadata.headers)).toMatchObject({ status: 400, body: { error: { code: -32602 } } });

    expect(await post(handler, { jsonrpc: "2.0", id: 30, method: "server/discover", params: {} }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" })).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
    expect(await post(handler, { jsonrpc: "2.0", id: 31, method: "ping", params: {} }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "ping" })).toMatchObject({ status: 400, body: { error: { code: -32602 } } });

    const unauthenticated = modernHttpRequest("server/discover", 3);
    expect((await post(handler, unauthenticated.body, unauthenticated.headers)).status).toBe(200);
    const ping = modernHttpRequest("ping", 4);
    expect((await post(handler, ping.body, ping.headers)).status).toBe(200);

    const notification = await post(handler, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification).toEqual({ status: 202, body: undefined });

    const accepted = await post(handler, validList.body, validList.headers);
    expect(accepted).toMatchObject({ status: 200, body: { result: { resultType: "complete", tools: [], ttlMs: 0, cacheScope: "private" } } });
    expect(authenticate).toHaveBeenCalledOnce();
    expect(catalog).toHaveBeenCalledOnce();
  });
});
