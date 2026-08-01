import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { fingerprint } from "../../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import { normalizeService } from "../../../packages/agents/src/upstream-gateway/support.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import {
  createMemoryLocalSecretKeyProvider
} from "../../../packages/foundation/src/security/secrets/local-secret-key-provider.ts";
import {
  initializeLocalSecret
} from "../../../packages/foundation/src/security/secrets/local-secret-store.ts";
import { createStorageKernel } from "../../../packages/foundation/src/storage/storage-kernel.ts";
import { createStorageProvider } from "../../../packages/foundation/src/storage/storage-provider.ts";
import {
  createSystemControllerFoundationHandlers
} from "../../../packages/protocols/http/controllers/system-controller-foundation-handlers.ts";
import {
  createArtifactTransitProvider
} from "../../../packages/server-runtime/src/composition/artifact-transit-provider.ts";
import {
  executeConsoleDomainOperation
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executor.ts";
import {
  dispatchOperation
} from "../../../packages/server-runtime/src/composition/dispatch-operation.ts";
import {
  createUpstreamFinalEffectAuthority
} from "../../../packages/server-runtime/src/composition/upstream-final-effect-authority.ts";
import {
  createLocalCustodyKeyBroker
} from "../../../packages/server-runtime/src/execution-sandbox/custody-key-broker.ts";
import {
  createUploadNoRunCustody
} from "../../../packages/server-runtime/src/jobs/upload-no-run-custody.ts";
import {
  createUploadSessionStore
} from "../../../packages/server-runtime/src/state/upload-session-store.ts";
import {
  getSessionMetaPath
} from "../../../packages/server-runtime/src/state/upload-session-support.ts";

const SERVICE_ID: any = "stream-artifact-final-effect";
const SECRET_REF: any = "secret://stream-artifact-final-effect/fixture";
const CREDENTIAL: any = "stream-artifact-final-effect-credential";
const CHUNK_BYTES: any = 64 * 1024;
const EFFECT: Readonly<Record<string, any>> = Object.freeze({
  artifactRead: "upstream-artifact-private-read",
  credential: "upstream-credential-config-read",
  network: "upstream-http-request-open",
  responseBegin: "upstream-response-artifact-begin",
  responseCommit: "upstream-response-artifact-commit"
});
const SUBJECT: Readonly<Record<string, any>> = Object.freeze({
  generation: "7",
  subjectId: "stream-artifact-subject",
  tenantId: "stream-artifact-tenant",
  type: "console-user"
});
const SUBJECT_WITH_SCOPES: Readonly<Record<string, any>> = Object.freeze({
  ...SUBJECT,
  roleId: "owner",
  scopes: Object.freeze(["gateway:read", "gateway:write"]),
  userId: SUBJECT.subjectId,
  username: "stream-artifact-owner"
});
const AUTH_SESSION: Readonly<Record<string, any>> = Object.freeze({
  sessionId: "stream-artifact-session",
  user: SUBJECT_WITH_SCOPES
});
const DEFAULT_CONTEXT: Readonly<Record<string, any>> = Object.freeze({
  approvalRevision: "approval-11",
  grantRevision: "grant-13",
  policyRevision: "policy-17",
  riskRevision: "risk-19",
  workloadGeneration: SUBJECT.generation
});
const EXECUTABLE_UPLOAD: any = Buffer.concat([
  Buffer.from("#!/bin/sh\nexit 0\n", "utf8"),
  Buffer.alloc(CHUNK_BYTES, 0x61),
  Buffer.from("sealed-tail", "utf8")
]);
const SECOND_UPLOAD: any = Buffer.from("second encrypted upload payload", "utf8");
const RESPONSE_ARTIFACT: any = Buffer.from("%PDF-1.7\nstream-artifact-response", "utf8");

const cleanup: any[] = [];
let uploadSequence: any = 0;

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function deferred() : any {
  let reject: any;
  let resolve: any;
  const promise: any = new Promise((resolvePromise?: any, rejectPromise?: any) : any => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function delay(milliseconds?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate?: any, {
  label = "condition",
  timeoutMs = 4_000
}: Record<string, any> = {}) : Promise<any> {
  const deadline: any = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await delay(10);
  }
}

async function withTimeout(promise?: any, timeoutMs?: any, label?: any) : Promise<any> {
  let timer: any;
  try {
    return await Promise.race([
      promise,
      new Promise((_?: any, reject?: any) : any => {
        timer = setTimeout(
          () : any => reject(new Error(`Timed out waiting for ${label}.`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server?: any) : Promise<any> {
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function proofSubstrate() : any {
  let sequence: any = 0;
  return {
    beginLifecycle: vi.fn(async () : Promise<any> => {
      sequence += 1;
      return { ledgerEventId: `proof:stream-artifact-final-effect:${sequence}` };
    }),
    finishLifecycle: vi.fn(async ({ ledgerEventId }: Record<string, any>) : Promise<any> => ({ ledgerEventId })),
    recordReceipt: vi.fn(async () : Promise<any> => {
      sequence += 1;
      return { ledgerEventId: `proof:stream-artifact-final-effect:${sequence}:receipt` };
    })
  };
}

function authorityResult(context?: any, {
  allowed = true,
  revoked = false
}: Record<string, any> = {}) : any {
  if (!allowed) {
    return Object.freeze({
      error: "Final protected sink authority denied.",
      ok: false,
      reasonCode: revoked
        ? "final_protected_sink_permit_revoked"
        : "final_protected_sink_permit_denied",
      revoked,
      status: 403
    });
  }
  return Object.freeze({
    authorizationDecision: Object.freeze({
      allowed: true,
      decisionId: `decision:${context.policyRevision}`,
      reasonCode: "stream_artifact_acceptance_allow",
      riskRevision: context.riskRevision
    }),
    governancePolicyRevision: Object.freeze({
      revision: context.policyRevision
    }),
    grant: Object.freeze({
      id: "stream-artifact-grant",
      revision: context.grantRevision
    }),
    ok: true,
    protectedSinkAuthority: Object.freeze({
      context: Object.freeze({ ...context }),
      subject: SUBJECT
    }),
    session: AUTH_SESSION
  });
}

function createAuthorizationHarness(events?: any) : any {
  let context: Record<string, any> = { ...DEFAULT_CONTEXT };
  let mutation: any = null;
  const authorizeOperation: any = vi.fn(async (call: Record<string, any> = {}) : Promise<any> => {
    const phase: any = String(call.phase || "admission");
    const effectKind: any = String(call.sinkBinding?.effect?.kind || "");
    events.push(Object.freeze({
      effectKind,
      phase,
      request: call.request || null,
      sinkBinding: call.sinkBinding || null
    }));
    if (
      mutation &&
      phase === mutation.phase &&
      (!mutation.effectKind || mutation.effectKind === effectKind)
    ) {
      const selected: any = mutation;
      mutation = null;
      await selected.run(call);
    }
    return authorityResult(context);
  });
  return {
    authorizeOperation,
    context() : any {
      return Object.freeze({ ...context });
    },
    effectKinds({
      from = 0,
      phase = "final-protected-sink"
    }: Record<string, any> = {}) : any {
      return events.slice(from)
        .filter((event?: any) : any => event.phase === phase)
        .map((event?: any) : any => event.effectKind);
    },
    eventCount() : any {
      return events.length;
    },
    replaceContext(next?: any) : any {
      context = { ...next };
    },
    restoreContext() : any {
      context = { ...DEFAULT_CONTEXT };
    },
    setMutation({
      effectKind = "",
      phase = "final-protected-sink",
      run
    }: Record<string, any>) : any {
      mutation = { effectKind, phase, run };
    }
  };
}

function createLifecycle() : any {
  const active: any = new Set<any>();
  return {
    beginRequest() : any {
      const controller: any = new AbortController();
      active.add(controller);
      return controller;
    },
    endRequest(controller?: any) : any {
      active.delete(controller);
    },
    getInFlightCount() : any {
      return active.size;
    },
    markSocketActive() : any {},
    markSocketIdle() : any {}
  };
}

function allowRateLimit() : any {
  return {
    shouldAllow() : any {
      return {
        allowed: true,
        limit: 10_000,
        remaining: 9_999,
        resetAt: Date.now() + 60_000
      };
    }
  };
}

function createResponse() : any {
  return {
    chunks: [],
    ended: false,
    headers: {},
    statusCode: 0,
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return true;
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    },
    json() : any {
      return JSON.parse(Buffer.concat(this.chunks).toString("utf8") || "{}");
    }
  };
}

function gatewayController(registry?: any) : any {
  const sendConsoleDomainOperation: any = async ({
    context,
    input,
    operationId,
    response
  }: Record<string, any>) : Promise<any> => {
    const operationResult: any = await executeConsoleDomainOperation({
      operationId,
      input,
      context: {
        ...context,
        transport: "http",
        upstreamGatewayRegistry: registry
      }
    });
    response.writeHead(operationResult.status || 200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(operationResult.payload));
  };
  return {
    system: createSystemControllerFoundationHandlers({
      accessControlContext: (authSession?: any, extra: Record<string, any> = {}) : any => ({
        authSession,
        ...extra
      }),
      agentWorkspace: {},
      authorizationFacadeContext: (authSession?: any, extra: Record<string, any> = {}) : any => ({
        authSession,
        ...extra
      }),
      protocolPayload: (requestBody?: any) : any => JSON.parse(
        Buffer.from(requestBody || Buffer.alloc(0)).toString("utf8") || "{}"
      ),
      runtime: {},
      sendConsoleDomainOperation,
      workspaceIdFrom: () : any => ""
    })
  };
}

async function dispatchGateway(fixture?: any, operationKey?: any, {
  arguments: argumentsValue = {},
  signal = null
}: Record<string, any> = {}) : Promise<any> {
  const operation: any = SERVER_API_OPERATIONS.find(
    (candidate?: any) : any => candidate.id === "gateway.forward"
  );
  if (!operation) throw new Error("gateway.forward operation is unavailable.");
  const input: Record<string, any> = {
    arguments: argumentsValue,
    operationKey,
    serviceId: SERVICE_ID
  };
  const requestBody: any = Buffer.from(JSON.stringify(input), "utf8");
  const response: any = createResponse();
  const request: Record<string, any> = {
    headers: {
      "content-type": "application/json"
    },
    method: "POST",
    url: "/api/gateway/v1/forward"
  };
  const dispatched: any = dispatchOperation({
    actor: AUTH_SESSION.user,
    authSession: AUTH_SESSION,
    authorizeOperation: fixture.authorization.authorizeOperation,
    controllers: gatewayController(fixture.registry),
    input,
    logger: {
      debug() : any {},
      error() : any {},
      warn() : any {}
    },
    method: operation.http?.method || "POST",
    operation,
    operationProofSubstrate: fixture.proof,
    request,
    requestBody,
    response,
    revalidateAuthorization: fixture.authorization.authorizeOperation,
    signal,
    transport: "http",
    upstreamFinalEffectAuthority: fixture.upstreamFinalEffectAuthority,
    url: new URL(
      `http://127.0.0.1${operation.http?.path || "/api/gateway/v1/forward"}`
    )
  });
  await dispatched;
  return {
    body: response.json(),
    response
  };
}

function artifactProxy(realPort?: any, calls?: any) : any {
  const wrappers: any = new Map<any, any>();
  const observed: any = new Set<any>(["abort", "beginWrite", "commit", "openRead", "resolve"]);
  return new Proxy(realPort, {
    get(target?: any, property?: any, receiver?: any) : any {
      const value: any = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (!observed.has(property)) return value.bind(target);
      if (!wrappers.has(property)) {
        wrappers.set(property, (...args: any[]) : any => {
          calls[property].push(args);
          return value.apply(target, args);
        });
      }
      return wrappers.get(property);
    }
  });
}

async function createCompletedUpload(store?: any, payloads?: any) : Promise<any> {
  uploadSequence += 1;
  const label: any = `stream-artifact-upload-${uploadSequence}`;
  const owner: any = AUTH_SESSION.user;
  const created: any = await store.createOrResumeUploadSession({
    checkpoint: {
      archiveBatchId: `${label}-batch`,
      checkpointId: label,
      clientUid: `${label}-client`,
      sourceType: "upload"
    },
    files: payloads.map((bytes?: any, index?: any) : any => ({
      byteSize: bytes.byteLength,
      mediaType: "application/octet-stream",
      relativePath: index === 0 ? "bin/installer.sh" : `bin/part-${index}.bin`,
      sha256: sha256(bytes)
    })),
    manifest: {
      inputDigest: sha256(`${label}:input`),
      manifestDigest: sha256(`${label}:manifest`)
    },
    owner
  });
  for (const [fileIndex, bytes] of payloads.entries()) {
    let offset: any = 0;
    while (offset < bytes.byteLength) {
      const end: any = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
      const appended: any = await store.appendUploadSessionChunk({
        buffer: bytes.subarray(offset, end),
        fileIndex,
        offset,
        owner,
        sessionId: created.sessionId
      });
      expect(appended.ok).toBe(true);
      offset = end;
    }
  }
  const descriptors: any = await store.resolveUploadSessionFiles(
    created.sessionId,
    { owner }
  );
  return {
    created,
    descriptors,
    owner,
    payloads,
    reference(fileIndex: any = 0) : any {
      return `upload:${created.sessionId}:${fileIndex}`;
    }
  };
}

function operationFixture(operationKey?: any, {
  pathName = `/${operationKey}`,
  request,
  response
}: Record<string, any> = {}) : any {
  return {
    method: "POST",
    operationKey,
    path: pathName,
    protocol: "http",
    requiredScopes: ["gateway:write"],
    risk: "safe_write",
    payloadTransport: {
      request,
      response
    }
  };
}

function serviceFixture(baseUrl?: any, {
  nativePath = "/native"
}: Record<string, any> = {}) : any {
  const structuredResponse: Record<string, any> = {
    maxBytes: 1024 * 1024,
    mediaTypes: ["application/json"],
    mode: "structured_json"
  };
  const opaqueResponse: Record<string, any> = {
    maxBytes: 32 * 1024 * 1024,
    mediaTypes: ["application/octet-stream"],
    mode: "opaque_stream"
  };
  return {
    allowLocalNetwork: true,
    baseUrl,
    credentialRefs: [SECRET_REF],
    operations: [
      operationFixture("native", {
        pathName: nativePath,
        request: {
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/octet-stream"],
          mode: "opaque_stream"
        },
        response: opaqueResponse
      }),
      operationFixture("uncertain", {
        request: {
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/octet-stream"],
          mode: "opaque_stream"
        },
        response: opaqueResponse
      }),
      operationFixture("slow", {
        request: {
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/octet-stream"],
          mode: "opaque_stream"
        },
        response: opaqueResponse
      }),
      operationFixture("artifact-body", {
        request: {
          artifactArgument: "file",
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/octet-stream"],
          mode: "artifact_body"
        },
        response: structuredResponse
      }),
      operationFixture("artifact-multipart", {
        request: {
          maxBytes: 1024 * 1024,
          mediaTypes: ["multipart/form-data"],
          mode: "artifact_multipart",
          multipart: {
            artifactParts: [
              {
                argument: "files",
                maxCount: 2,
                multiple: true,
                partName: "file",
                required: true
              }
            ],
            maxParts: 3,
            scalarFields: [
              {
                argument: "targetFormat",
                partName: "target_format",
                required: true
              }
            ]
          }
        },
        response: structuredResponse
      }),
      operationFixture("artifact-response", {
        request: {
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/json"],
          mode: "structured_json"
        },
        response: {
          allowRanges: true,
          maxBytes: 1024 * 1024,
          mediaTypes: ["application/pdf"],
          mode: "artifact"
        }
      })
    ],
    serviceId: SERVICE_ID,
    serviceProtocol: "http",
    trafficPolicy: {
      burst: 100,
      maxConcurrent: 1,
      perMinute: 100
    }
  };
}

function installServiceSnapshot(registry?: any, rawService?: any, revision?: any) : any {
  const normalized: any = normalizeService(rawService, {});
  const service: Readonly<Record<string, any>> = Object.freeze({
    ...normalized,
    manifestDigest: fingerprint(rawService),
    serviceRevision: revision
  });
  return registry.replaceFromManifestSnapshot(Object.freeze({
    serviceEntries: Object.freeze([
      Object.freeze([SERVICE_ID, service])
    ]),
    setDigest: fingerprint({ rawService, revision }),
    setRevision: revision
  }), { deferSideEffects: true });
}

async function startPeer() : Promise<any> {
  const requests: any[] = [];
  const uncertainBytes: any[] = [];
  const slowClosed: any = deferred();
  const slowTracker: Record<string, any> = {
    backpressureCount: 0,
    bytesScheduled: 0,
    completed: false,
    started: false,
    totalBytes: 16 * 1024 * 1024
  };
  const sockets: any = new Set<any>();
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    const pathname: any = new URL(
      request.url || "/",
      "http://127.0.0.1"
    ).pathname;
    if (pathname === "/uncertain") {
      request.once("data", (chunk?: any) : any => {
        uncertainBytes.push(Buffer.from(chunk));
        requests.push({
          body: Buffer.concat(uncertainBytes),
          headers: { ...request.headers },
          pathname
        });
        request.socket.destroy();
      });
      return;
    }
    const chunks: any[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: any = Buffer.concat(chunks);
    requests.push({
      body,
      headers: { ...request.headers },
      pathname
    });
    if (pathname === "/slow") {
      slowTracker.started = true;
      response.writeHead(200, {
        "content-type": "application/octet-stream"
      });
      response.socket.once("close", () : any => slowClosed.resolve());
      const payload: any = Buffer.alloc(CHUNK_BYTES, 0x73);
      while (
        slowTracker.bytesScheduled < slowTracker.totalBytes &&
        !response.destroyed
      ) {
        slowTracker.bytesScheduled += payload.byteLength;
        if (!response.write(payload)) {
          slowTracker.backpressureCount += 1;
          await new Promise((resolve?: any) : any => {
            const settle: any = () : any => {
              response.off("close", settle);
              response.off("drain", settle);
              resolve();
            };
            response.once("close", settle);
            response.once("drain", settle);
          });
        }
      }
      if (!response.destroyed) {
        slowTracker.completed = true;
        response.end();
      }
      return;
    }
    if (pathname === "/artifact-response") {
      response.writeHead(200, {
        "content-disposition": "attachment; filename=governed.pdf",
        "content-type": "application/pdf"
      });
      response.end(RESPONSE_ARTIFACT);
      return;
    }
    if (pathname === "/native") {
      response.writeHead(200, {
        "cache-control": "public, max-age=86400",
        "content-type": "application/octet-stream",
        vary: "authorization"
      });
      response.end(Buffer.concat([
        Buffer.from("NATIVE:", "utf8"),
        body
      ]));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({
      accepted: true,
      byteLength: body.byteLength,
      pathname
    }));
  });
  server.on("connection", (socket?: any) : any => {
    sockets.add(socket);
    socket.on("close", () : any => sockets.delete(socket));
  });
  const port: any = await listen(server);
  cleanup.push(async () : Promise<any> => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve?: any) : any => server.close(resolve));
    }
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    slowClosed,
    slowTracker,
    uncertainBytes
  };
}

async function createGatewayServer(fixture?: any) : Promise<any> {
  const lifecycle: any = createLifecycle();
  const handler: any = createHttpServerRequestHandler({
    activeApiOperations: [{
      id: "gateway.payload.transit",
      requiredScopes: ["gateway:write"]
    }],
    consoleAuth: null,
    controllers: {},
    distPath: "",
    getDiscoveryState: () : any => ({}),
    getListenUrl: () : any => "http://127.0.0.1",
    getOperationPermissionPlatform: () : any => null,
    ingressContract: null,
    ipRateLimiter: allowRateLimit(),
    lifecycle,
    loginRateLimiter: allowRateLimit(),
    operationAuditStore: null,
    operationConcurrencyScope: "stream-artifact-final-effect",
    operationProofSubstrate: fixture.proof,
    pluginContributions: [],
    proxyApiRequest: async () : Promise<any> => {},
    rateLimits: { windowMs: 60_000 },
    registeredCoreProvider: {
      dispatchRegisteredHttpOperation: async () : Promise<any> => false,
      dispatchRpcOperation: async () : Promise<any> => false,
      findProxyRegisteredApiRequest: () : any => null
    },
    runtimeLogger: {
      debug() : any {},
      error() : any {},
      info() : any {},
      warn() : any {}
    },
    securityPermissions: {
      authorizeOperation: fixture.authorization.authorizeOperation,
      verifyProcessIdentity: async () : Promise<any> => ({ ok: true })
    },
    subjectRateLimiter: allowRateLimit(),
    tenantRateLimiter: allowRateLimit(),
    toolSkillManagementProvider: {},
    upstreamFinalEffectAuthority: fixture.upstreamFinalEffectAuthority,
    upstreamGatewayRegistryForMcp: fixture.registry
  });
  const sockets: any = new Set<any>();
  const server: any = http.createServer(handler);
  server.on("connection", (socket?: any) : any => {
    sockets.add(socket);
    socket.on("close", () : any => sockets.delete(socket));
  });
  const port: any = await listen(server);
  cleanup.push(async () : Promise<any> => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve?: any) : any => server.close(resolve));
    }
  });
  return { lifecycle, port };
}

function nativeRequest(port?: any, operationKey: any = "native", {
  body = "x",
  connection = "close",
  contentLength = Buffer.byteLength(body),
  contentType = "application/octet-stream"
}: Record<string, any> = {}) : any {
  return Buffer.from([
    `POST /api/gateway/v1/transit/${SERVICE_ID}/${operationKey} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${contentLength}`,
    `Connection: ${connection}`,
    "",
    body
  ].join("\r\n"), "latin1");
}

async function rawExchange(port?: any, bytes?: any, {
  timeoutMs = 6_000
}: Record<string, any> = {}) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const chunks: any[] = [];
    let settled: any = false;
    let socketError: any = null;
    const socket: any = net.createConnection({
      host: "127.0.0.1",
      port
    });
    const timer: any = setTimeout(() : any => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Timed out waiting for raw gateway response."));
    }, timeoutMs);
    const finish: any = () : any => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        bytes: Buffer.concat(chunks),
        error: socketError
      });
    };
    socket.on("data", (chunk?: any) : any => chunks.push(Buffer.from(chunk)));
    socket.on("error", (error?: any) : any => {
      socketError = error;
    });
    socket.on("close", finish);
    socket.once("connect", () : any => socket.write(bytes));
  });
}

function rawStatus(bytes?: any) : any {
  const match: any = /^HTTP\/1\.[01]\s+(\d{3})/u.exec(bytes.toString("latin1"));
  return match ? Number(match[1]) : 0;
}

function findArtifactReference(value?: any) : any {
  if (typeof value === "string" && value.startsWith("artifact:")) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found: any = findArtifactReference(item);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    for (const item of (Object.values(value) as any[])) {
      const found: any = findArtifactReference(item);
      if (found) return found;
    }
  }
  return "";
}

async function consumeSource(source?: any) : Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of source.open()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function createFixture() : Promise<any> {
  const root: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-stream-artifact-final-effect-")
  );
  cleanup.push(() : any => fs.rm(root, { recursive: true, force: true }));
  const proof: any = proofSubstrate();
  const upstreamFinalEffectAuthority: any = createUpstreamFinalEffectAuthority({
    operationProofSubstrate: proof
  });
  cleanup.push(async () : Promise<any> => {
    await upstreamFinalEffectAuthority.close?.();
  });
  const storageKernel: any = createStorageKernel({ userDataPath: root });
  cleanup.push(() : any => storageKernel.close());
  const baseStorageProvider: any = createStorageProvider({
    storageKernel,
    userDataPath: root
  });
  const openPrivateNoExecObjectReadStream: any = vi.fn((input?: any) : any => (
    baseStorageProvider.openPrivateNoExecObjectReadStream(input)
  ));
  const storageProvider: Readonly<Record<string, any>> = Object.freeze({
    ...baseStorageProvider,
    openPrivateNoExecObjectReadStream
  });
  const baseKeyBroker: any = createLocalCustodyKeyBroker({ userDataPath: root });
  const unwrapKey: any = vi.fn((...args: any[]) : any => baseKeyBroker.unwrapKey(...args));
  const keyBroker: Readonly<Record<string, any>> = Object.freeze({
    close: () : any => baseKeyBroker.close(),
    keyReference: baseKeyBroker.keyReference,
    unwrapKey,
    wrapKey: (...args: any[]) : any => baseKeyBroker.wrapKey(...args)
  });
  cleanup.push(async () : Promise<any> => {
    await keyBroker.close();
  });
  const uploadNoRunCustody: any = createUploadNoRunCustody({
    keyBroker,
    reauthorizeCustodyRead:
      upstreamFinalEffectAuthority.reauthorizeCustodyRead,
    storageKernel,
    storageProvider,
    userDataPath: root
  });
  const uploadSessionStore: any = createUploadSessionStore({
    custodyDescribe: uploadNoRunCustody.describe,
    custodyPort: uploadNoRunCustody.stagingPort,
    userDataPath: root
  });
  const realArtifactPort: any = await createArtifactTransitProvider({
    uploadNoRunCustodyReadPort: uploadNoRunCustody.readPort,
    uploadSessionStore,
    userDataPath: root
  });
  cleanup.push(() : any => realArtifactPort.close());
  const artifactCalls: Record<string, any> = {
    abort: [],
    beginWrite: [],
    commit: [],
    openRead: [],
    resolve: []
  };
  const artifactTransitPort: any = artifactProxy(realArtifactPort, artifactCalls);
  const baseSecretKeyProvider: any = createMemoryLocalSecretKeyProvider();
  const credentialReads: any = vi.fn(() : any => baseSecretKeyProvider.loadKey());
  const secretKeyProvider: Readonly<Record<string, any>> = Object.freeze({
    close: () : any => baseSecretKeyProvider.close(),
    custody: baseSecretKeyProvider.custody,
    describe: () : any => baseSecretKeyProvider.describe(),
    loadKey: credentialReads,
    protocolVersion: baseSecretKeyProvider.protocolVersion
  });
  cleanup.push(() : any => secretKeyProvider.close());
  const registry: any = createUpstreamGatewayRegistry({
    artifactTransitPort,
    secretKeyProvider,
    userDataPath: root
  });
  cleanup.push(() : any => registry.close());
  const peer: any = await startPeer();
  const target: any = new URL(peer.baseUrl);
  await initializeLocalSecret({
    dataDir: root,
    keyProvider: secretKeyProvider,
    payload: {
      token: CREDENTIAL
    },
    secretRef: SECRET_REF,
    target: {
      authType: "bearer",
      family: "stream-artifact-final-effect",
      provider: "fixture",
      scope: {
        allowedHosts: [target.hostname],
        allowedProtocols: [target.protocol.replace(/:$/u, "")],
        scopes: ["gateway:write"],
        serviceId: SERVICE_ID
      }
    }
  });
  credentialReads.mockClear();
  let serviceRevision: any = 0;
  let currentRawService: any = serviceFixture(peer.baseUrl);
  function replaceService(overrides: Record<string, any> = {}) : any {
    serviceRevision += 1;
    currentRawService = serviceFixture(
      overrides.baseUrl || peer.baseUrl,
      {
        nativePath: overrides.nativePath || "/native"
      }
    );
    installServiceSnapshot(registry, currentRawService, serviceRevision);
    return currentRawService;
  }
  replaceService();
  const authorizationEvents: any[] = [];
  const authorization: any = createAuthorizationHarness(authorizationEvents);
  const fixture: Record<string, any> = {
    artifactCalls,
    artifactTransitPort,
    authorization,
    authorizationEvents,
    credentialReads,
    gateway: null,
    keyBroker,
    openPrivateNoExecObjectReadStream,
    peer,
    proof,
    realArtifactPort,
    registry,
    replaceService,
    root,
    serviceSnapshot() : any {
      return registry.captureManifestSnapshotState();
    },
    storageKernel,
    storageProvider,
    unwrapKey,
    uploadNoRunCustody,
    uploadSessionStore,
    upstreamFinalEffectAuthority
  };
  fixture.gateway = await createGatewayServer(fixture);
  return fixture;
}

afterEach(async () : Promise<any> => {
  while (cleanup.length > 0) {
    await cleanup.pop()();
  }
  vi.clearAllMocks();
});

describe("upstream stream and artifact final-effect permits", () : any => {
  it("uses independent credential and network permits on the real native HTTP stream", async () : Promise<any> => {
    const fixture: any = await createFixture();
    const eventOffset: any = fixture.authorization.eventCount();

    const exchange: any = await rawExchange(
      fixture.gateway.port,
      nativeRequest(fixture.gateway.port, "native", {
        body: "native-payload"
      })
    );

    expect(rawStatus(exchange.bytes)).toBe(200);
    expect(exchange.bytes.toString("latin1")).toContain("NATIVE:native-payload");
    expect(exchange.bytes.toString("latin1").toLowerCase())
      .toContain("cache-control: private, no-store");
    expect(exchange.bytes.toString("latin1").toLowerCase())
      .not.toContain("vary: authorization");
    expect(fixture.authorization.effectKinds({ from: eventOffset })).toEqual([
      EFFECT.credential,
      EFFECT.network
    ]);
    expect(fixture.credentialReads).toHaveBeenCalledOnce();
    expect(fixture.peer.requests).toHaveLength(1);
    expect(fixture.peer.requests[0]).toMatchObject({
      pathname: "/native"
    });
    expect(fixture.peer.requests[0].body.toString("utf8")).toBe("native-payload");
    expect(fixture.artifactCalls.beginWrite).toHaveLength(0);
    expect(fixture.openPrivateNoExecObjectReadStream).not.toHaveBeenCalled();
  });

  it("burns native authority on route, header, length, endpoint, policy, or cancellation drift before effects", async () : Promise<any> => {
    const fixture: any = await createFixture();
    const variants: any[] = [
      {
        label: "route",
        mutate: async () : Promise<any> => {
          fixture.replaceService({ nativePath: "/native-replaced" });
        }
      },
      {
        label: "header",
        mutate: async ({ request }: Record<string, any>) : Promise<any> => {
          request.headers["content-type"] = "application/replaced";
        }
      },
      {
        label: "length",
        mutate: async ({ request }: Record<string, any>) : Promise<any> => {
          request.headers["content-length"] = "999";
        }
      },
      {
        label: "endpoint",
        mutate: async () : Promise<any> => {
          fixture.replaceService({
            baseUrl: "http://127.0.0.1:9"
          });
        }
      },
      {
        label: "policy",
        mutate: async () : Promise<any> => {
          fixture.authorization.replaceContext({
            ...fixture.authorization.context(),
            policyRevision: "policy-drifted"
          });
        }
      },
      {
        label: "cancellation",
        mutate: async ({ request }: Record<string, any>) : Promise<any> => {
          request.destroy();
        }
      }
    ];

    for (const variant of variants) {
      const snapshot: any = fixture.serviceSnapshot();
      const credentialCount: any = fixture.credentialReads.mock.calls.length;
      const openCount: any =
        fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
      const unwrapCount: any = fixture.unwrapKey.mock.calls.length;
      const peerCount: any = fixture.peer.requests.length;
      const beginCount: any = fixture.artifactCalls.beginWrite.length;
      fixture.authorization.setMutation({
        effectKind: EFFECT.credential,
        run: variant.mutate
      });

      const exchange: any = await rawExchange(
        fixture.gateway.port,
        nativeRequest(fixture.gateway.port, "native", {
          body: `drift-${variant.label}`
        })
      );

      expect(rawStatus(exchange.bytes), variant.label).not.toBe(200);
      expect(fixture.credentialReads.mock.calls.length, variant.label)
        .toBe(credentialCount);
      expect(
        fixture.openPrivateNoExecObjectReadStream.mock.calls.length,
        variant.label
      ).toBe(openCount);
      expect(fixture.unwrapKey.mock.calls.length, variant.label)
        .toBe(unwrapCount);
      expect(fixture.peer.requests.length, variant.label).toBe(peerCount);
      expect(fixture.artifactCalls.beginWrite.length, variant.label)
        .toBe(beginCount);

      fixture.registry.restoreManifestSnapshotState(snapshot);
      fixture.authorization.restoreContext();
      const fresh: any = await rawExchange(
        fixture.gateway.port,
        nativeRequest(fixture.gateway.port, "native", {
          body: `fresh-${variant.label}`
        })
      );
      expect(rawStatus(fresh.bytes), variant.label).toBe(200);
      expect(fixture.peer.requests.length, variant.label).toBe(peerCount + 1);
    }
  });

  it("partitions artifact body, multipart, credential, network, response begin, and response commit permits", async () : Promise<any> => {
    const fixture: any = await createFixture();
    const upload: any = await createCompletedUpload(
      fixture.uploadSessionStore,
      [EXECUTABLE_UPLOAD, SECOND_UPLOAD]
    );

    let offset: any = fixture.authorization.eventCount();
    const bodyResult: any = await dispatchGateway(fixture, "artifact-body", {
      arguments: {
        file: upload.reference(0)
      }
    });
    expect(bodyResult.response.statusCode).toBe(200);
    expect(fixture.authorization.effectKinds({ from: offset })).toEqual([
      EFFECT.artifactRead,
      EFFECT.credential,
      EFFECT.network
    ]);
    expect(fixture.peer.requests.at(-1)).toMatchObject({
      pathname: "/artifact-body"
    });
    expect(fixture.peer.requests.at(-1).body).toEqual(EXECUTABLE_UPLOAD);

    offset = fixture.authorization.eventCount();
    const multipartResult: any = await dispatchGateway(
      fixture,
      "artifact-multipart",
      {
        arguments: {
          files: [upload.reference(0), upload.reference(1)],
          targetFormat: "pdf"
        }
      }
    );
    expect(multipartResult.response.statusCode).toBe(200);
    expect(fixture.authorization.effectKinds({ from: offset })).toEqual([
      EFFECT.artifactRead,
      EFFECT.artifactRead,
      EFFECT.credential,
      EFFECT.network
    ]);
    const multipart: any = fixture.peer.requests.at(-1).body.toString("utf8");
    expect(fixture.peer.requests.at(-1)).toMatchObject({
      pathname: "/artifact-multipart"
    });
    expect(multipart).toContain('name="target_format"');
    expect(multipart).toContain("pdf");
    expect(multipart).toContain('name="file"; filename="installer.sh"');
    expect(multipart).toContain(EXECUTABLE_UPLOAD.toString("utf8"));
    expect(multipart).toContain(SECOND_UPLOAD.toString("utf8"));

    offset = fixture.authorization.eventCount();
    const responseResult: any = await dispatchGateway(
      fixture,
      "artifact-response",
      {
        arguments: {
          render: "pdf"
        }
      }
    );
    expect(responseResult.response.statusCode).toBe(200);
    expect(fixture.authorization.effectKinds({ from: offset })).toEqual([
      EFFECT.credential,
      EFFECT.network,
      EFFECT.responseBegin,
      EFFECT.responseCommit
    ]);
    expect(fixture.artifactCalls.beginWrite).toHaveLength(1);
    expect(fixture.artifactCalls.commit).toHaveLength(1);
    expect(fixture.artifactCalls.abort).toHaveLength(0);
    const artifactReference: any = findArtifactReference(responseResult.body);
    expect(artifactReference).toMatch(/^artifact:/u);
    const committedSource: any = await fixture.realArtifactPort.openRead(
      artifactReference,
      AUTH_SESSION.user,
      "acceptance-response-read"
    );
    await expect(consumeSource(committedSource)).resolves
      .toEqual(RESPONSE_ARTIFACT);

    expect(fixture.openPrivateNoExecObjectReadStream).toHaveBeenCalledTimes(3);
    expect(fixture.unwrapKey).toHaveBeenCalledTimes(3);
    const custodyRevalidations: any = fixture.authorizationEvents.filter(
      (event?: any) : any => event.phase === "final-protected-sink-custody-read"
    );
    expect(custodyRevalidations).toHaveLength(3);
    expect(custodyRevalidations.every(
      (event?: any) : any => event.effectKind === EFFECT.artifactRead
    )).toBe(true);
    expect(fixture.credentialReads).toHaveBeenCalledTimes(3);
    expect(fixture.peer.requests).toHaveLength(3);
  });

  it("denies artifact revision drift and every upload range before private or network effects", async () : Promise<any> => {
    const fixture: any = await createFixture();
    const upload: any = await createCompletedUpload(
      fixture.uploadSessionStore,
      [EXECUTABLE_UPLOAD]
    );
    const metaPath: any = getSessionMetaPath(
      fixture.root,
      upload.created.sessionId
    );
    const originalMeta: any = await fs.readFile(metaPath, "utf8");
    fixture.authorization.setMutation({
      effectKind: EFFECT.artifactRead,
      run: async () : Promise<any> => {
        const changed: any = JSON.parse(originalMeta);
        changed.files[0].sha256 = sha256("artifact-revision-substitution");
        await fs.writeFile(metaPath, JSON.stringify(changed, null, 2), "utf8");
      }
    });
    const credentialCount: any = fixture.credentialReads.mock.calls.length;
    const peerCount: any = fixture.peer.requests.length;
    const openCount: any =
      fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    const unwrapCount: any = fixture.unwrapKey.mock.calls.length;
    const beginCount: any = fixture.artifactCalls.beginWrite.length;

    const stale: any = await dispatchGateway(fixture, "artifact-body", {
      arguments: {
        file: upload.reference(0)
      }
    });

    expect(stale.response.statusCode).toBeGreaterThanOrEqual(400);
    expect(fixture.credentialReads).toHaveBeenCalledTimes(credentialCount);
    expect(fixture.peer.requests).toHaveLength(peerCount);
    expect(fixture.openPrivateNoExecObjectReadStream)
      .toHaveBeenCalledTimes(openCount);
    expect(fixture.unwrapKey).toHaveBeenCalledTimes(unwrapCount);
    expect(fixture.artifactCalls.beginWrite).toHaveLength(beginCount);

    await fs.writeFile(metaPath, originalMeta, "utf8");
    const fresh: any = await dispatchGateway(fixture, "artifact-body", {
      arguments: {
        file: upload.reference(0)
      }
    });
    expect(fresh.response.statusCode).toBe(200);
    expect(fixture.peer.requests).toHaveLength(peerCount + 1);

    const eventOffset: any = fixture.authorization.eventCount();
    const rangeOpenCount: any =
      fixture.openPrivateNoExecObjectReadStream.mock.calls.length;
    await expect(fixture.realArtifactPort.openRead(
      upload.reference(0),
      AUTH_SESSION.user,
      "upstream-request",
      {
        end: 8,
        start: 0
      }
    )).rejects.toMatchObject({
      code: "artifact_upload_range_unsupported"
    });
    expect(fixture.authorization.eventCount()).toBe(eventOffset);
    expect(fixture.openPrivateNoExecObjectReadStream)
      .toHaveBeenCalledTimes(rangeOpenCount);
  });

  it("separately denies response artifact begin or commit without publication or network retry", async () : Promise<any> => {
    const fixture: any = await createFixture();

    const beginPeerCount: any = fixture.peer.requests.length;
    const beginWriteCount: any = fixture.artifactCalls.beginWrite.length;
    const beginCommitCount: any = fixture.artifactCalls.commit.length;
    fixture.authorization.setMutation({
      effectKind: EFFECT.responseBegin,
      run: async () : Promise<any> => {
        fixture.authorization.replaceContext({
          ...fixture.authorization.context(),
          policyRevision: "response-begin-policy-drift"
        });
      }
    });
    const beginDenied: any = await dispatchGateway(
      fixture,
      "artifact-response",
      {
        arguments: { render: "begin-denied" }
      }
    );
    expect(beginDenied.response.statusCode).toBeGreaterThanOrEqual(400);
    expect(fixture.peer.requests).toHaveLength(beginPeerCount + 1);
    expect(fixture.artifactCalls.beginWrite).toHaveLength(beginWriteCount);
    expect(fixture.artifactCalls.commit).toHaveLength(beginCommitCount);
    expect(findArtifactReference(beginDenied.body)).toBe("");

    fixture.authorization.restoreContext();
    const commitPeerCount: any = fixture.peer.requests.length;
    const commitBeginCount: any = fixture.artifactCalls.beginWrite.length;
    const commitCount: any = fixture.artifactCalls.commit.length;
    const abortCount: any = fixture.artifactCalls.abort.length;
    fixture.authorization.setMutation({
      effectKind: EFFECT.responseCommit,
      run: async () : Promise<any> => {
        fixture.authorization.replaceContext({
          ...fixture.authorization.context(),
          policyRevision: "response-commit-policy-drift"
        });
      }
    });
    const commitDenied: any = await dispatchGateway(
      fixture,
      "artifact-response",
      {
        arguments: { render: "commit-denied" }
      }
    );
    expect(commitDenied.response.statusCode).toBeGreaterThanOrEqual(400);
    expect(fixture.peer.requests).toHaveLength(commitPeerCount + 1);
    expect(fixture.artifactCalls.beginWrite)
      .toHaveLength(commitBeginCount + 1);
    expect(fixture.artifactCalls.commit).toHaveLength(commitCount);
    expect(fixture.artifactCalls.abort).toHaveLength(abortCount + 1);
    expect(findArtifactReference(commitDenied.body)).toBe("");

    fixture.authorization.restoreContext();
    const control: any = await dispatchGateway(
      fixture,
      "artifact-response",
      {
        arguments: { render: "control" }
      }
    );
    expect(control.response.statusCode).toBe(200);
    expect(findArtifactReference(control.body)).toMatch(/^artifact:/u);
    expect(fixture.peer.requests).toHaveLength(commitPeerCount + 2);
  });

  it("does not blindly retry after request bytes become network-uncertain", async () : Promise<any> => {
    const fixture: any = await createFixture();
    const eventOffset: any = fixture.authorization.eventCount();
    const peerCount: any = fixture.peer.requests.length;

    const uncertain: any = await rawExchange(
      fixture.gateway.port,
      nativeRequest(fixture.gateway.port, "uncertain", {
        body: "uncertain-request-body"
      })
    );
    expect(rawStatus(uncertain.bytes)).not.toBe(200);
    await delay(150);
    expect(fixture.peer.requests).toHaveLength(peerCount + 1);
    expect(Buffer.concat(fixture.peer.uncertainBytes).byteLength)
      .toBeGreaterThan(0);
    expect(
      fixture.authorization
        .effectKinds({ from: eventOffset })
        .filter((kind?: any) : any => kind === EFFECT.network)
    ).toHaveLength(1);

    const freshOffset: any = fixture.authorization.eventCount();
    const fresh: any = await rawExchange(
      fixture.gateway.port,
      nativeRequest(fixture.gateway.port, "native", {
        body: "uncertainty-control"
      })
    );
    expect(rawStatus(fresh.bytes)).toBe(200);
    expect(fixture.peer.requests).toHaveLength(peerCount + 2);
    expect(
      fixture.authorization
        .effectKinds({ from: freshOffset })
        .filter((kind?: any) : any => kind === EFFECT.network)
    ).toHaveLength(1);
  });

  it("preserves native backpressure, cancellation, upstream close, and traffic-slot release", async () : Promise<any> => {
    const fixture: any = await createFixture();
    const downstream: any = net.createConnection({
      host: "127.0.0.1",
      port: fixture.gateway.port
    });
    downstream.on("error", () : any => {});
    downstream.pause();
    await new Promise((resolve?: any, reject?: any) : any => {
      downstream.once("connect", resolve);
      downstream.once("error", reject);
    });
    downstream.write(nativeRequest(
      fixture.gateway.port,
      "slow",
      {
        body: "slow"
      }
    ));

    await waitFor(
      () : any => fixture.peer.slowTracker.started,
      { label: "slow upstream start" }
    );
    await waitFor(
      () : any => fixture.peer.slowTracker.backpressureCount > 0,
      { label: "real upstream backpressure" }
    );
    const scheduledAtPressure: any =
      fixture.peer.slowTracker.bytesScheduled;
    await delay(150);
    expect(fixture.peer.slowTracker.completed).toBe(false);
    expect(fixture.peer.slowTracker.bytesScheduled)
      .toBeLessThan(fixture.peer.slowTracker.totalBytes);
    expect(
      fixture.peer.slowTracker.bytesScheduled - scheduledAtPressure
    ).toBeLessThan(8 * 1024 * 1024);

    downstream.destroy();
    await withTimeout(
      fixture.peer.slowClosed.promise,
      4_000,
      "upstream close after downstream cancellation"
    );
    const fresh: any = await rawExchange(
      fixture.gateway.port,
      nativeRequest(fixture.gateway.port, "native", {
        body: "post-cancel-control"
      })
    );
    expect(rawStatus(fresh.bytes)).toBe(200);
    expect(fresh.bytes.toString("latin1"))
      .toContain("NATIVE:post-cancel-control");
  }, 15_000);
});
