import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleLicoMcpHttpRequestMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("#meshrix/protocols/mcp/adapter/http-mcp-adapter", () => ({
  configureMcpNotificationBus: vi.fn(),
  handleLicoMcpHttpRequest: handleLicoMcpHttpRequestMock
}));

import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.mjs";

class CapturedResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }

  write(chunk) {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(String(chunk)));
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.emit("finish");
  }
}

function createRequest(url) {
  const request = Readable.from([Buffer.from("{}")]);
  request.method = "POST";
  request.url = url;
  request.headers = {
    "content-type": "application/json",
    "content-length": "2"
  };
  request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  return request;
}

function createHandler(registeredCoreProvider, options = {}) {
  return createHttpServerRequestHandler({
    activeApiOperations: [],
    consoleAuth: {},
    controllers: {},
    distPath: "",
    getDiscoveryState: () => ({}),
    getListenUrl: () => "http://127.0.0.1",
    getOperationPermissionPlatform: () => options.operationPermissionPlatform || null,
    lifecycle: {
      beginRequest: () => new AbortController(),
      endRequest: vi.fn(),
      markSocketActive: vi.fn(),
      markSocketIdle: vi.fn()
    },
    loginRateLimiter: { shouldAllow: () => ({ allowed: true }) },
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
      authorizeOperation: vi.fn(async () => ({ ok: true })),
      verifyProcessIdentity: vi.fn(async () => ({ ok: true }))
    },
    subjectRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    tenantRateLimiter: { shouldAllow: () => ({ allowed: true }) },
    toolSkillManagementProvider: {},
    upstreamGatewayRegistryForMcp: null,
    ipRateLimiter: { shouldAllow: () => ({ allowed: true }) }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handleLicoMcpHttpRequestMock.mockResolvedValue(false);
});

describe("HTTP request abort propagation", () => {
  it("does not persist or log successful routine health probes", async () => {
    const appendHttpRequestMetric = vi.fn();
    const runtimeLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const handler = createHandler({
      findProxyRegisteredApiRequest: vi.fn(() => null),
      dispatchRegisteredHttpOperation: vi.fn(async ({ response }) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return true;
      })
    }, {
      operationPermissionPlatform: { store: { appendHttpRequestMetric } },
      runtimeLogger
    });
    const request = Readable.from([]);
    request.method = "GET";
    request.url = "/api/healthz";
    request.headers = {};
    request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
    const response = new CapturedResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(200);
    expect(appendHttpRequestMetric).not.toHaveBeenCalled();
    expect(runtimeLogger.debug).not.toHaveBeenCalledWith("http.request.started", expect.anything());
    expect(runtimeLogger.debug).not.toHaveBeenCalledWith("http.request.completed", expect.anything());
    expect(runtimeLogger.info).not.toHaveBeenCalledWith("http.request.completed", expect.anything());
  });

  it("aborts the signal passed to direct MCP handling when the response closes", async () => {
    let observeMcp;
    const mcpStarted = new Promise((resolve) => {
      observeMcp = resolve;
    });
    handleLicoMcpHttpRequestMock.mockImplementation(async ({ signal }) => {
      observeMcp(signal);
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
      return true;
    });
    const handler = createHandler({
      findProxyRegisteredApiRequest: vi.fn(() => null),
      dispatchRegisteredHttpOperation: vi.fn()
    });
    const request = createRequest("/mcp");
    const response = new CapturedResponse();
    const pending = handler(request, response);
    const signal = await mcpStarted;

    response.emit("close");
    await pending;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });

  it("aborts the signal passed to registered HTTP dispatch when the response closes", async () => {
    let observeDispatch;
    const dispatchStarted = new Promise((resolve) => {
      observeDispatch = resolve;
    });
    const registeredCoreProvider = {
      findProxyRegisteredApiRequest: vi.fn(() => null),
      dispatchRegisteredHttpOperation: vi.fn(async ({ signal }) => {
        observeDispatch(signal);
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        return true;
      })
    };
    const handler = createHandler(registeredCoreProvider);
    const request = createRequest("/api/operation-permission/v1/execute");
    const response = new CapturedResponse();
    const pending = handler(request, response);
    const signal = await dispatchStarted;

    response.emit("close");
    await pending;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });
});
