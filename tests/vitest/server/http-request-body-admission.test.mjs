import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleLicoMcpHttpRequestMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("#lico/protocols/mcp/adapter/http-mcp-adapter", () => ({
  configureMcpNotificationBus: vi.fn(),
  handleLicoMcpHttpRequest: handleLicoMcpHttpRequestMock,
  MCP_LOCAL_AUTHORIZATION_MAX_BODY_BYTES: 128 * 1024
}));

import {
  DEFAULT_MAX_BODY_BYTES,
  createRequestBodyAdmissionController,
  readRequestBody
} from "../../../packages/protocols/http/http-utils.mjs";
import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.mjs";
import { UPLOAD_SESSION_MAX_CHUNK_BYTES } from "../../../packages/server-runtime/src/state/upload-session-admission.mjs";

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
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
  }

  write(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.from(String(chunk)));
    }
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    this.emit("finish");
  }
}

function attachHttpRequestMetadata(request, { path = "/api/test", contentLength = 1 } = {}) {
  request.method = "POST";
  request.url = path;
  request.headers = {
    "content-type": "application/json",
    "content-length": String(contentLength)
  };
  request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  return request;
}

function createHandler({ requestBodyAdmissionController, dispatchRegisteredHttpOperation }) {
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
    operationConcurrencyScope: "test-request-body-admission",
    proxyApiRequest: vi.fn(),
    rateLimits: { windowMs: 1_000 },
    registeredCoreProvider: {
      findProxyRegisteredApiRequest: vi.fn(() => null),
      dispatchRegisteredHttpOperation
    },
    requestBodyAdmissionController,
    runtimeLogger: {
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

describe("HTTP request body admission", () => {
  it("applies a narrow body limit before unauthenticated MCP device requests reach the provider", async () => {
    const dispatchRegisteredHttpOperation = vi.fn();
    const handler = createHandler({
      requestBodyAdmissionController: createRequestBodyAdmissionController(),
      dispatchRegisteredHttpOperation
    });
    const request = attachHttpRequestMetadata(Readable.from([]), {
      path: "/api/mcp/local-grant/requests",
      contentLength: 128 * 1024 + 1
    });
    const response = new CapturedResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(413);
    expect(handleLicoMcpHttpRequestMock).not.toHaveBeenCalled();
    expect(dispatchRegisteredHttpOperation).not.toHaveBeenCalled();
  });

  it("rejects an oversized upload chunk before allocating or dispatching its request body", async () => {
    const dispatchRegisteredHttpOperation = vi.fn();
    const handler = createHandler({
      requestBodyAdmissionController: createRequestBodyAdmissionController({
        maxInFlightBytes: UPLOAD_SESSION_MAX_CHUNK_BYTES * 2
      }),
      dispatchRegisteredHttpOperation
    });
    const request = attachHttpRequestMetadata(Readable.from([]), {
      path: "/api/upload-sessions/upload_session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/files/0",
      contentLength: UPLOAD_SESSION_MAX_CHUNK_BYTES + 1
    });
    request.method = "PUT";
    request.headers["content-type"] = "application/octet-stream";
    const response = new CapturedResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(413);
    expect(dispatchRegisteredHttpOperation).not.toHaveBeenCalled();
  });

  it("rejects a concurrent body before dispatch when the shared request budget is occupied", async () => {
    const admissionController = createRequestBodyAdmissionController({
      maxInFlightBytes: 8,
      maxInFlightRequests: 1,
      maxInFlightBytesPerSubject: 8,
      maxInFlightRequestsPerSubject: 1
    });
    let signalHeldAdmission;
    const heldAdmission = new Promise((resolve) => {
      signalHeldAdmission = resolve;
    });
    const admission = {
      acquire(options) {
        const lease = admissionController.acquire(options);
        signalHeldAdmission();
        return lease;
      },
      getUsage() {
        return admissionController.getUsage();
      }
    };
    const dispatchRegisteredHttpOperation = vi.fn(async ({ response }) => {
      response.end();
      return true;
    });
    const handler = createHandler({
      requestBodyAdmissionController: admission,
      dispatchRegisteredHttpOperation
    });
    const heldRequest = attachHttpRequestMetadata(new PassThrough());
    const heldResponse = new CapturedResponse();
    const held = handler(heldRequest, heldResponse);
    await heldAdmission;

    expect(admission.getUsage()).toEqual({
      inFlightBytes: 1,
      inFlightRequests: 1,
      activeTenantCount: 1,
      activeSubjectCount: 1
    });

    const rejectedRequest = attachHttpRequestMetadata(Readable.from([Buffer.from("x")]));
    const rejectedResponse = new CapturedResponse();
    await handler(rejectedRequest, rejectedResponse);

    expect(rejectedResponse.statusCode).toBe(429);
    expect(dispatchRegisteredHttpOperation).not.toHaveBeenCalled();

    heldRequest.end("x");
    await held;
    expect(dispatchRegisteredHttpOperation).toHaveBeenCalledOnce();
    expect(admission.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });

  it("reserves declared bytes without allocating buffers and releases them after completion", async () => {
    const admission = createRequestBodyAdmissionController({
      maxInFlightBytes: 6,
      maxInFlightRequests: 2,
      maxInFlightBytesPerSubject: 6,
      maxInFlightRequestsPerSubject: 2
    });
    const heldRequest = new PassThrough();
    const held = readRequestBody(heldRequest, {
      admissionController: admission,
      contentLength: 4,
      subjectKey: "subject-a"
    });

    expect(admission.getUsage().inFlightBytes).toBe(4);
    await expect(readRequestBody(Readable.from([Buffer.from("abc")]), {
      admissionController: admission,
      contentLength: 3,
      subjectKey: "subject-b"
    })).rejects.toMatchObject({
      code: "request_body_global_byte_capacity_exceeded",
      statusCode: 429
    });

    heldRequest.end("data");
    await expect(held).resolves.toEqual(Buffer.from("data"));
    expect(admission.getUsage().inFlightBytes).toBe(0);

    await expect(readRequestBody(Readable.from([Buffer.from("abc")]), {
      admissionController: admission,
      contentLength: 3,
      subjectKey: "subject-b"
    })).resolves.toEqual(Buffer.from("abc"));
    expect(admission.getUsage().inFlightRequests).toBe(0);
  });

  it("releases admission after a body exceeds the per-request limit", async () => {
    const admission = createRequestBodyAdmissionController({
      maxInFlightBytes: DEFAULT_MAX_BODY_BYTES * 2,
      maxInFlightRequests: 2
    });

    await expect(readRequestBody(Readable.from([]), {
      admissionController: admission,
      contentLength: DEFAULT_MAX_BODY_BYTES + 1,
      subjectKey: "subject-a"
    })).rejects.toMatchObject({
      code: "request_body_too_large",
      statusCode: 413
    });
    expect(admission.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });

  it("releases incrementally accounted capacity after an undeclared body exceeds the shared byte budget", async () => {
    const admission = createRequestBodyAdmissionController({
      maxInFlightBytes: 6,
      maxInFlightRequests: 2,
      maxInFlightBytesPerSubject: 6,
      maxInFlightRequestsPerSubject: 2
    });

    await expect(readRequestBody(Readable.from([Buffer.alloc(7)]), {
      admissionController: admission,
      contentLength: 0,
      maxBytes: 8,
      subjectKey: "subject-a"
    })).rejects.toMatchObject({
      code: "request_body_global_byte_capacity_exceeded",
      statusCode: 429
    });
    expect(admission.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });

  it("releases declared capacity when the request stream disconnects", async () => {
    const admission = createRequestBodyAdmissionController({
      maxInFlightBytes: 8,
      maxInFlightRequests: 2,
      maxInFlightBytesPerSubject: 8,
      maxInFlightRequestsPerSubject: 2
    });
    const disconnectedRequest = new PassThrough();
    const reading = readRequestBody(disconnectedRequest, {
      admissionController: admission,
      contentLength: 5,
      subjectKey: "subject-a"
    });

    expect(admission.getUsage().inFlightBytes).toBe(5);
    disconnectedRequest.destroy(new Error("fixture disconnect"));

    await expect(reading).rejects.toThrow("fixture disconnect");
    expect(admission.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });

  it("isolates request and byte capacity by tenant before subject admission", async () => {
    const requestAdmission = createRequestBodyAdmissionController({
      maxInFlightBytes: 12,
      maxInFlightRequests: 4,
      maxInFlightBytesPerTenant: 6,
      maxInFlightRequestsPerTenant: 1,
      maxInFlightBytesPerSubject: 6,
      maxInFlightRequestsPerSubject: 2
    });
    const heldRequest = new PassThrough();
    const held = readRequestBody(heldRequest, {
      admissionController: requestAdmission,
      contentLength: 4,
      tenantKey: "tenant-a",
      subjectKey: "subject-a"
    });

    await expect(readRequestBody(Readable.from([Buffer.from("x")]), {
      admissionController: requestAdmission,
      contentLength: 1,
      tenantKey: "tenant-a",
      subjectKey: "subject-b"
    })).rejects.toMatchObject({
      code: "request_body_tenant_request_capacity_exceeded",
      statusCode: 429
    });
    await expect(readRequestBody(Readable.from([Buffer.from("data")]), {
      admissionController: requestAdmission,
      contentLength: 4,
      tenantKey: "tenant-b",
      subjectKey: "subject-b"
    })).resolves.toEqual(Buffer.from("data"));

    expect(requestAdmission.getUsage()).toMatchObject({
      activeTenantCount: 1,
      activeSubjectCount: 1
    });
    heldRequest.end("data");
    await held;
    expect(requestAdmission.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });

  it("releases tenant capacity after incremental byte admission rejects an undeclared body", async () => {
    const requestAdmission = createRequestBodyAdmissionController({
      maxInFlightBytes: 12,
      maxInFlightRequests: 4,
      maxInFlightBytesPerTenant: 3,
      maxInFlightRequestsPerTenant: 2,
      maxInFlightBytesPerSubject: 12,
      maxInFlightRequestsPerSubject: 4
    });

    await expect(readRequestBody(Readable.from([Buffer.alloc(4)]), {
      admissionController: requestAdmission,
      contentLength: 0,
      maxBytes: 8,
      tenantKey: "tenant-a",
      subjectKey: "subject-a"
    })).rejects.toMatchObject({
      code: "request_body_tenant_byte_capacity_exceeded",
      statusCode: 429
    });
    expect(requestAdmission.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });
});
