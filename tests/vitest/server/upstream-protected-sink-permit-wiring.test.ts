import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpstreamGatewayRegistry } from "#meshrix/agents/upstream-gateway/index";
import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import {
  createMemoryLocalSecretKeyProvider
} from "#meshrix/foundation/security/secrets/local-secret-key-provider";
import {
  initializeLocalSecret
} from "#meshrix/foundation/security/secrets/local-secret-store";
import {
  createSystemControllerFoundationHandlers
} from "#meshrix/protocols/http/controllers/system-controller-foundation-handlers";
import {
  dispatchOperation
} from "#meshrix/server-runtime/composition/dispatch-operation";
import {
  executeConsoleDomainOperation
} from "#meshrix/server-runtime/composition/console-domain/operation-executor";
import {
  createAuthorizationEngine
} from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SESSION_COOKIE,
  createConsoleAuth
} from "../../../packages/foundation/src/security/auth/console-auth.ts";
import {
  createSecurityPermissionsProvider
} from "../../../packages/foundation/src/security/security-permissions-provider.ts";
import {
  fingerprint
} from "../../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import {
  compileUpstreamOperationProjection
} from "../../../packages/agents/src/upstream-gateway/operation-projection.ts";
import {
  normalizeService
} from "../../../packages/agents/src/upstream-gateway/support.ts";
import {
  dispatchRegisteredHttpOperation
} from "../../../packages/server-runtime/src/composition/dispatch-operation-http.ts";
import {
  dispatchRpcOperation
} from "../../../packages/server-runtime/src/composition/dispatch-operation-rpc.ts";
import {
  createTagStoreAdapter
} from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";
import {
  structuredUpstreamServiceFixture
} from "../../helpers/upstream-runtime-snapshot.ts";

const SECRET_REF: any = "secret://upstream-final-effect/fixture";
const SERVICE_ID: any = "final-effect-fixture";
const SUBJECT: Readonly<Record<string, any>> = Object.freeze({
  generation: "17",
  subjectId: "final-effect-subject",
  tenantId: "final-effect-tenant",
  type: "console-user"
});
const SUBJECT_WITH_SCOPES: Readonly<Record<string, any>> = Object.freeze({
  ...SUBJECT,
  roleId: "owner",
  scopes: Object.freeze(["gateway:read", "gateway:write"])
});
const AUTH_SESSION: Readonly<Record<string, any>> = Object.freeze({
  sessionId: "final-effect-session",
  user: Object.freeze({
    ...SUBJECT_WITH_SCOPES,
    userId: SUBJECT.subjectId,
    username: "final-effect-user"
  })
});
const AUTHORITY_CONTEXT: Readonly<Record<string, any>> = Object.freeze({
  approvalRevision: "23",
  grantRevision: "31",
  policyRevision: "47",
  riskRevision: "11",
  workloadGeneration: SUBJECT.generation
});
const PROTECTED_SINK_AUTHORITY_OMISSIONS: readonly any[] = Object.freeze([
  "protectedSinkAuthority",
  "subject.generation",
  "subject.tenantId",
  "context.approvalRevision",
  "context.grantRevision",
  "context.policyRevision",
  "context.riskRevision",
  "context.workloadGeneration"
]);
const REAL_AUTHORITY_MUTATIONS: readonly any[] = Object.freeze([
  ["durable user generation changes", "user-generation-change"],
  ["durable tenant is missing", "tenant-missing"],
  ["durable tenant changes", "tenant-change"],
  ["session/grant revision rotates", "session-rotation"],
  ["session is revoked", "session-revocation"],
  ["governance policy revision changes", "governance-policy-change"],
  ["approval binding changes", "approval-binding-change"],
  ["risk binding changes", "risk-binding-change"]
]);
const SYNTHETIC_CREDENTIAL: any = "fixture-bearer-material";
const REAL_AUTH_USER_AGENT: any = "meshrix-final-effect-authority-acceptance";

const cleanupTasks: any[] = [];

function deferred() : any {
  let resolve: any;
  const promise: any = new Promise((settle?: any) : any => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createResponse() : any {
  return {
    chunks: [],
    statusCode: 0,
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
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

function consoleRequest({
  cookie = "",
  csrf = "",
  url = "/api/gateway/v1/forward"
}: Record<string, any> = {}) : any {
  const headers: Record<string, any> = {
    host: "console.local",
    origin: "http://console.local",
    "user-agent": REAL_AUTH_USER_AGENT
  };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-meshrix-csrf"] = csrf;
  return {
    headers,
    method: "POST",
    socket: {
      encrypted: false,
      remoteAddress: "127.0.0.1"
    },
    url
  };
}

function cookieMap(setCookies: any = []) : any {
  return Object.fromEntries(setCookies.map((cookie?: any) : any => {
    const [name, value = ""] = String(cookie).split(";", 1)[0].split("=");
    return [decodeURIComponent(name), decodeURIComponent(value)];
  }));
}

function authCookieHeader(loginResult?: any) : any {
  const cookies: any = cookieMap(loginResult.cookies);
  return [
    `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(cookies[CONSOLE_SESSION_COOKIE])}`,
    `${CONSOLE_CSRF_COOKIE}=${encodeURIComponent(cookies[CONSOLE_CSRF_COOKIE])}`
  ].join("; ");
}

function proofSubstrate({ afterBeginLifecycle = null }: Record<string, any> = {}) : any {
  return {
    beginLifecycle: vi.fn(async () : Promise<any> => {
      if (afterBeginLifecycle) await afterBeginLifecycle();
      return { ledgerEventId: "proof:upstream-final-effect" };
    }),
    finishLifecycle: vi.fn(async ({ ledgerEventId }: Record<string, any>) : Promise<any> => ({ ledgerEventId })),
    recordReceipt: vi.fn(async () : Promise<any> => ({ ledgerEventId: "proof:upstream-final-effect:receipt" }))
  };
}

function protectedSinkAuthorityWithOmission(omission: any = "") : any {
  if (omission === "protectedSinkAuthority") return null;
  const subject: Record<string, any> = { ...SUBJECT };
  const context: Record<string, any> = { ...AUTHORITY_CONTEXT };
  if (omission.startsWith("subject.")) {
    delete subject[omission.slice("subject.".length)];
  }
  if (omission.startsWith("context.")) {
    delete context[omission.slice("context.".length)];
  }
  return Object.freeze({
    subject: Object.freeze(subject),
    context: Object.freeze(context)
  });
}

function authorizationResult({
  allowed = true,
  authorityOmission = "",
  revoked = false
}: Record<string, any> = {}) : any {
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      reasonCode: revoked
        ? "final_protected_sink_authority_revoked"
        : "final_protected_sink_authority_denied",
      error: "Final protected sink authority denied."
    };
  }
  const protectedSinkAuthority: any =
    protectedSinkAuthorityWithOmission(authorityOmission);
  return {
    ok: true,
    revoked,
    grant: {
      id: "grant-final-effect",
      revision: AUTHORITY_CONTEXT.grantRevision
    },
    authorizationDecision: {
      allowed: true,
      decisionId: "decision-final-effect",
      reasonCode: "fixture_allow",
      riskRevision: AUTHORITY_CONTEXT.riskRevision
    },
    governancePolicyRevision: {
      revision: Number(AUTHORITY_CONTEXT.policyRevision)
    },
    ...(protectedSinkAuthority ? { protectedSinkAuthority } : {})
  };
}

function serviceDescriptor(baseUrl?: any, {
  httpMethod = "POST",
  httpProtocol = "http",
  httpRpcMethod = "http-write"
}: Record<string, any> = {}) : any {
  return structuredUpstreamServiceFixture({
    allowLocalNetwork: true,
    baseUrl,
    credentialRefs: [SECRET_REF],
    serviceId: SERVICE_ID,
    trafficPolicy: {
      burst: 20,
      maxConcurrent: 4,
      perMinute: 20
    },
    operations: [
      {
        method: httpMethod,
        operationKey: "http-write",
        path: "/http-write",
        protocol: httpProtocol,
        ...(httpProtocol === "json-rpc"
          ? { rpcMethod: httpRpcMethod }
          : {}),
        requiredScopes: ["gateway:write"],
        risk: "safe_write"
      },
      {
        method: "POST",
        operationKey: "rpc-write",
        path: "/rpc-write",
        protocol: "json-rpc",
        requiredScopes: ["gateway:write"],
        risk: "safe_write",
        rpcMethod: "fixture.write"
      }
    ]
  });
}

function installService(registry?: any, baseUrl?: any, revision?: any, {
  rawService = serviceDescriptor(baseUrl),
  manifestDigest = fingerprint(rawService),
  serviceRevision = revision,
  setDigest = fingerprint({ revision, rawService })
}: Record<string, any> = {}) : any {
  const normalized: any = normalizeService(rawService, {});
  const service: Readonly<Record<string, any>> = Object.freeze({
    ...normalized,
    manifestDigest,
    serviceRevision
  });
  return registry.replaceFromManifestSnapshot(Object.freeze({
    setDigest,
    setRevision: revision,
    serviceEntries: Object.freeze([
      Object.freeze([SERVICE_ID, service])
    ])
  }), { deferSideEffects: true });
}

function projectedOperationFor(registry?: any, operationKey?: any) : any {
  const projection: any = compileUpstreamOperationProjection(
    registry.captureManifestSnapshotState()
  );
  const operation: any = projection.operations.find(
    (candidate?: any) : any => candidate._meta?.operationKey === operationKey
  );
  if (!operation) throw new Error("Projected upstream operation is unavailable.");
  return operation;
}

async function startUpstreamPeer(name?: any, events?: any) : Promise<any> {
  const requests: any[] = [];
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    events.push(`network-request:${name}`);
    const chunks: any[] = [];
    request.on("data", (chunk?: any) : any => chunks.push(chunk));
    await new Promise((resolve?: any) : any => request.on("end", resolve));
    const rawBody: any = Buffer.concat(chunks).toString("utf8");
    const body: any = rawBody ? JSON.parse(rawBody) : null;
    requests.push({
      body,
      method: request.method,
      pathname: new URL(request.url || "/", "http://127.0.0.1").pathname
    });
    const payload: any = body?.jsonrpc === "2.0"
      ? {
          jsonrpc: "2.0",
          id: body.id,
          result: { accepted: true, peer: name }
        }
      : { accepted: true, peer: name };
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json"
    });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanupTasks.push(() : any => new Promise((resolve?: any) : any => server.close(resolve)));
  const address: any = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests
  };
}

async function createCredentialBoundRegistry(events?: any, baseUrl?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-final-effect-wiring-")
  );
  cleanupTasks.push(() : any => fs.rm(userDataPath, { force: true, recursive: true }));
  const baseKeyProvider: any = createMemoryLocalSecretKeyProvider();
  let observeCredentialReads: any = false;
  const loadKey: any = vi.fn(async () : Promise<any> => {
    if (observeCredentialReads) events.push("credential-read");
    return baseKeyProvider.loadKey();
  });
  const secretKeyProvider: Readonly<Record<string, any>> = Object.freeze({
    protocolVersion: baseKeyProvider.protocolVersion,
    custody: baseKeyProvider.custody,
    loadKey,
    close: () : any => baseKeyProvider.close(),
    describe: () : any => baseKeyProvider.describe()
  });
  cleanupTasks.push(() : any => secretKeyProvider.close());
  const registry: any = createUpstreamGatewayRegistry({
    secretKeyProvider,
    userDataPath
  });
  cleanupTasks.push(() : any => registry.close());
  installService(registry, baseUrl, 1);
  const target: any = new URL(baseUrl);
  await initializeLocalSecret({
    dataDir: userDataPath,
    keyProvider: secretKeyProvider,
    payload: {
      token: SYNTHETIC_CREDENTIAL
    },
    target: {
      authType: "bearer",
      family: "upstream-final-effect-test",
      provider: "fixture",
      scope: {
        allowedHosts: [target.hostname],
        allowedProtocols: [target.protocol.replace(/:$/u, "")],
        scopes: ["gateway:write"],
        serviceId: SERVICE_ID
      },
      secretRef: SECRET_REF
    }
  });
  loadKey.mockClear();
  observeCredentialReads = true;
  return {
    credentialReads: loadKey,
    registry
  };
}

async function createRealConsoleAuthorityFixture(events?: any, baseUrl?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-final-effect-authority-")
  );
  cleanupTasks.push(() : any => fs.rm(userDataPath, { force: true, recursive: true }));
  const tagManagementStore: any = createTagStoreAdapter({ userDataPath });
  cleanupTasks.push(() : any => tagManagementStore.close());
  const consoleAuth: any = createConsoleAuth({
    userDataPath,
    tagManagementStore
  });
  cleanupTasks.push(() : any => consoleAuth.close());
  const owner: any = await consoleAuth.ensureInitialOwner();
  const loginResult: any = await consoleAuth.login(
    {
      password: owner.password,
      username: owner.username
    },
    consoleRequest({ url: "/api/console/auth/login" })
  );
  const securityPermissions: any = createSecurityPermissionsProvider({
    consoleAuth
  });
  const { credentialReads, registry } =
    await createCredentialBoundRegistry(events, baseUrl);
  return {
    consoleAuth,
    credentialReads,
    csrfToken: loginResult.csrfToken,
    loginResult,
    owner,
    registry,
    securityPermissions,
    session: loginResult.session,
    sessionCookie: authCookieHeader(loginResult)
  };
}

async function mutateRealAuthority({
  consoleAuth,
  kind,
  operation,
  owner,
  request,
  phase
}: Record<string, any>) : Promise<any> {
  if (kind === "user-generation-change") {
    await consoleAuth.updateUser(owner.user.userId, {
      attributes: {
        authorityAcceptanceMutation: phase
      }
    });
    return;
  }
  if (kind === "tenant-missing") {
    consoleAuth.db.prepare(`
      UPDATE console_users
      SET tenant_id = ''
      WHERE user_id = ?
    `).run(owner.user.userId);
    return;
  }
  if (kind === "tenant-change") {
    await consoleAuth.updateUser(owner.user.userId, {
      tenantId: `authority-tenant-${phase}`
    });
    return;
  }
  if (kind === "session-rotation") {
    const rotated: any = consoleAuth.rotateSession(request);
    if (rotated.ok !== true) {
      throw new Error("The real console session could not be rotated.");
    }
    return;
  }
  if (kind === "session-revocation") {
    const revoked: any = consoleAuth.revokeSession(
      consoleAuth.getSessionFromRequest(request, { fresh: true })?.sessionId
    );
    if (revoked.ok !== true) {
      throw new Error("The real console session could not be revoked.");
    }
    return;
  }
  if (kind === "governance-policy-change") {
    consoleAuth.authorizationGovernanceStore.upsertTeam({
      teamId: `authority-policy-${phase}`,
      label: `Authority policy ${phase}`
    });
    return;
  }
  if (kind === "approval-binding-change") {
    delete request.headers["x-meshrix-safety-confirm"];
    return;
  }
  if (kind === "risk-binding-change") {
    const originalSafety: any = operation.safety;
    cleanupTasks.push(() : any => {
      operation.safety = originalSafety;
    });
    operation.safety = {
      ...originalSafety,
      requiresConfirmationExplicit:
        originalSafety.requiresConfirmationExplicit !== true
    };
    return;
  }
  throw new Error(`Unknown authority mutation: ${kind}`);
}

function gatewayController({
  beforeConsoleExecution = null,
  downstreamInputTransform = null,
  events,
  handlerGate = null,
  permits,
  registry,
  transport = "http"
}: Record<string, any>) : any {
  const sendConsoleDomainOperation: any = async ({
    context,
    input,
    operationId,
    response
  }: Record<string, any>) : Promise<any> => {
    permits.push(context.finalProtectedSinkPermit);
    if (beforeConsoleExecution) {
      await beforeConsoleExecution({
        context,
        input,
        operationId
      });
    }
    if (handlerGate) await handlerGate.promise;
    const downstreamInput: any = downstreamInputTransform
      ? downstreamInputTransform(input, operationId)
      : input;
    const operationResult: any = await executeConsoleDomainOperation({
      operationId,
      input: downstreamInput,
      context: {
        ...context,
        transport,
        upstreamGatewayRegistry: registry
      }
    });
    response.writeHead(operationResult.status || 200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(operationResult.payload));
  };
  const handlers: any = createSystemControllerFoundationHandlers({
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
  });
  const handle: any = handlers.handleUpstreamGatewayOperation;
  handlers.handleUpstreamGatewayOperation = async (call?: any) : Promise<any> => {
    events.push("handler-entry");
    return handle(call);
  };
  return { system: handlers };
}

function startDispatch({
  downstreamInputTransform = null,
  events,
  executionAuthorityOmission = "",
  finalGate = null,
  finalAuthorityOmission = "",
  finalState = { allowed: true, revoked: false },
  handlerGate = null,
  includeTargetSelector = true,
  inputOverrides = {},
  operationContract = null,
  operationKey,
  permits,
  registry,
  signal = null
}: Record<string, any>) : any {
  const operation: any = operationContract || SERVER_API_OPERATIONS.find(
    (candidate?: any) : any => candidate.id === "gateway.forward"
  );
  if (!operation) throw new Error("gateway.forward operation is unavailable.");
  const response: any = createResponse();
  const authorizeOperation: any = vi.fn(async () : Promise<any> => ({
    ...authorizationResult(),
    session: AUTH_SESSION
  }));
  const revalidateAuthorization: any = vi.fn(async ({ phase, signal: currentSignal }: Record<string, any> = {}) : Promise<any> => {
    events.push(`revalidate:${phase || "unknown"}`);
    if (phase === "final-protected-sink") {
      events.push("final-protected-sink-revalidate");
      if (finalGate) await finalGate.promise;
      if (currentSignal?.aborted) {
        return authorizationResult({ allowed: false });
      }
      return authorizationResult({
        ...finalState,
        authorityOmission: finalAuthorityOmission
      });
    }
    return authorizationResult({
      authorityOmission: executionAuthorityOmission
    });
  });
  const input: Record<string, any> = {
    body: {
      message: `${operationKey}-request`
    },
    ...(includeTargetSelector
      ? {
          operationKey,
          serviceId: SERVICE_ID
        }
      : {}),
    ...inputOverrides
  };
  const requestBody: any = Buffer.from(JSON.stringify(input));
  const dispatch: any = dispatchOperation({
    actor: AUTH_SESSION.user,
    authorizeOperation,
    controllers: gatewayController({
      downstreamInputTransform,
      events,
      handlerGate,
      permits,
      registry
    }),
    input,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    },
    method: operation.http?.method || "POST",
    operation,
    operationProofSubstrate: proofSubstrate(),
    request: { headers: {} },
    requestBody,
    response,
    revalidateAuthorization,
    signal,
    transport: "http",
    url: new URL(
      `http://127.0.0.1${operation.http?.path || "/api/gateway/v1/forward"}`
    )
  });
  return {
    authorizeOperation,
    dispatch,
    input,
    response,
    revalidateAuthorization
  };
}

function startRealAuthorityDispatch({
  authorityFixture,
  events,
  executionMutation = null,
  finalMutation = null,
  includeOperationKey = true,
  operationKey,
  permits,
  transport
}: Record<string, any>) : any {
  const operation: any = SERVER_API_OPERATIONS.find(
    (candidate?: any) : any => candidate.id === "gateway.forward"
  );
  if (!operation) throw new Error("gateway.forward operation is unavailable.");
  const approvalMutation: any =
    executionMutation === "approval-binding-change" ||
    finalMutation === "approval-binding-change";
  if (approvalMutation) {
    const originalSafety: any = operation.safety;
    cleanupTasks.push(() : any => {
      operation.safety = originalSafety;
    });
    operation.safety = {
      ...originalSafety,
      requiresConfirmation: true,
      requiresConfirmationExplicit: true
    };
  }
  const input: Record<string, any> = {
    body: {
      message: `${operationKey || "missing-operation"}-request`
    },
    ...(includeOperationKey ? { operationKey } : {}),
    serviceId: SERVICE_ID
  };
  const response: any = createResponse();
  const request: any = consoleRequest({
    cookie: authorityFixture.sessionCookie,
    csrf: authorityFixture.csrfToken,
    url: transport === "rpc"
      ? "/api/rpc"
      : operation.http.path
  });
  if (approvalMutation) {
    request.headers["x-meshrix-safety-confirm"] = "true";
  }
  const mutate: any = async (phase?: any, kind?: any) : Promise<any> => {
    if (!kind) return;
    events.push(`authority-mutated:${phase}:${kind}`);
    await mutateRealAuthority({
      consoleAuth: authorityFixture.consoleAuth,
      kind,
      operation,
      owner: authorityFixture.owner,
      phase,
      request
    });
  };
  const controllers: any = gatewayController({
    beforeConsoleExecution: finalMutation
      ? () : any => mutate("final-protected-sink", finalMutation)
      : null,
    events,
    permits,
    registry: authorityFixture.registry,
    transport
  });
  const operationProofSubstrate: any = proofSubstrate({
    afterBeginLifecycle: executionMutation
      ? () : any => mutate("execution", executionMutation)
      : null
  });
  const common: Record<string, any> = {
    authorizeOperation: authorityFixture.securityPermissions.authorizeOperation,
    controllers,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    },
    operationProofSubstrate,
    request,
    response
  };
  const dispatch: any = transport === "rpc"
    ? dispatchRpcOperation({
        ...common,
        operations: SERVER_API_OPERATIONS,
        requestBody: Buffer.from(JSON.stringify({
          jsonrpc: "2.0",
          id: `authority-${operationKey || "missing"}`,
          method: operation.rpc.method,
          params: input
        }))
      })
    : dispatchRegisteredHttpOperation({
        ...common,
        method: operation.http.method,
        operations: SERVER_API_OPERATIONS,
        requestBody: Buffer.from(JSON.stringify(input)),
        url: new URL(`http://console.local${operation.http.path}`)
      });
  return {
    authorizeOperation: authorityFixture.securityPermissions.authorizeOperation,
    dispatch,
    input,
    operation,
    request,
    response,
    transport
  };
}

async function expectDispatchDenied(started?: any) : Promise<any> {
  const [settled] = await Promise.allSettled([started.dispatch]);
  if (settled.status === "fulfilled") {
    expect(started.response.statusCode).toBeGreaterThanOrEqual(400);
  } else {
    expect(settled.reason).toBeInstanceOf(Error);
  }
}

async function expectRealDispatchDenied(started?: any) : Promise<any> {
  const [settled] = await Promise.allSettled([started.dispatch]);
  if (settled.status === "rejected") {
    expect(settled.reason).toBeInstanceOf(Error);
    return;
  }
  if (started.transport === "rpc") {
    expect(started.response.statusCode).toBe(200);
    expect(started.response.json()).toHaveProperty("error");
    return;
  }
  expect(started.response.statusCode).toBeGreaterThanOrEqual(400);
}

function expectOrdered(events?: any, expected?: any) : any {
  let cursor: any = -1;
  for (const marker of expected) {
    const next: any = events.indexOf(marker, cursor + 1);
    expect(next, `missing ordered event ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()();
  }
});

describe("governed upstream final-effect permit wiring", () : any => {
  it.each([
    ["http", "http-write", "/http-write", null],
    ["rpc", "rpc-write", "/rpc-write", "fixture.write"]
  ])(
    "uses the real console authority chain for registered %s gateway.forward",
    async (transport?: any, operationKey?: any, expectedPath?: any, expectedRpcMethod?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer(
        `real-authority-${transport}`,
        events
      );
      const authorityFixture: any = await createRealConsoleAuthorityFixture(
        events,
        peer.baseUrl
      );
      const started: any = startRealAuthorityDispatch({
        authorityFixture,
        events,
        operationKey,
        permits,
        transport
      });

      await started.dispatch;

      expect(started.authorizeOperation).toBe(
        authorityFixture.securityPermissions.authorizeOperation
      );
      expect(started.response.statusCode).toBe(200);
      if (transport === "rpc") {
        expect(started.response.json()).toHaveProperty("result");
      }
      expect(permits).toHaveLength(1);
      expect(permits[0]).toBeTruthy();
      expect(authorityFixture.credentialReads).toHaveBeenCalledTimes(1);
      const authorizationDecisions: any =
        authorityFixture.consoleAuth.authorizationStore.listDecisions({
          limit: 10,
          operationId: "gateway.forward"
        });
      expect(authorizationDecisions).toHaveLength(3);
      expect(new Set<any>(
        authorizationDecisions.map((decision?: any) : any => decision.decisionId)
      ).size).toBe(3);
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0].pathname).toBe(expectedPath);
      if (expectedRpcMethod) {
        expect(peer.requests[0].body).toMatchObject({
          jsonrpc: "2.0",
          method: expectedRpcMethod
        });
      }
      expectOrdered(events, [
        "handler-entry",
        "credential-read",
        `network-request:real-authority-${transport}`
      ]);
    }
  );

  it.each(
    ["http", "rpc"].flatMap((transport?: any) : any => [
      [transport, "missing", false, "http-write"],
      [transport, "empty", true, ""]
    ])
  )(
    "rejects registered %s gateway.forward with %s operationKey at admission",
    async (transport?: any, _condition?: any, includeOperationKey?: any, operationKey?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer(
        `missing-operation-key-${transport}`,
        events
      );
      const authorityFixture: any = await createRealConsoleAuthorityFixture(
        events,
        peer.baseUrl
      );
      const started: any = startRealAuthorityDispatch({
        authorityFixture,
        events,
        includeOperationKey,
        operationKey,
        permits,
        transport
      });

      await started.dispatch;

      expect(started.response.statusCode).toBe(
        transport === "rpc" ? 200 : 400
      );
      if (transport === "rpc") {
        expect(started.response.json()).toMatchObject({
          error: {
            code: 400
          }
        });
      }
      expect(events).not.toContain("handler-entry");
      expect(permits).toHaveLength(0);
      expect(
        authorityFixture.consoleAuth.authorizationStore.listDecisions({
          limit: 10,
          operationId: "gateway.forward"
        })
      ).toHaveLength(0);
      expect(authorityFixture.credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
    }
  );

  it.each(
    ["execution", "final-protected-sink"].flatMap((phase?: any) : any =>
      REAL_AUTHORITY_MUTATIONS.map(([label, mutation]: any[]) : any => [
        phase,
        label,
        mutation
      ])
    )
  )(
    "fails closed at %s when real authority fact %s",
    async (phase?: any, _label?: any, mutation?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer(
        `real-authority-drift-${phase}-${mutation}`,
        events
      );
      const authorityFixture: any = await createRealConsoleAuthorityFixture(
        events,
        peer.baseUrl
      );
      const started: any = startRealAuthorityDispatch({
        authorityFixture,
        events,
        executionMutation: phase === "execution" ? mutation : null,
        finalMutation:
          phase === "final-protected-sink" ? mutation : null,
        operationKey: "http-write",
        permits,
        transport: "http"
      });

      await expectRealDispatchDenied(started);

      expect(events).toContain(`authority-mutated:${phase}:${mutation}`);
      if (phase === "execution") {
        expect(events).not.toContain("handler-entry");
        expect(permits).toHaveLength(0);
      } else {
        expect(events).toContain("handler-entry");
        expect(permits).toHaveLength(1);
      }
      expect(authorityFixture.credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
    }
  );

  it.each(["execution", "final-protected-sink"])(
    "keeps no-consoleAuth %s fallback authority-free and fail-closed",
    async (phase?: any) : Promise<any> => {
      const operation: any = SERVER_API_OPERATIONS.find(
        (candidate?: any) : any => candidate.id === "gateway.forward"
      );
      if (!operation) throw new Error("gateway.forward operation is unavailable.");
      const completeLookingAuthority: any =
        protectedSinkAuthorityWithOmission();
      const completeLookingSession: Record<string, any> = {
        ...AUTH_SESSION,
        authorizationDecision: {
          allowed: true,
          decisionId: "unrelated-session-decision"
        },
        protectedSinkAuthority: completeLookingAuthority,
        user: {
          ...AUTH_SESSION.user,
          approvalRevision: AUTHORITY_CONTEXT.approvalRevision,
          grantRevision: AUTHORITY_CONTEXT.grantRevision,
          policyRevision: AUTHORITY_CONTEXT.policyRevision,
          riskRevision: AUTHORITY_CONTEXT.riskRevision,
          workloadGeneration: AUTHORITY_CONTEXT.workloadGeneration
        }
      };
      const provider: any = createSecurityPermissionsProvider({
        authorizationEngine: createAuthorizationEngine()
      });

      const result: any = await provider.authorizeOperation({
        authSession: completeLookingSession,
        context: {
          authorizationDecision: completeLookingSession.authorizationDecision,
          protectedSinkAuthority: completeLookingAuthority
        },
        input: {
          body: { message: "must-not-authorize-from-lookalike-facts" },
          operationKey: "http-write",
          protectedSinkAuthority: completeLookingAuthority,
          serviceId: SERVICE_ID
        },
        method: "POST",
        operation,
        phase,
        request: consoleRequest(),
        transport: "http",
        url: new URL("http://console.local/api/gateway/v1/forward")
      });

      expect(result).toMatchObject({
        ok: false,
        reasonCode: "protected_sink_authority_source_unavailable",
        status: 503,
        authorizationDecision: {
          allowed: true
        }
      });
      expect(result.authorizationDecision.decisionId).toEqual(expect.any(String));
      expect(result.authorizationDecision.decisionId).not.toBe("");
      expect(result).not.toHaveProperty("protectedSinkAuthority");
    }
  );

  it.each([
    ["http-write", "/http-write", null],
    ["rpc-write", "/rpc-write", "fixture.write"]
  ])(
    "consumes once at the real %s credential/network boundary",
    async (operationKey?: any, expectedPath?: any, expectedRpcMethod?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer(operationKey, events);
      const { credentialReads, registry } =
        await createCredentialBoundRegistry(events, peer.baseUrl);

      const started: any = startDispatch({
        events,
        operationKey,
        permits,
        registry
      });
      await expect(started.dispatch).resolves.toMatchObject({
        ok: true,
        statusCode: 200
      });

      expect(started.response.statusCode).toBe(200);
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0].pathname).toBe(expectedPath);
      if (expectedRpcMethod) {
        expect(peer.requests[0].body).toMatchObject({
          jsonrpc: "2.0",
          method: expectedRpcMethod
        });
      }
      expect(permits).toHaveLength(1);
      expect(permits[0]).toBeTruthy();
      expect(credentialReads).toHaveBeenCalledTimes(1);
      expect(
        started.revalidateAuthorization.mock.calls.filter(
          ([call]: any[]) : any => call?.phase === "final-protected-sink"
        )
      ).toHaveLength(1);
      expectOrdered(events, [
        "revalidate:execution",
        "handler-entry",
        "final-protected-sink-revalidate",
        "credential-read",
        `network-request:${operationKey}`
      ]);
    }
  );

  it("carries the opaque attempt through the projected-operation executor branch", async () : Promise<any> => {
    const events: any[] = [];
    const permits: any[] = [];
    const peer: any = await startUpstreamPeer("projected-http", events);
    const { credentialReads, registry } =
      await createCredentialBoundRegistry(events, peer.baseUrl);
    const operationContract: any = projectedOperationFor(registry, "http-write");

    const started: any = startDispatch({
      events,
      includeTargetSelector: false,
      operationContract,
      operationKey: "http-write",
      permits,
      registry
    });
    await expect(started.dispatch).resolves.toMatchObject({
      ok: true,
      statusCode: 200
    });

    expect(peer.requests).toHaveLength(1);
    expect(peer.requests[0]).toMatchObject({
      method: "POST",
      pathname: "/http-write"
    });
    expect(permits).toHaveLength(1);
    expect(credentialReads).toHaveBeenCalledTimes(1);
    expect(
      started.revalidateAuthorization.mock.calls.filter(
        ([call]: any[]) : any => call?.phase === "final-protected-sink"
      )
    ).toHaveLength(1);
    expectOrdered(events, [
      "revalidate:execution",
      "handler-entry",
      "final-protected-sink-revalidate",
      "credential-read",
      "network-request:projected-http"
    ]);
  });

  it("rejects a missing sink permit before credential resolution or network", async () : Promise<any> => {
    const events: any[] = [];
    const peer: any = await startUpstreamPeer("missing", events);
    const { credentialReads, registry } =
      await createCredentialBoundRegistry(events, peer.baseUrl);

    await expect(registry.forward(
      {
        body: { message: "missing-permit-request" },
        operationKey: "http-write",
        serviceId: SERVICE_ID
      },
      SUBJECT_WITH_SCOPES
    )).rejects.toMatchObject({
      code: "upstream_final_effect_authority_required",
      statusCode: 403
    });

    expect(credentialReads).not.toHaveBeenCalled();
    expect(peer.requests).toHaveLength(0);
  });

  it.each(
    ["execution", "final-protected-sink"].flatMap((phase?: any) : any =>
      PROTECTED_SINK_AUTHORITY_OMISSIONS.map((omission?: any) : any => [phase, omission])
    )
  )(
    "fails closed when %s revalidation omits exact authority fact %s",
    async (phase?: any, authorityOmission?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer(
        `missing-authority-${phase}-${authorityOmission}`,
        events
      );
      const { credentialReads, registry } =
        await createCredentialBoundRegistry(events, peer.baseUrl);
      const started: any = startDispatch({
        events,
        executionAuthorityOmission:
          phase === "execution" ? authorityOmission : "",
        finalAuthorityOmission:
          phase === "final-protected-sink" ? authorityOmission : "",
        operationKey: "http-write",
        permits,
        registry
      });

      await expectDispatchDenied(started);

      expect(credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
      if (phase === "execution") {
        expect(events).not.toContain("handler-entry");
        expect(permits).toHaveLength(0);
        expect(
          started.revalidateAuthorization.mock.calls.filter(
            ([call]: any[]) : any => call?.phase === "final-protected-sink"
          )
        ).toHaveLength(0);
      } else {
        expect(events).toContain("handler-entry");
        expect(events).toContain("final-protected-sink-revalidate");
        expect(permits).toHaveLength(1);
        await expect(registry.forward(
          started.input,
          SUBJECT_WITH_SCOPES,
          { finalProtectedSinkPermit: permits[0] }
        )).rejects.toMatchObject({
          code: "governed_execution_permit_unknown_or_replayed"
        });
        expect(credentialReads).not.toHaveBeenCalled();
        expect(peer.requests).toHaveLength(0);
      }
    }
  );

  it.each([
    ["denial", { allowed: false, revoked: false }],
    ["revocation", { allowed: false, revoked: true }]
  ])(
    "burns the sink permit on current %s with zero protected effect",
    async (_label?: any, finalState?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer("denied", events);
      const { credentialReads, registry } =
        await createCredentialBoundRegistry(events, peer.baseUrl);
      const started: any = startDispatch({
        events,
        finalState,
        operationKey: "http-write",
        permits,
        registry
      });

      await expectDispatchDenied(started);

      expect(events).toContain("handler-entry");
      expect(events).toContain("final-protected-sink-revalidate");
      expect(permits).toHaveLength(1);
      expect(permits[0]).toBeTruthy();
      expect(credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
      await expect(registry.forward(
        started.input,
        SUBJECT_WITH_SCOPES,
        { finalProtectedSinkPermit: permits[0] }
      )).rejects.toMatchObject({
        code: "governed_execution_permit_unknown_or_replayed"
      });
      expect(credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
    }
  );

  it("burns an aborted waiter before credential resolution or a request byte", async () : Promise<any> => {
    const events: any[] = [];
    const permits: any[] = [];
    const gate: any = deferred();
    const controller: any = new AbortController();
    const peer: any = await startUpstreamPeer("cancelled", events);
    const { credentialReads, registry } =
      await createCredentialBoundRegistry(events, peer.baseUrl);
    const started: any = startDispatch({
      events,
      finalGate: gate,
      operationKey: "http-write",
      permits,
      registry,
      signal: controller.signal
    });
    await vi.waitFor(() : any => {
      expect(events).toContain("final-protected-sink-revalidate");
    });

    controller.abort();
    gate.resolve();
    await expectDispatchDenied(started);

    expect(permits).toHaveLength(1);
    expect(credentialReads).not.toHaveBeenCalled();
    expect(peer.requests).toHaveLength(0);
    await expect(registry.forward(
      started.input,
      SUBJECT_WITH_SCOPES,
      { finalProtectedSinkPermit: permits[0] }
    )).rejects.toMatchObject({
      code: "governed_execution_permit_unknown_or_replayed"
    });
    expect(credentialReads).not.toHaveBeenCalled();
    expect(peer.requests).toHaveLength(0);
  });

  it("burns an attempt when its handler target is substituted before the sink", async () : Promise<any> => {
    const events: any[] = [];
    const permits: any[] = [];
    const handlerGate: any = deferred();
    const peer: any = await startUpstreamPeer("operation-substitution", events);
    const { credentialReads, registry } =
      await createCredentialBoundRegistry(events, peer.baseUrl);
    const started: any = startDispatch({
      events,
      handlerGate,
      operationKey: "http-write",
      permits,
      registry
    });
    await vi.waitFor(() : any => {
      expect(events).toContain("handler-entry");
      expect(permits).toHaveLength(1);
    });

    const [substituted] = await Promise.allSettled([registry.forward(
      {
        ...started.input,
        operationKey: "rpc-write"
      },
      SUBJECT_WITH_SCOPES,
      { finalProtectedSinkPermit: permits[0] }
    )]);
    handlerGate.resolve();
    await expectDispatchDenied(started);

    expect(substituted.status).toBe("rejected");
    expect(substituted.reason).toMatchObject({ statusCode: 403 });
    expect(credentialReads).not.toHaveBeenCalled();
    expect(peer.requests).toHaveLength(0);
  });

  it.each([
    ["gateway.forward body", false, "http-write"],
    ["projected JSON-RPC params", true, "rpc-write"]
  ])(
    "burns an attempt when downstream replaces %s after dispatch",
    async (_label?: any, projected?: any, operationKey?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const peer: any = await startUpstreamPeer(
        projected ? "projected-input-substitution" : "gateway-input-substitution",
        events
      );
      const { credentialReads, registry } =
        await createCredentialBoundRegistry(events, peer.baseUrl);
      const operationContract: any = projected
        ? projectedOperationFor(registry, operationKey)
        : null;
      const downstreamInputTransform: any = projected
        ? (input?: any) : any => {
            events.push("downstream-input-substituted");
            return {
              ...input,
              rpcParams: {
                message: "substituted-after-dispatch"
              }
            };
          }
        : (input?: any) : any => {
            events.push("downstream-input-substituted");
            return {
              ...input,
              body: {
                message: "substituted-after-dispatch"
              }
            };
          };
      const started: any = startDispatch({
        downstreamInputTransform,
        events,
        includeTargetSelector: !projected,
        inputOverrides: projected
          ? {
              rpcId: "fixed-projected-request",
              rpcParams: {
                message: "authorized-before-dispatch"
              }
            }
          : {},
        operationContract,
        operationKey,
        permits,
        registry
      });

      await expectDispatchDenied(started);

      expect(events).toContain("handler-entry");
      expect(events).toContain("downstream-input-substituted");
      expect(permits).toHaveLength(1);
      expect(credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
      const replay: any = projected
        ? registry.forwardProjectedOperation(
            operationContract.id,
            started.input,
            SUBJECT_WITH_SCOPES,
            { finalProtectedSinkPermit: permits[0] }
          )
        : registry.forward(
            started.input,
            SUBJECT_WITH_SCOPES,
            { finalProtectedSinkPermit: permits[0] }
          );
      await expect(replay).rejects.toMatchObject({
        code: "governed_execution_permit_unknown_or_replayed"
      });
      expect(credentialReads).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
    }
  );

  it.each([
    "endpoint",
    "method",
    "protocol",
    "manifest"
  ])(
    "rejects isolated %s drift and stale retry, then authorizes the current target freshly",
    async (driftKind?: any) : Promise<any> => {
      const events: any[] = [];
      const permits: any[] = [];
      const gate: any = deferred();
      const original: any = await startUpstreamPeer(`original-${driftKind}`, events);
      const replacement: any = await startUpstreamPeer(`replacement-${driftKind}`, events);
      const { credentialReads, registry } =
        await createCredentialBoundRegistry(events, original.baseUrl);
      const originalRawService: any = serviceDescriptor(original.baseUrl);
      const originalIdentity: Record<string, any> = {
        manifestDigest: fingerprint(originalRawService),
        serviceRevision: 1,
        setDigest: fingerprint({ revision: 1, rawService: originalRawService })
      };
      const stale: any = startDispatch({
        events,
        finalGate: gate,
        operationKey: "http-write",
        permits,
        registry
      });
      await vi.waitFor(() : any => {
        expect(events).toContain("final-protected-sink-revalidate");
      });

      let nextBaseUrl: any = original.baseUrl;
      let nextRawService: any = originalRawService;
      let nextIdentity: any = originalIdentity;
      if (driftKind === "endpoint") {
        nextBaseUrl = replacement.baseUrl;
        nextRawService = serviceDescriptor(nextBaseUrl);
      } else if (driftKind === "method") {
        nextRawService = serviceDescriptor(nextBaseUrl, { httpMethod: "PUT" });
      } else if (driftKind === "protocol") {
        nextRawService = serviceDescriptor(nextBaseUrl, {
          httpProtocol: "json-rpc",
          httpRpcMethod: "fixture.rebound"
        });
      } else {
        nextIdentity = {
          manifestDigest: fingerprint({
            identity: "replacement-manifest",
            rawService: originalRawService
          }),
          serviceRevision: 1,
          setDigest: fingerprint({
            identity: "replacement-set",
            rawService: originalRawService
          })
        };
      }
      installService(registry, nextBaseUrl, 1, {
        rawService: nextRawService,
        ...nextIdentity
      });
      gate.resolve();
      await expectDispatchDenied(stale);

      expect(permits).toHaveLength(1);
      expect(credentialReads).not.toHaveBeenCalled();
      expect(original.requests).toHaveLength(0);
      expect(replacement.requests).toHaveLength(0);
      await expect(registry.forward(
        stale.input,
        SUBJECT_WITH_SCOPES,
        { finalProtectedSinkPermit: permits[0] }
      )).rejects.toMatchObject({
        code: "governed_execution_permit_unknown_or_replayed"
      });
      expect(credentialReads).not.toHaveBeenCalled();
      expect(original.requests).toHaveLength(0);
      expect(replacement.requests).toHaveLength(0);

      const fresh: any = startDispatch({
        events,
        operationKey: "http-write",
        permits,
        registry
      });
      await expect(fresh.dispatch).resolves.toMatchObject({
        ok: true,
        statusCode: 200
      });
      expect(fresh.authorizeOperation).toHaveBeenCalledTimes(1);
      expect(
        fresh.revalidateAuthorization.mock.calls.filter(
          ([call]: any[]) : any => call?.phase === "final-protected-sink"
        )
      ).toHaveLength(1);
      expect(credentialReads).toHaveBeenCalledTimes(1);
      const expectedPeer: any = driftKind === "endpoint" ? replacement : original;
      const otherPeer: any = driftKind === "endpoint" ? original : replacement;
      expect(expectedPeer.requests).toHaveLength(1);
      expect(otherPeer.requests).toHaveLength(0);
      if (driftKind === "method") {
        expect(expectedPeer.requests[0].method).toBe("PUT");
      }
      if (driftKind === "protocol") {
        expect(expectedPeer.requests[0].body).toMatchObject({
          jsonrpc: "2.0",
          method: "fixture.rebound"
        });
      }
    }
  );

  it("rejects a blind retry after success while a fresh dispatch reauthorizes", async () : Promise<any> => {
    const events: any[] = [];
    const permits: any[] = [];
    const peer: any = await startUpstreamPeer("retry", events);
    const { credentialReads, registry } =
      await createCredentialBoundRegistry(events, peer.baseUrl);
    const first: any = startDispatch({
      events,
      operationKey: "http-write",
      permits,
      registry
    });
    await expect(first.dispatch).resolves.toMatchObject({
      ok: true,
      statusCode: 200
    });
    expect(peer.requests).toHaveLength(1);
    expect(credentialReads).toHaveBeenCalledTimes(1);

    await expect(registry.forward(
      first.input,
      SUBJECT_WITH_SCOPES,
      { finalProtectedSinkPermit: permits[0] }
    )).rejects.toMatchObject({
      code: "governed_execution_permit_unknown_or_replayed"
    });
    expect(peer.requests).toHaveLength(1);
    expect(credentialReads).toHaveBeenCalledTimes(1);

    const fresh: any = startDispatch({
      events,
      operationKey: "http-write",
      permits,
      registry
    });
    await expect(fresh.dispatch).resolves.toMatchObject({
      ok: true,
      statusCode: 200
    });
    expect(fresh.authorizeOperation).toHaveBeenCalledTimes(1);
    expect(peer.requests).toHaveLength(2);
    expect(credentialReads).toHaveBeenCalledTimes(2);
  });
});
