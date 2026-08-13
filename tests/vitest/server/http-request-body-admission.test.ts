import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleMeshrixMcpHttpRequestMock: any = vi.hoisted(() : any => vi.fn(async () : Promise<any> => false));

vi.mock("#meshrix/protocols/mcp/adapter/http-mcp-adapter", () : any => ({
  configureMcpNotificationBus: vi.fn(),
  handleMeshrixMcpHttpRequest: handleMeshrixMcpHttpRequestMock
}));

import {
  DEFAULT_MAX_BODY_BYTES,
  createRequestBodyAdmissionController,
  readRequestBody
} from "../../../packages/protocols/http/http-utils.ts";
import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";
import { UPLOAD_SESSION_MAX_CHUNK_BYTES } from "../../../packages/server-runtime/src/state/upload-session-admission.ts";

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
    for (const [name, value] of (Object.entries(headers) as [string, any][])) {
      this.setHeader(name, value);
    }
  }

  write(chunk?: any) : any {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.from(String(chunk)));
    }
  }

  end(chunk?: any) : any {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    this.emit("finish");
  }
}

function attachHttpRequestMetadata(request?: any, { path = "/api/test", contentLength = 1 }: Record<string, any> = {}) : any {
  request.method = "POST";
  request.url = path;
  request.headers = {
    "content-type": "application/json",
    "content-length": String(contentLength)
  };
  request.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  return request;
}

function createHandler({ requestBodyAdmissionController, dispatchRegisteredHttpOperation }: Record<string, any>) : any {
  return createHttpServerRequestHandler({
    activeApiOperations: [],
    consoleAuth: {},
    controllers: {},
    distPath: "",
    getDiscoveryState: () : any => ({}),
    getListenUrl: () : any => "http://127.0.0.1",
    getOperationPermissionPlatform: () : any => null,
    lifecycle: {
      beginRequest: () : any => new AbortController(),
      endRequest: vi.fn(),
      markSocketActive: vi.fn(),
      markSocketIdle: vi.fn()
    },
    loginRateLimiter: { shouldAllow: () : any => ({ allowed: true }) },
    operationAuditStore: null,
    operationConcurrencyScope: "test-request-body-admission",
    proxyApiRequest: vi.fn(),
    rateLimits: { windowMs: 1_000 },
    registeredCoreProvider: {
      findProxyRegisteredApiRequest: vi.fn(() : any => null),
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

describe("HTTP request body admission", () : any => {
  it("holds amplified JSON body credit through dispatch and releases it exactly once", async () : Promise<any> => {
    const admissionController: any = createRequestBodyAdmissionController({
      maxInFlightBytes: 24,
      maxInFlightRequests: 2,
      maxInFlightBytesPerSubject: 24,
      maxInFlightRequestsPerSubject: 2
    });
    const usageDuringDispatch: any[] = [];
    const handler: any = createHandler({
      requestBodyAdmissionController: admissionController,
      dispatchRegisteredHttpOperation: vi.fn(async ({ response, requestBody }: Record<string, any>) : Promise<any> => {
        expect(JSON.parse(requestBody.toString("utf8"))).toEqual({});
        usageDuringDispatch.push(admissionController.getUsage());
        response.end();
        return true;
      })
    });
    const request: any = attachHttpRequestMetadata(Readable.from([Buffer.from("{}")]), {
      contentLength: 2
    });
    const response: any = new CapturedResponse();

    await handler(request, response);

    expect(usageDuringDispatch).toEqual([expect.objectContaining({
      inFlightBytes: 6,
      inFlightRequests: 1
    })]);
    expect(admissionController.getUsage()).toEqual({
      inFlightBytes: 0,
      inFlightRequests: 0,
      activeTenantCount: 0,
      activeSubjectCount: 0
    });
  });

  it("rejects an oversized upload chunk before allocating or dispatching its request body", async () : Promise<any> => {
    const dispatchRegisteredHttpOperation: any = vi.fn();
    const handler: any = createHandler({
      requestBodyAdmissionController: createRequestBodyAdmissionController({
        maxInFlightBytes: UPLOAD_SESSION_MAX_CHUNK_BYTES * 2
      }),
      dispatchRegisteredHttpOperation
    });
    const request: any = attachHttpRequestMetadata(Readable.from([]), {
      path: "/api/upload-sessions/upload_session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/files/0",
      contentLength: UPLOAD_SESSION_MAX_CHUNK_BYTES + 1
    });
    request.method = "PUT";
    request.headers["content-type"] = "application/octet-stream";
    const response: any = new CapturedResponse();

    await handler(request, response);

    expect(response.statusCode).toBe(413);
    expect(dispatchRegisteredHttpOperation).not.toHaveBeenCalled();
  });

  it("rejects a concurrent body before dispatch when the shared request budget is occupied", async () : Promise<any> => {
    const admissionController: any = createRequestBodyAdmissionController({
      maxInFlightBytes: 8,
      maxInFlightRequests: 1,
      maxInFlightBytesPerSubject: 8,
      maxInFlightRequestsPerSubject: 1
    });
    let signalHeldAdmission: any;
    const heldAdmission: any = new Promise((resolve?: any) : any => {
      signalHeldAdmission = resolve;
    });
    const admission: Record<string, any> = {
      acquire(options?: any) : any {
        const lease: any = admissionController.acquire(options);
        signalHeldAdmission();
        return lease;
      },
      getUsage() : any {
        return admissionController.getUsage();
      }
    };
    const dispatchRegisteredHttpOperation: any = vi.fn(async ({ response }: Record<string, any>) : Promise<any> => {
      response.end();
      return true;
    });
    const handler: any = createHandler({
      requestBodyAdmissionController: admission,
      dispatchRegisteredHttpOperation
    });
    const heldRequest: any = attachHttpRequestMetadata(new PassThrough());
    const heldResponse: any = new CapturedResponse();
    const held: any = handler(heldRequest, heldResponse);
    await heldAdmission;

    expect(admission.getUsage()).toEqual({
      inFlightBytes: 3,
      inFlightRequests: 1,
      activeTenantCount: 1,
      activeSubjectCount: 1
    });

    const rejectedRequest: any = attachHttpRequestMetadata(Readable.from([Buffer.from("x")]));
    const rejectedResponse: any = new CapturedResponse();
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

  it("reserves declared bytes without allocating buffers and releases them after completion", async () : Promise<any> => {
    const admission: any = createRequestBodyAdmissionController({
      maxInFlightBytes: 6,
      maxInFlightRequests: 2,
      maxInFlightBytesPerSubject: 6,
      maxInFlightRequestsPerSubject: 2
    });
    const heldRequest: any = new PassThrough();
    const held: any = readRequestBody(heldRequest, {
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

  it("releases admission after a body exceeds the per-request limit", async () : Promise<any> => {
    const admission: any = createRequestBodyAdmissionController({
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

  it("releases incrementally accounted capacity after an undeclared body exceeds the shared byte budget", async () : Promise<any> => {
    const admission: any = createRequestBodyAdmissionController({
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

  it("releases declared capacity when the request stream disconnects", async () : Promise<any> => {
    const admission: any = createRequestBodyAdmissionController({
      maxInFlightBytes: 8,
      maxInFlightRequests: 2,
      maxInFlightBytesPerSubject: 8,
      maxInFlightRequestsPerSubject: 2
    });
    const disconnectedRequest: any = new PassThrough();
    const reading: any = readRequestBody(disconnectedRequest, {
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

  it("isolates request and byte capacity by tenant before subject admission", async () : Promise<any> => {
    const requestAdmission: any = createRequestBodyAdmissionController({
      maxInFlightBytes: 12,
      maxInFlightRequests: 4,
      maxInFlightBytesPerTenant: 6,
      maxInFlightRequestsPerTenant: 1,
      maxInFlightBytesPerSubject: 6,
      maxInFlightRequestsPerSubject: 2
    });
    const heldRequest: any = new PassThrough();
    const held: any = readRequestBody(heldRequest, {
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

  it("releases tenant capacity after incremental byte admission rejects an undeclared body", async () : Promise<any> => {
    const requestAdmission: any = createRequestBodyAdmissionController({
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
