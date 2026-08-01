import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleMeshrixMcpHttpRequestMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => false));

vi.mock("#meshrix/protocols/mcp/adapter/http-mcp-adapter", () : any => ({
  configureMcpNotificationBus: vi.fn(),
  handleMeshrixMcpHttpRequest: handleMeshrixMcpHttpRequestMock
}));

import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";

class CapturedResponse extends EventEmitter {
  chunks: any;
  headers: any;
  headersSent: any;
  statusCode: any;
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
  }

  setHeader(name?: any, value?: any) : any {
    this.headers[String(name).toLowerCase()] = value;
  }

  getHeader(name?: any) : any {
    return this.headers[String(name).toLowerCase()];
  }

  writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
    this.statusCode = statusCode;
    this.headersSent = true;
    for (const [name, value] of (Object.entries(headers) as [string, any][])) this.setHeader(name, value);
  }

  write(chunk?: any) : any {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(String(chunk)));
  }

  end(chunk?: any) : any {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.emit("finish");
  }
}

function createRequest(url?: any) : any {
  const request: any = Readable.from([Buffer.from("{}")]);
  request.method = "POST";
  request.url = url;
  request.headers = {
    "content-type": "application/json",
    "content-length": "2"
  };
  request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  return request;
}

function createHandler(registeredCoreProvider?: any, options: Record<string, any> = {}) : any {
  return createHttpServerRequestHandler({
    activeApiOperations: [],
    consoleAuth: {},
    controllers: {},
    distPath: "",
    getDiscoveryState: () : any => ({}),
    getListenUrl: () : any => "http://127.0.0.1",
    getOperationPermissionPlatform: () : any => options.operationPermissionPlatform || null,
    lifecycle: {
      beginRequest: () : any => new AbortController(),
      endRequest: vi.fn(),
      markSocketActive: vi.fn(),
      markSocketIdle: vi.fn()
    },
    loginRateLimiter: { shouldAllow: () : any => ({ allowed: true }) },
    operationAuditStore: null,
    operationConcurrencyScope: "test-http-abort",
    proxyApiRequest: vi.fn(),
    rateLimits: { windowMs: 1_000 },
    registeredCoreProvider,
    runtimeLogger: options.runtimeLogger || {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    securityPermissions: {
      authorizeOperation: vi.fn(async () : Promise<any> => ({ ok: true })),
      verifyProcessIdentity: vi.fn(async () : Promise<any> => ({ ok: true }))
    },
    subjectRateLimiter: { shouldAllow: () : any => ({ allowed: true }) },
    tenantRateLimiter: { shouldAllow: () : any => ({ allowed: true }) },
    toolSkillManagementProvider: {},
    upstreamGatewayRegistryForMcp: null,
    ipRateLimiter: { shouldAllow: () : any => ({ allowed: true }) }
  });
}

beforeEach(() : any => {
  vi.clearAllMocks();
  handleMeshrixMcpHttpRequestMock.mockResolvedValue(false);
});

describe("HTTP request abort propagation", () : any => {
  it("does not persist or log successful routine health probes", async () : Promise<any> => {
    const appendHttpRequestMetric: any = vi.fn();
    const runtimeLogger: Record<string, any> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const handler: any = createHandler({
      findProxyRegisteredApiRequest: vi.fn(() : any => null),
      dispatchRegisteredHttpOperation: vi.fn(async ({ response }: Record<string, any>) : Promise<any> => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return true;
      })
    }, {
      operationPermissionPlatform: { store: { appendHttpRequestMetric } },
      runtimeLogger
    });
    const request: any = Readable.from([]);
    request.method = "GET";
    request.url = "/api/healthz";
    request.headers = {};
    request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
    const response: any = new CapturedResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(200);
    expect(appendHttpRequestMetric).not.toHaveBeenCalled();
    expect(runtimeLogger.debug).not.toHaveBeenCalledWith("http.request.started", expect.anything());
    expect(runtimeLogger.debug).not.toHaveBeenCalledWith("http.request.completed", expect.anything());
    expect(runtimeLogger.info).not.toHaveBeenCalledWith("http.request.completed", expect.anything());
  });

  it("aborts the signal passed to direct MCP handling when the response closes", async () : Promise<any> => {
    let observeMcp: any;
    const mcpStarted: any = new Promise((resolve?: any) : any => {
      observeMcp = resolve;
    });
    handleMeshrixMcpHttpRequestMock.mockImplementation(async ({ signal }: Record<string, any>) : Promise<any> => {
      observeMcp(signal);
      if (!signal.aborted) {
        await new Promise((resolve?: any) : any => signal.addEventListener("abort", resolve, { once: true }));
      }
      return true;
    });
    const handler: any = createHandler({
      findProxyRegisteredApiRequest: vi.fn(() : any => null),
      dispatchRegisteredHttpOperation: vi.fn()
    });
    const request: any = createRequest("/mcp");
    const response: any = new CapturedResponse();
    const pending: any = handler(request, response);
    const signal: any = await mcpStarted;

    response.emit("close");
    await pending;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });

  it("aborts the signal passed to registered HTTP dispatch when the response closes", async () : Promise<any> => {
    let observeDispatch: any;
    const dispatchStarted: any = new Promise((resolve?: any) : any => {
      observeDispatch = resolve;
    });
    const registeredCoreProvider: Record<string, any> = {
      findProxyRegisteredApiRequest: vi.fn(() : any => null),
      dispatchRegisteredHttpOperation: vi.fn(async ({ signal }: Record<string, any>) : Promise<any> => {
        observeDispatch(signal);
        if (!signal.aborted) {
          await new Promise((resolve?: any) : any => signal.addEventListener("abort", resolve, { once: true }));
        }
        return true;
      })
    };
    const handler: any = createHandler(registeredCoreProvider);
    const request: any = createRequest("/api/operation-permission/v1/execute");
    const response: any = new CapturedResponse();
    const pending: any = handler(request, response);
    const signal: any = await dispatchStarted;

    response.emit("close");
    await pending;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });
});
