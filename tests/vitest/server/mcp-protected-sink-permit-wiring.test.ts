import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createUpstreamGatewayRegistry } from "#meshrix/agents/upstream-gateway/index";
import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { MemoryLockManager } from "#meshrix/foundation/concurrency/lock-manager";
import {
  createMemoryLocalSecretKeyProvider
} from "#meshrix/foundation/security/secrets/local-secret-key-provider";
import {
  initializeLocalSecret,
  rotateLocalSecret
} from "#meshrix/foundation/security/secrets/local-secret-store";
import {
  createSystemControllerFoundationHandlers
} from "#meshrix/protocols/http/controllers/system-controller-foundation-handlers";
import {
  createUpstreamMcpSessionManager
} from "#meshrix/protocols/mcp/upstream-mcp-client";
import {
  bindOperationDispatcher
} from "#meshrix/server-runtime/composition/dispatch-operation";
import {
  executeConsoleDomainOperation
} from "#meshrix/server-runtime/composition/console-domain/operation-executor";
import {
  createOperationPermissionPlatform
} from "../../../packages/capabilities/src/operation-permission-core/index.ts";
import {
  fingerprint
} from "../../../packages/agents/src/upstream-gateway/manifest-compiler.ts";
import {
  normalizeService
} from "../../../packages/agents/src/upstream-gateway/support.ts";

const HTTP_SERVICE_ID: any = "mcp-http-final-effect-fixture";
const STDIO_SERVICE_ID: any = "mcp-stdio-final-effect-fixture";
const HTTP_SECRET_REF: any = "secret://mcp-final-effect/http";
const STDIO_SECRET_REF: any = "secret://mcp-final-effect/stdio";
const LAUNCH_PROFILE_ID: any = "fixture-pinned-node-child";
const PRIVATE_CREDENTIAL_MARKER: any = "synthetic-private-mcp-credential";
const PRIVATE_ARGUMENT_MARKER: any = "synthetic-private-upload-argument";
const PRIVATE_CODE_MARKER: any = "synthetic-upload-code-marker";
const MCP_PATH: any = "/mcp";
const cleanupTasks: any[] = [];

function trackCleanup(task?: any) : any {
  cleanupTasks.push(task);
}

afterEach(async () : Promise<any> => {
  while (cleanupTasks.length > 0) {
    const cleanup: any = cleanupTasks.pop();
    await Promise.resolve().then(cleanup).catch(() : any => undefined);
  }
});

async function temporaryRoot(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  trackCleanup(() : any => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fileDigest(filePath?: any) : Promise<any> {
  const hash: any = createHash("sha256");
  const handle: any = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function deferred() : any {
  let resolve: any;
  const promise: any = new Promise((settle?: any) : any => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate?: any, message?: any, timeoutMs: any = 3_000) : Promise<any> {
  const startedAt: any = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value: any = await predicate();
    if (value) return value;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function readEventLedger(filePath?: any) : Promise<any> {
  let raw: any = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line?: any) : any => JSON.parse(line));
}

async function waitForChildMethod(eventFile?: any, method?: any, count: any = 1) : Promise<any> {
  return waitFor(async () : Promise<any> => {
    const events: any = await readEventLedger(eventFile);
    return events.filter(
      (event?: any) : any => event.kind === "stdin" && event.method === method
    ).length >= count
      ? events
      : null;
  }, `Timed out waiting for child method ${method}.`);
}

function harmlessMcpChildSource() : any {
  return String.raw`
import fs from "node:fs";

const eventFile = process.env.MCP_FIXTURE_EVENT_FILE;
const releaseFile = process.env.MCP_FIXTURE_RELEASE_FILE || "";
const holdMethod = process.env.MCP_FIXTURE_HOLD_METHOD || "";
let buffer = "";
let state = 0;
const counts = Object.create(null);

function record(event) {
  fs.appendFileSync(eventFile, JSON.stringify(event) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function waitForRelease(method) {
  if (!releaseFile || holdMethod !== method) return;
  while (!fs.existsSync(releaseFile)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function count(method) {
  counts[method] = Number(counts[method] || 0) + 1;
}

record({
  kind: "spawn",
  argv: process.argv.slice(1),
  descriptorMode: process.env.MCP_FIXTURE_MODE || "",
  credentialPresent:
    process.env.MCP_FIXTURE_TOKEN === "synthetic-private-mcp-credential",
  nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
  loaderPresent: Boolean(
    process.env.LD_PRELOAD ||
      process.env.DYLD_INSERT_LIBRARIES ||
      process.env.DYLD_LIBRARY_PATH
  ),
  serverPrivatePresent: Boolean(process.env.MESHRIX_PRIVATE_SERVER_MARKER)
});

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const method = String(message.method || "client-response");
  count(method);
  record({ kind: "stdin", method, requestId: message.id ?? null });
  await waitForRelease(method);

  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") return;
  if (method === "shutdown") {
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    setTimeout(() => process.exit(0), 0);
    return;
  }
  if (message.id === undefined) return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixed-harmless-fixture", version: "1" }
      }
    });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "fixture.echo", inputSchema: { type: "object" } },
          { name: "fixture.inspect", inputSchema: { type: "object" } },
          { name: "fixture.slow", inputSchema: { type: "object" } },
          { name: "fixture.uncertain", inputSchema: { type: "object" } }
        ]
      }
    });
    return;
  }
  if (method !== "tools/call") return;
  const toolName = String(message.params?.name || "");
  if (toolName === "fixture.uncertain") {
    setTimeout(() => process.exit(17), 0);
    return;
  }
  if (toolName === "fixture.slow") return;
  if (toolName === "fixture.echo") state += 1;
  send({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      structuredContent: {
        state,
        counts,
        argv: process.argv.slice(1),
        descriptorMode: process.env.MCP_FIXTURE_MODE || "",
        credentialPresent:
          process.env.MCP_FIXTURE_TOKEN ===
            "synthetic-private-mcp-credential",
        nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
        loaderPresent: Boolean(
          process.env.LD_PRELOAD ||
            process.env.DYLD_INSERT_LIBRARIES ||
            process.env.DYLD_LIBRARY_PATH
        ),
        serverPrivatePresent:
          Boolean(process.env.MESHRIX_PRIVATE_SERVER_MARKER),
        argumentWasDataOnly:
          typeof message.params?.arguments?.payload === "string"
      }
    }
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/u);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    void handle(JSON.parse(line));
  }
});
`;
}

async function createPinnedLaunchProfile({
  root,
  executableSha256 = null,
  argumentSha256 = null,
  holdMethod = ""
}: Record<string, any> = {}) : Promise<any> {
  const scriptPath: any = path.join(root, "fixed-harmless-mcp-child.ts");
  const eventFile: any = path.join(root, "fixed-harmless-mcp-child.events");
  const releaseFile: any = path.join(root, "fixed-harmless-mcp-child.release");
  await fs.writeFile(scriptPath, harmlessMcpChildSource(), {
    encoding: "utf8",
    mode: 0o400
  });
  const profile: Record<string, any> = {
    profileId: LAUNCH_PROFILE_ID,
    executablePath: process.execPath,
    executableSha256:
      executableSha256 || await fileDigest(process.execPath),
    args: [scriptPath],
    argumentFileDigests: [{
      index: 0,
      sha256: argumentSha256 || await fileDigest(scriptPath)
    }],
    fixedEnvironment: {
      MCP_FIXTURE_EVENT_FILE: eventFile,
      MCP_FIXTURE_RELEASE_FILE: releaseFile,
      ...(holdMethod ? { MCP_FIXTURE_HOLD_METHOD: holdMethod } : {})
    },
    allowedDescriptorEnvironmentNames: ["MCP_FIXTURE_MODE"],
    allowedCredentialEnvironmentNames: ["MCP_FIXTURE_TOKEN"]
  };
  return {
    eventFile,
    profile,
    releaseFile,
    scriptPath
  };
}

function methodOfHttpRequest(request?: any, message?: any) : any {
  if (request.method === "DELETE") return "DELETE";
  return String(message.method || "client-response");
}

async function readJsonBody(request?: any) : Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw: any = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function createHttpMcpPeer() : Promise<any> {
  const requests: any[] = [];
  const activeSessions: any = new Set<any>();
  const heldResponses: any = new Map<any, any>();
  const methodWaiters: any = new Map<any, any>();
  let nextSession: any = 1;
  let missingCallName: any = "";
  let missingDelivered: any = false;
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    const message: any = request.method === "DELETE"
      ? {}
      : await readJsonBody(request);
    const method: any = methodOfHttpRequest(request, message);
    const event: Record<string, any> = {
      method,
      message,
      httpMethod: request.method,
      sessionId: String(request.headers["mcp-session-id"] || ""),
      protocolVersion: String(request.headers["mcp-protocol-version"] || ""),
      headers: {
        accept: String(request.headers.accept || ""),
        authorization: String(request.headers.authorization || ""),
        contentType: String(request.headers["content-type"] || ""),
        cookie: String(request.headers.cookie || ""),
        forwarded: String(request.headers.forwarded || ""),
        fixturePublic: String(request.headers["x-mcp-fixture-public"] || ""),
        fixtureCredential: String(
          request.headers["x-mcp-fixture-credential"] || ""
        ),
        proof: String(request.headers["x-meshrix-proof"] || "")
      }
    };
    requests.push(event);
    const waiter: any = methodWaiters.get(method);
    if (waiter) {
      methodWaiters.delete(method);
      waiter.resolve(event);
    }
    const hold: any = heldResponses.get(method);
    if (hold) {
      heldResponses.delete(method);
      hold.seen.resolve(event);
      await hold.release.promise;
    }

    if (request.method === "DELETE") {
      activeSessions.delete(event.sessionId);
      response.writeHead(204);
      response.end();
      return;
    }
    if (method === "initialize") {
      const sessionId: any = `fixture-session-${nextSession++}`;
      activeSessions.add(sessionId);
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": sessionId
      });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "loopback-fixed-fixture", version: "1" }
        }
      }));
      return;
    }
    if (method === "notifications/initialized" ||
        method === "notifications/cancelled" ||
        method === "client-response") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (!activeSessions.has(event.sessionId)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (
      method === "tools/call" &&
      String(message.params?.name || "") === missingCallName &&
      !missingDelivered
    ) {
      missingDelivered = true;
      activeSessions.delete(event.sessionId);
      response.writeHead(404);
      response.end();
      return;
    }
    if (
      method === "tools/call" &&
      message.params?.name === "fixture.uncertain"
    ) {
      request.socket.destroy();
      return;
    }
    if (
      method === "tools/call" &&
      message.params?.name === "fixture.slow"
    ) {
      request.on("close", () : any => {
        if (!response.writableEnded) response.destroy();
      });
      return;
    }
    const result: any = method === "tools/list"
      ? {
          tools: [
            { name: "fixture.echo", inputSchema: { type: "object" } },
            { name: "fixture.recover", inputSchema: { type: "object" } },
            { name: "fixture.uncertain", inputSchema: { type: "object" } },
            { name: "fixture.slow", inputSchema: { type: "object" } },
            { name: "fixture.server-request", inputSchema: { type: "object" } }
          ]
        }
      : {
          structuredContent: {
            accepted: true,
            toolName: String(message.params?.name || "")
          }
        };
    if (
      method === "tools/call" &&
      message.params?.name === "fixture.server-request"
    ) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store"
      });
      response.write(`data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: `server-ping-${message.id}`,
        method: "ping",
        params: {}
      })}\n\n`);
      response.end(`data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result
      })}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result
    }));
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  trackCleanup(() : any => new Promise((resolve?: any) : any => server.close(resolve)));
  const address: any = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}${MCP_PATH}`,
    holdNext(method?: any) : any {
      const hold: Record<string, any> = {
        seen: deferred(),
        release: deferred()
      };
      heldResponses.set(method, hold);
      return {
        seen: hold.seen.promise,
        release: hold.release.resolve
      };
    },
    waitForMethod(method?: any) : any {
      const existing: any = requests.find((entry?: any) : any => entry.method === method);
      if (existing) return Promise.resolve(existing);
      const waiter: any = deferred();
      methodWaiters.set(method, waiter);
      return waiter.promise;
    },
    waitForMethodCount(method?: any, count?: any) : any {
      return waitFor(() : any => {
        const matches: any = requests.filter((entry?: any) : any => entry.method === method);
        return matches.length >= count ? matches : null;
      }, `Timed out waiting for ${count} HTTP ${method} requests.`);
    },
    returnMissingSessionOnceFor(toolName?: any) : any {
      missingCallName = toolName;
      missingDelivered = false;
    },
    methods() : any {
      return requests.map((entry?: any) : any => entry.method);
    }
  };
}

function createCountedKeyProvider() : any {
  const base: any = createMemoryLocalSecretKeyProvider();
  let readCount: any = 0;
  let hold: any = null;
  const provider: Readonly<Record<string, any>> = Object.freeze({
    protocolVersion: base.protocolVersion,
    custody: base.custody,
    async loadKey() : Promise<any> {
      readCount += 1;
      if (hold) {
        const current: any = hold;
        hold = null;
        current.seen.resolve();
        await current.release.promise;
      }
      return base.loadKey();
    },
    close: () : any => base.close(),
    describe: () : any => base.describe()
  });
  trackCleanup(async () : Promise<any> => {
    provider.close();
  });
  return {
    provider,
    get readCount() : any {
      return readCount;
    },
    resetReadCount() : any {
      readCount = 0;
    },
    holdNextRead() : any {
      const current: Record<string, any> = {
        seen: deferred(),
        release: deferred()
      };
      hold = current;
      return {
        seen: current.seen.promise,
        release: current.release.resolve
      };
    }
  };
}

function replaceRuntimeServices(registry?: any, rawServices?: any, setRevision: any = 1) : any {
  const entries: any = rawServices.map((rawService?: any, index?: any) : any => {
    const normalized: any = normalizeService(rawService, {});
    const service: Readonly<Record<string, any>> = Object.freeze({
      ...normalized,
      manifestDigest: fingerprint(rawService),
      serviceRevision:
        Number(rawService.serviceRevision || 0) || setRevision + index
    });
    return Object.freeze([service.serviceId, service]);
  });
  return registry.replaceFromManifestSnapshot(Object.freeze({
    setRevision,
    setDigest: fingerprint({ setRevision, rawServices }),
    serviceEntries: Object.freeze(entries)
  }), { deferSideEffects: true });
}

function httpService(url?: any, overrides: Record<string, any> = {}) : any {
  const parsed: any = new URL(url);
  return {
    serviceId: HTTP_SERVICE_ID,
    serviceRevision: 1,
    serviceProtocol: "mcp",
    label: "Governed HTTP MCP fixture",
    allowLocalNetwork: true,
    credentialReferences: [{
      type: "secret",
      reference: HTTP_SECRET_REF,
      use: "mcp-http-headers",
      headerNames: ["authorization", "x-mcp-fixture-credential"],
      host: parsed.hostname,
      protocol: parsed.protocol.replace(/:$/u, ""),
      scopes: ["gateway:read", "gateway:write"]
    }],
    mcp: {
      transport: "streamable-http",
      url,
      headers: {
        "x-mcp-fixture-public": "declared-public-value"
      },
      toolNamePrefix: "governed-http",
      timeoutMs: 2_000
    },
    operations: [{
      operationKey: "tools/call",
      protocol: "mcp",
      requiredScopes: ["gateway:write"],
      risk: "safe_write",
      timeoutMs: 2_000
    }],
    ...overrides
  };
}

function stdioService(overrides: Record<string, any> = {}) : any {
  return {
    serviceId: STDIO_SERVICE_ID,
    serviceRevision: 1,
    serviceProtocol: "mcp",
    label: "Governed stdio MCP fixture",
    credentialReferences: [{
      type: "secret",
      reference: STDIO_SECRET_REF,
      use: "mcp-stdio-environment",
      environmentNames: ["MCP_FIXTURE_TOKEN"],
      scopes: ["gateway:read", "gateway:write"]
    }],
    mcp: {
      transport: "stdio",
      launchProfileId: LAUNCH_PROFILE_ID,
      env: {
        MCP_FIXTURE_MODE: "declared-mode"
      },
      toolNamePrefix: "governed-stdio",
      timeoutMs: 2_000
    },
    operations: [{
      operationKey: "tools/call",
      protocol: "mcp",
      requiredScopes: ["gateway:write"],
      risk: "safe_write",
      timeoutMs: 2_000
    }],
    ...overrides
  };
}

async function initializeHttpCredential({
  root,
  keyProvider,
  peerUrl,
  payload = null
}: Record<string, any>) : Promise<any> {
  const target: any = new URL(peerUrl);
  await initializeLocalSecret({
    dataDir: root,
    keyProvider,
    payload: payload || {
      headers: {
        authorization: `Bearer ${PRIVATE_CREDENTIAL_MARKER}`,
        "x-mcp-fixture-credential": PRIVATE_CREDENTIAL_MARKER
      }
    },
    target: {
      authType: "bearer",
      family: "mcp-http-final-effect-fixture",
      provider: "fixture",
      scope: {
        allowedHosts: [target.hostname],
        allowedProtocols: [target.protocol.replace(/:$/u, "")],
        scopes: ["gateway:read", "gateway:write"],
        serviceId: HTTP_SERVICE_ID
      },
      secretRef: HTTP_SECRET_REF
    }
  });
}

async function rotateHttpCredential({
  root,
  keyProvider,
  peerUrl
}: Record<string, any>) : Promise<any> {
  const target: any = new URL(peerUrl);
  await rotateLocalSecret({
    dataDir: root,
    keyProvider,
    expectedRevision: 1,
    payload: {
      headers: {
        authorization: `Bearer ${PRIVATE_CREDENTIAL_MARKER}-rotated`,
        "x-mcp-fixture-credential":
          `${PRIVATE_CREDENTIAL_MARKER}-rotated`
      }
    },
    target: {
      authType: "bearer",
      family: "mcp-http-final-effect-fixture",
      provider: "fixture",
      scope: {
        allowedHosts: [target.hostname],
        allowedProtocols: [target.protocol.replace(/:$/u, "")],
        scopes: ["gateway:read", "gateway:write"],
        serviceId: HTTP_SERVICE_ID
      },
      secretRef: HTTP_SECRET_REF
    }
  });
}

async function initializeStdioCredential({
  root,
  keyProvider,
  payload = null
}: Record<string, any>) : Promise<any> {
  await initializeLocalSecret({
    dataDir: root,
    keyProvider,
    payload: payload || {
      env: {
        MCP_FIXTURE_TOKEN: PRIVATE_CREDENTIAL_MARKER
      }
    },
    target: {
      authType: "environment",
      family: "mcp-stdio-final-effect-fixture",
      provider: "fixture",
      scope: {
        allowedHosts: [],
        allowedProtocols: [],
        scopes: ["gateway:read", "gateway:write"],
        serviceId: STDIO_SERVICE_ID
      },
      secretRef: STDIO_SECRET_REF
    }
  });
}

function createResponseWriter(response?: any) : any {
  return (status?: any, payload?: any) : any => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(payload));
  };
}

function governedGatewayControllers(registry?: any, capturedAuthorities?: any) : any {
  const sendConsoleDomainOperation: any = async ({
    context,
    input,
    operationId,
    response
  }: Record<string, any>) : Promise<any> => {
    capturedAuthorities.push(context.mcpFinalEffectAuthority);
    const operationResult: any = await executeConsoleDomainOperation({
      operationId,
      input,
      context: {
        ...context,
        transport: "operation-permission",
        upstreamGatewayRegistry: registry
      }
    });
    createResponseWriter(response)(
      operationResult.status || 200,
      operationResult.payload
    );
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

function proofSubstrate() : any {
  let nextProof: any = 1;
  return {
    async beginLifecycle() : Promise<any> {
      return { ledgerEventId: `proof:mcp-final-effect:${nextProof++}` };
    },
    async finishLifecycle({ ledgerEventId }: Record<string, any>) : Promise<any> {
      return { ledgerEventId };
    },
    async recordReceipt() : Promise<any> {
      return { ledgerEventId: `proof:mcp-final-effect:${nextProof++}:receipt` };
    }
  };
}

async function createOperationPermissionHarness({
  registry,
  root,
  serviceIds,
  secretRefs
}: Record<string, any>) : Promise<any> {
  const capturedAuthorities: any[] = [];
  const lockManager: any = new MemoryLockManager({
    defaultTtlMs: 5_000,
    maxWaitMs: 5_000
  });
  trackCleanup(() : any => lockManager.destroy());
  const platform: any = createOperationPermissionPlatform({
    userDataPath: root,
    operations: SERVER_API_OPERATIONS,
    operationDispatcher: bindOperationDispatcher({
      lockManager,
      concurrencyScope: "mcp-final-effect-acceptance"
    }),
    operationConcurrencyScope: "mcp-final-effect-acceptance",
    controllers: governedGatewayControllers(registry, capturedAuthorities),
    proofSubstrate: proofSubstrate(),
    protocolEventBus: {
      async publish() : Promise<any> {}
    }
  });
  trackCleanup(async () : Promise<any> => {
    await platform.close();
  });
  const tool: any = platform.registry.getToolByOperationId("gateway.forward");
  if (!tool) throw new Error("gateway.forward Operation Permission tool is absent.");
  const issued: any = await platform.store.createGrant({
    label: "MCP final effect acceptance grant",
    scopes: ["gateway:read", "gateway:write"],
    toolsets: [],
    toolAllow: [tool.id],
    allowedServiceIds: serviceIds,
    allowedSecretBindings: secretRefs,
    reason: "mcp_final_effect_acceptance"
  });
  const request: Record<string, any> = {
    headers: {
      authorization: `Bearer ${issued.token}`,
      "user-agent": "meshrix-mcp-final-effect-acceptance"
    },
    socket: {
      remoteAddress: "127.0.0.1"
    }
  };
  async function execute(input?: any, { signal = null }: Record<string, any> = {}) : Promise<any> {
    const requestBody: any = Buffer.from(JSON.stringify(input));
    return platform.runtime.executeTool({
      toolId: tool.id,
      input,
      request,
      requestBody,
      requestMethod: "POST",
      requestUrl: new URL(
        "/api/gateway/v1/forward",
        "http://127.0.0.1"
      ),
      signal
    });
  }
  return {
    capturedAuthorities,
    execute,
    grant: issued.grant,
    platform,
    request,
    tool
  };
}

async function createHttpHarness({
  peer = null,
  serviceOverrides = {},
  secretPayload = null
}: Record<string, any> = {}) : Promise<any> {
  const root: any = await temporaryRoot("meshrix-mcp-http-final-effect-");
  const targetPeer: any = peer || await createHttpMcpPeer();
  const key: any = createCountedKeyProvider();
  const registry: any = createUpstreamGatewayRegistry({
    userDataPath: root,
    secretKeyProvider: key.provider
  });
  trackCleanup(() : any => registry.close());
  const service: any = httpService(targetPeer.url, serviceOverrides);
  replaceRuntimeServices(registry, [service], 1);
  await initializeHttpCredential({
    root,
    keyProvider: key.provider,
    peerUrl: targetPeer.url,
    payload: secretPayload
  });
  key.resetReadCount();
  const governed: any = await createOperationPermissionHarness({
    registry,
    root,
    serviceIds: [HTTP_SERVICE_ID],
    secretRefs: [HTTP_SECRET_REF]
  });
  return {
    governed,
    key,
    peer: targetPeer,
    registry,
    root,
    service
  };
}

async function createStdioHarness({
  profileOverrides = {},
  serviceOverrides = {},
  secretPayload = null,
  holdMethod = ""
}: Record<string, any> = {}) : Promise<any> {
  const root: any = await temporaryRoot("meshrix-mcp-stdio-final-effect-");
  const profileFixture: any = await createPinnedLaunchProfile({
    root,
    holdMethod,
    ...profileOverrides
  });
  const key: any = createCountedKeyProvider();
  const registry: any = createUpstreamGatewayRegistry({
    userDataPath: root,
    secretKeyProvider: key.provider,
    stdioLaunchProfiles: [profileFixture.profile]
  });
  trackCleanup(() : any => registry.close());
  const service: any = stdioService(serviceOverrides);
  replaceRuntimeServices(registry, [service], 1);
  await initializeStdioCredential({
    root,
    keyProvider: key.provider,
    payload: secretPayload
  });
  key.resetReadCount();
  const governed: any = await createOperationPermissionHarness({
    registry,
    root,
    serviceIds: [STDIO_SERVICE_ID],
    secretRefs: [STDIO_SECRET_REF]
  });
  return {
    governed,
    key,
    profileFixture,
    registry,
    root,
    service
  };
}

function mcpInput({
  serviceId,
  toolName = "fixture.echo",
  arguments: toolArguments = {}
}: Record<string, any>) : any {
  return {
    serviceId,
    operationKey: "tools/call",
    toolName,
    arguments: toolArguments
  };
}

function expectBoundedPrivateSafeFailure(result?: any) : any {
  const serialized: any = JSON.stringify(result);
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(16 * 1024);
  for (const marker of [
    PRIVATE_CREDENTIAL_MARKER,
    PRIVATE_ARGUMENT_MARKER,
    PRIVATE_CODE_MARKER
  ]) {
    expect(serialized).not.toContain(marker);
  }
}

describe("MCP final protected-effect permit wiring", () : any => {
  it("uses fresh Operation Permission authority for a cold and reused real HTTP session", async () : Promise<any> => {
    const fixture: any = await createHttpHarness();
    const first: any = await fixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      arguments: { value: 1 }
    }));

    expect(first).toMatchObject({ ok: true, status: 200 });
    expect(fixture.peer.methods()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call"
    ]);
    expect(fixture.key.readCount).toBe(1);
    expect(fixture.peer.requests[0]).toMatchObject({
      sessionId: "",
      protocolVersion: "",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${PRIVATE_CREDENTIAL_MARKER}`,
        contentType: "application/json",
        fixturePublic: "declared-public-value",
        fixtureCredential: PRIVATE_CREDENTIAL_MARKER,
        cookie: "",
        forwarded: "",
        proof: ""
      }
    });
    expect(fixture.peer.requests[1]).toMatchObject({
      sessionId: "fixture-session-1",
      protocolVersion: "2025-06-18"
    });

    const second: any = await fixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      arguments: { value: 2 }
    }));
    expect(second).toMatchObject({ ok: true, status: 200 });
    expect(fixture.peer.methods()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call"
    ]);
    expect(fixture.key.readCount).toBe(2);
    expect(fixture.governed.capturedAuthorities).toHaveLength(2);
    expect(fixture.governed.capturedAuthorities[0]).toBeTruthy();
    expect(fixture.governed.capturedAuthorities[1]).toBeTruthy();
    expect(fixture.governed.capturedAuthorities[0])
      .not.toBe(fixture.governed.capturedAuthorities[1]);
    expect(JSON.stringify(first)).not.toContain("mcpFinalEffectAuthority");
    expect(JSON.stringify(second)).not.toContain("mcpFinalEffectAuthority");
  });

  it("reauthorizes every known-404 recovery request and stops at revocation", async () : Promise<any> => {
    const successFixture: any = await createHttpHarness();
    await successFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    const successPrefix: any = successFixture.peer.requests.length;
    successFixture.peer.returnMissingSessionOnceFor("fixture.recover");

    const recovered: any = await successFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      toolName: "fixture.recover"
    }));
    expect(recovered).toMatchObject({ ok: true, status: 200 });
    expect(successFixture.peer.methods().slice(successPrefix)).toEqual([
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call"
    ]);
    expect(
      successFixture.peer.requests.slice(successPrefix)
        .filter((entry?: any) : any => entry.method === "tools/call")
    ).toHaveLength(2);

    const revokedFixture: any = await createHttpHarness();
    await revokedFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    revokedFixture.peer.returnMissingSessionOnceFor("fixture.recover");
    const recoveryInitialize: any = revokedFixture.peer.holdNext("initialize");
    const prefix: any = revokedFixture.peer.requests.length;
    const pending: any = revokedFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      toolName: "fixture.recover"
    }));
    await recoveryInitialize.seen;
    await revokedFixture.governed.platform.store.revokeGrant(
      revokedFixture.governed.grant.id,
      "mcp_recovery_revocation"
    );
    recoveryInitialize.release();
    const denied: any = await pending;

    expect(denied.ok).toBe(false);
    expect(revokedFixture.peer.methods().slice(prefix)).toEqual([
      "tools/call",
      "initialize"
    ]);
    expectBoundedPrivateSafeFailure(denied);
  });

  it("denies pre-effect cancellation and post-wait target drift, and never blindly retries an uncertain HTTP effect", async () : Promise<any> => {
    const cancelledFixture: any = await createHttpHarness();
    const cancelledController: any = new AbortController();
    cancelledController.abort("private caller cancellation detail");
    const cancelled: any = await cancelledFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }), { signal: cancelledController.signal });
    expect(cancelled.ok).toBe(false);
    expect(cancelledFixture.key.readCount).toBe(0);
    expect(cancelledFixture.peer.requests).toHaveLength(0);
    expectBoundedPrivateSafeFailure(cancelled);

    const oldPeer: any = await createHttpMcpPeer();
    const replacementPeer: any = await createHttpMcpPeer();
    const driftFixture: any = await createHttpHarness({ peer: oldPeer });
    const heldInitialize: any = oldPeer.holdNext("initialize");
    const pendingDrift: any = driftFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      arguments: { value: "before-drift" }
    }));
    await heldInitialize.seen;
    replaceRuntimeServices(
      driftFixture.registry,
      [httpService(replacementPeer.url, { serviceRevision: 2 })],
      2
    );
    heldInitialize.release();
    const drifted: any = await pendingDrift;
    expect(drifted.ok).toBe(false);
    expect(oldPeer.methods()).toEqual(["initialize"]);
    expect(replacementPeer.requests).toHaveLength(0);
    expectBoundedPrivateSafeFailure(drifted);

    const credentialDriftFixture: any = await createHttpHarness();
    const heldCredentialInitialize: any =
      credentialDriftFixture.peer.holdNext("initialize");
    const pendingCredentialDrift: any =
      credentialDriftFixture.governed.execute(mcpInput({
        serviceId: HTTP_SERVICE_ID,
        arguments: { value: "before-credential-drift" }
      }));
    await heldCredentialInitialize.seen;
    await rotateHttpCredential({
      root: credentialDriftFixture.root,
      keyProvider: credentialDriftFixture.key.provider,
      peerUrl: credentialDriftFixture.peer.url
    });
    heldCredentialInitialize.release();
    const credentialDrifted: any = await pendingCredentialDrift;
    expect(credentialDrifted.ok).toBe(false);
    expect(credentialDriftFixture.peer.methods()).toEqual(["initialize"]);
    expectBoundedPrivateSafeFailure(credentialDrifted);

    const uncertainFixture: any = await createHttpHarness();
    await uncertainFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    const prefix: any = uncertainFixture.peer.requests.length;
    const uncertain: any = await uncertainFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      toolName: "fixture.uncertain"
    }));
    expect(uncertain.ok).toBe(false);
    expect(
      uncertainFixture.peer.requests.slice(prefix)
        .filter((entry?: any) : any =>
          entry.method === "tools/call" &&
          entry.message.params?.name === "fixture.uncertain"
        )
    ).toHaveLength(1);
    expectBoundedPrivateSafeFailure(uncertain);

    const cancellationFixture: any = await createHttpHarness();
    await cancellationFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    const cancellationPrefix: any = cancellationFixture.peer.requests.length;
    const cancellationController: any = new AbortController();
    const slow: any = cancellationFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      toolName: "fixture.slow"
    }), { signal: cancellationController.signal });
    await cancellationFixture.peer.waitForMethodCount("tools/call", 2);
    cancellationController.abort("private caller cancellation detail");
    const cancelledInFlight: any = await slow;
    expect(cancelledInFlight.ok).toBe(false);
    await cancellationFixture.peer.waitForMethodCount(
      "notifications/cancelled",
      1
    );
    expect(cancellationFixture.peer.methods().slice(cancellationPrefix))
      .toEqual(["tools/call", "notifications/cancelled"]);
    expectBoundedPrivateSafeFailure(cancelledInFlight);

    const cancelledAfterRevocation: any = await createHttpHarness();
    await cancelledAfterRevocation.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    const revokedCancellationPrefix: any =
      cancelledAfterRevocation.peer.requests.length;
    const revokedCancellationController: any = new AbortController();
    const revokedSlow: any = cancelledAfterRevocation.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      toolName: "fixture.slow"
    }), { signal: revokedCancellationController.signal });
    await cancelledAfterRevocation.peer.waitForMethodCount("tools/call", 2);
    await cancelledAfterRevocation.governed.platform.store.revokeGrant(
      cancelledAfterRevocation.governed.grant.id,
      "mcp_cancellation_revocation"
    );
    revokedCancellationController.abort("private caller cancellation detail");
    const revokedCancellation: any = await revokedSlow;
    expect(revokedCancellation.ok).toBe(false);
    await new Promise((resolve?: any) : any => setTimeout(resolve, 50));
    expect(
      cancelledAfterRevocation.peer.methods()
        .slice(revokedCancellationPrefix)
    ).toEqual(["tools/call"]);
    expectBoundedPrivateSafeFailure(revokedCancellation);

    const serverResponseFixture: any = await createHttpHarness();
    await serverResponseFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    const heldServerRequest: any = serverResponseFixture.peer.holdNext("tools/call");
    const serverResponsePrefix: any = serverResponseFixture.peer.requests.length;
    const pendingServerRequest: any = serverResponseFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID,
      toolName: "fixture.server-request"
    }));
    await heldServerRequest.seen;
    await serverResponseFixture.governed.platform.store.revokeGrant(
      serverResponseFixture.governed.grant.id,
      "mcp_server_response_revocation"
    );
    heldServerRequest.release();
    const serverResponseDenied: any = await pendingServerRequest;
    expect(serverResponseDenied.ok).toBe(false);
    expect(serverResponseFixture.peer.methods().slice(serverResponsePrefix))
      .toEqual(["tools/call"]);
    expectBoundedPrivateSafeFailure(serverResponseDenied);

    await uncertainFixture.registry.close();
    expect(uncertainFixture.peer.methods()).not.toContain("DELETE");
  });

  it("uses one fixed real stdio child while every dispatch and pipe write gets fresh authority", async () : Promise<any> => {
    const fixture: any = await createStdioHarness();
    const first: any = await fixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID,
      arguments: {
        payload: PRIVATE_ARGUMENT_MARKER
      }
    }));
    expect(first).toMatchObject({ ok: true, status: 200 });
    let events: any = await readEventLedger(fixture.profileFixture.eventFile);
    expect(events.filter((event?: any) : any => event.kind === "spawn")).toHaveLength(1);
    expect(
      events.filter((event?: any) : any => event.kind === "stdin")
        .map((event?: any) : any => event.method)
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call"
    ]);
    expect(events[0]).toMatchObject({
      kind: "spawn",
      argv: [fixture.profileFixture.scriptPath],
      descriptorMode: "declared-mode",
      credentialPresent: true,
      nodeOptionsPresent: false,
      loaderPresent: false,
      serverPrivatePresent: false
    });
    expect(fixture.key.readCount).toBe(1);

    const second: any = await fixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID,
      arguments: { payload: "second-dispatch" }
    }));
    expect(second).toMatchObject({ ok: true, status: 200 });
    events = await readEventLedger(fixture.profileFixture.eventFile);
    expect(events.filter((event?: any) : any => event.kind === "spawn")).toHaveLength(1);
    expect(
      events.filter(
        (event?: any) : any => event.kind === "stdin" && event.method === "tools/call"
      )
    ).toHaveLength(2);
    expect(fixture.key.readCount).toBe(2);
    expect(fixture.governed.capturedAuthorities).toHaveLength(2);

    const controller: any = new AbortController();
    const slow: any = fixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID,
      toolName: "fixture.slow"
    }), { signal: controller.signal });
    await waitForChildMethod(
      fixture.profileFixture.eventFile,
      "tools/call",
      3
    );
    controller.abort("private cancellation detail");
    const cancelled: any = await slow;
    expect(cancelled.ok).toBe(false);
    await waitForChildMethod(
      fixture.profileFixture.eventFile,
      "notifications/cancelled",
      1
    );
    events = await readEventLedger(fixture.profileFixture.eventFile);
    expect(
      events.filter(
        (event?: any) : any =>
          event.kind === "stdin" &&
          event.method === "notifications/cancelled"
      )
    ).toHaveLength(1);
    expectBoundedPrivateSafeFailure(cancelled);

    replaceRuntimeServices(
      fixture.registry,
      [stdioService({ serviceRevision: 2 })],
      2
    );
    const rotated: any = await fixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID,
      arguments: { payload: "rotated-session-generation" }
    }));
    expect(rotated).toMatchObject({ ok: true, status: 200 });
    await waitFor(async () : Promise<any> => {
      const current: any = await readEventLedger(fixture.profileFixture.eventFile);
      return current.filter((event?: any) : any => event.kind === "spawn").length === 2 &&
        current.filter(
          (event?: any) : any => event.kind === "stdin" && event.method === "shutdown"
        ).length === 1
        ? current
        : null;
    }, "Timed out waiting for governed stdio generation rotation.");
    events = await readEventLedger(fixture.profileFixture.eventFile);
    expect(events.filter((event?: any) : any => event.kind === "spawn")).toHaveLength(2);
    expect(
      events.filter(
        (event?: any) : any => event.kind === "stdin" && event.method === "shutdown"
      )
    ).toHaveLength(1);
    expect(fixture.key.readCount).toBe(4);
    expect(fixture.governed.capturedAuthorities).toHaveLength(4);

    await fixture.registry.close();
    events = await readEventLedger(fixture.profileFixture.eventFile);
    expect(
      events.filter(
        (event?: any) : any => event.kind === "stdin" && event.method === "shutdown"
      )
    ).toHaveLength(1);
  });

  it("stops the real stdio pipe before the next write when authority or session generation changes", async () : Promise<any> => {
    const revokedFixture: any = await createStdioHarness({
      holdMethod: "initialize"
    });
    const revokedPending: any = revokedFixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID
    }));
    await waitForChildMethod(
      revokedFixture.profileFixture.eventFile,
      "initialize"
    );
    await revokedFixture.governed.platform.store.revokeGrant(
      revokedFixture.governed.grant.id,
      "mcp_stdio_initialize_revocation"
    );
    await fs.writeFile(
      revokedFixture.profileFixture.releaseFile,
      "release",
      { encoding: "utf8", mode: 0o600 }
    );
    const revoked: any = await revokedPending;
    expect(revoked.ok).toBe(false);
    let events: any = await readEventLedger(revokedFixture.profileFixture.eventFile);
    expect(
      events.filter((event?: any) : any => event.kind === "stdin")
        .map((event?: any) : any => event.method)
    ).toEqual(["initialize"]);
    expectBoundedPrivateSafeFailure(revoked);

    const driftFixture: any = await createStdioHarness({
      holdMethod: "initialize"
    });
    const driftPending: any = driftFixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID
    }));
    await waitForChildMethod(
      driftFixture.profileFixture.eventFile,
      "initialize"
    );
    replaceRuntimeServices(
      driftFixture.registry,
      [stdioService({ serviceRevision: 2 })],
      2
    );
    await fs.writeFile(
      driftFixture.profileFixture.releaseFile,
      "release",
      { encoding: "utf8", mode: 0o600 }
    );
    const drifted: any = await driftPending;
    expect(drifted.ok).toBe(false);
    events = await readEventLedger(driftFixture.profileFixture.eventFile);
    expect(
      events.filter((event?: any) : any => event.kind === "stdin")
        .map((event?: any) : any => event.method)
    ).toEqual(["initialize"]);
    expectBoundedPrivateSafeFailure(drifted);
  });

  it("rejects stdio command, argv, digest, environment, session, and upload-code substitution before execution", async () : Promise<any> => {
    const uploadRoot: any = await temporaryRoot("meshrix-upload-like-noexec-");
    const uploadedCode: any = path.join(uploadRoot, "uploaded-code.ts");
    const shellMarker: any = path.join(uploadRoot, "shell-marker");
    await fs.writeFile(
      uploadedCode,
      `throw new Error("${PRIVATE_CODE_MARKER}");\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const beforeStat: any = await fs.stat(uploadedCode);
    expect(beforeStat.mode & 0o111).toBe(0);
    const beforeDigest: any = await fileDigest(uploadedCode);

    const commandFixture: any = await createStdioHarness({
      serviceOverrides: {
        mcp: {
          transport: "stdio",
          launchProfileId: LAUNCH_PROFILE_ID,
          command: `${process.execPath}; touch ${shellMarker}`,
          args: [uploadedCode],
          env: {
            MCP_FIXTURE_MODE: "declared-mode"
          },
          toolNamePrefix: "governed-stdio",
          timeoutMs: 2_000
        }
      }
    });
    const commandDenied: any = await commandFixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID
    }));
    expect(commandDenied.ok).toBe(false);
    expect(commandFixture.key.readCount).toBe(0);
    expect(await readEventLedger(commandFixture.profileFixture.eventFile))
      .toHaveLength(0);
    await expect(fs.access(shellMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expectBoundedPrivateSafeFailure(commandDenied);

    const unknownProfileFixture: any = await createStdioHarness({
      serviceOverrides: {
        mcp: {
          transport: "stdio",
          launchProfileId: "caller-selected-profile",
          env: {
            MCP_FIXTURE_MODE: "declared-mode"
          },
          toolNamePrefix: "governed-stdio",
          timeoutMs: 2_000
        }
      }
    });
    const unknownProfileDenied: any =
      await unknownProfileFixture.governed.execute(mcpInput({
        serviceId: STDIO_SERVICE_ID
      }));
    expect(unknownProfileDenied.ok).toBe(false);
    expect(unknownProfileFixture.key.readCount).toBe(0);
    expect(
      await readEventLedger(unknownProfileFixture.profileFixture.eventFile)
    ).toHaveLength(0);
    expectBoundedPrivateSafeFailure(unknownProfileDenied);

    const digestFixture: any = await createStdioHarness({
      profileOverrides: {
        executableSha256: "0".repeat(64)
      }
    });
    const digestDenied: any = await digestFixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID
    }));
    expect(digestDenied.ok).toBe(false);
    expect(digestFixture.key.readCount).toBe(0);
    expect(await readEventLedger(digestFixture.profileFixture.eventFile))
      .toHaveLength(0);
    expectBoundedPrivateSafeFailure(digestDenied);

    const argumentDigestFixture: any = await createStdioHarness({
      profileOverrides: {
        argumentSha256: "f".repeat(64)
      }
    });
    const argumentDigestDenied: any =
      await argumentDigestFixture.governed.execute(mcpInput({
        serviceId: STDIO_SERVICE_ID
      }));
    expect(argumentDigestDenied.ok).toBe(false);
    expect(argumentDigestFixture.key.readCount).toBe(0);
    expect(
      await readEventLedger(argumentDigestFixture.profileFixture.eventFile)
    ).toHaveLength(0);
    expectBoundedPrivateSafeFailure(argumentDigestDenied);

    const environmentFixture: any = await createStdioHarness({
      serviceOverrides: {
        mcp: {
          transport: "stdio",
          launchProfileId: LAUNCH_PROFILE_ID,
          env: {
            MCP_FIXTURE_MODE: "declared-mode",
            NODE_OPTIONS: `--import=${uploadedCode}`,
            LD_PRELOAD: uploadedCode,
            MESHRIX_PRIVATE_SERVER_MARKER: PRIVATE_CODE_MARKER
          },
          toolNamePrefix: "governed-stdio",
          timeoutMs: 2_000
        }
      }
    });
    const environmentDenied: any = await environmentFixture.governed.execute(
      mcpInput({ serviceId: STDIO_SERVICE_ID })
    );
    expect(environmentDenied.ok).toBe(false);
    expect(environmentFixture.key.readCount).toBe(0);
    expect(await readEventLedger(environmentFixture.profileFixture.eventFile))
      .toHaveLength(0);
    expectBoundedPrivateSafeFailure(environmentDenied);

    const exactFixture: any = await createStdioHarness();
    const exact: any = await exactFixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID,
      arguments: {
        payload: `${uploadedCode}:${PRIVATE_CODE_MARKER}`
      }
    }));
    expect(exact).toMatchObject({ ok: true, status: 200 });
    const exactEvents: any = await readEventLedger(
      exactFixture.profileFixture.eventFile
    );
    expect(exactEvents[0]).toMatchObject({
      kind: "spawn",
      argv: [exactFixture.profileFixture.scriptPath]
    });
    expect(JSON.stringify(exactEvents)).not.toContain(uploadedCode);
    expect(JSON.stringify(exactEvents)).not.toContain(PRIVATE_CODE_MARKER);
    const afterStat: any = await fs.stat(uploadedCode);
    expect(afterStat.mode & 0o777).toBe(0o600);
    expect(await fileDigest(uploadedCode)).toBe(beforeDigest);
  });

  it("enforces closed HTTP header and stdio credential environment projections", async () : Promise<any> => {
    const httpFixture: any = await createHttpHarness();
    const httpResult: any = await httpFixture.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    expect(httpResult).toMatchObject({ ok: true, status: 200 });
    for (const request of httpFixture.peer.requests) {
      expect(request.headers).toMatchObject({
        cookie: "",
        forwarded: "",
        proof: ""
      });
      expect(request.headers.contentType).toBe("application/json");
      expect(request.headers.accept).toBe(
        "application/json, text/event-stream"
      );
    }

    const badHeaderPeer: any = await createHttpMcpPeer();
    const badHttp: any = await createHttpHarness({
      peer: badHeaderPeer,
      serviceOverrides: {
        mcp: {
          transport: "streamable-http",
          url: badHeaderPeer.url,
          headers: {
            host: "substituted.invalid",
            cookie: PRIVATE_CREDENTIAL_MARKER,
            forwarded: `for=${PRIVATE_CREDENTIAL_MARKER}`,
            "content-length": "1",
            "transfer-encoding": "chunked",
            "mcp-session-id": "caller-session",
            "mcp-protocol-version": "1900-01-01",
            "x-meshrix-proof": PRIVATE_CREDENTIAL_MARKER
          },
          toolNamePrefix: "governed-http",
          timeoutMs: 2_000
        }
      }
    });
    const badHttpPrefix: any = badHttp.peer.requests.length;
    const badHttpResult: any = await badHttp.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    expect(badHttpResult.ok).toBe(false);
    expect(badHttp.key.readCount).toBe(0);
    expect(badHttp.peer.requests).toHaveLength(badHttpPrefix);
    expectBoundedPrivateSafeFailure(badHttpResult);

    const badSecretPeer: any = await createHttpMcpPeer();
    const badSecret: any = await createHttpHarness({
      peer: badSecretPeer,
      secretPayload: {
        headers: {
          authorization: `Bearer ${PRIVATE_CREDENTIAL_MARKER}`,
          cookie: PRIVATE_CREDENTIAL_MARKER
        }
      }
    });
    const badSecretResult: any = await badSecret.governed.execute(mcpInput({
      serviceId: HTTP_SERVICE_ID
    }));
    expect(badSecretResult.ok).toBe(false);
    expect(badSecretPeer.requests).toHaveLength(0);
    expectBoundedPrivateSafeFailure(badSecretResult);

    const stdioFixture: any = await createStdioHarness();
    const stdioResult: any = await stdioFixture.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID
    }));
    expect(stdioResult).toMatchObject({ ok: true, status: 200 });
    const stdioEvents: any = await readEventLedger(
      stdioFixture.profileFixture.eventFile
    );
    expect(stdioEvents[0]).toMatchObject({
      descriptorMode: "declared-mode",
      credentialPresent: true,
      nodeOptionsPresent: false,
      loaderPresent: false,
      serverPrivatePresent: false
    });

    const badStdioSecret: any = await createStdioHarness({
      secretPayload: {
        env: {
          MCP_FIXTURE_TOKEN: PRIVATE_CREDENTIAL_MARKER,
          NODE_OPTIONS: `--eval=${PRIVATE_CODE_MARKER}`
        }
      }
    });
    const badStdioResult: any = await badStdioSecret.governed.execute(mcpInput({
      serviceId: STDIO_SERVICE_ID
    }));
    expect(badStdioResult.ok).toBe(false);
    expect(await readEventLedger(badStdioSecret.profileFixture.eventFile))
      .toHaveLength(0);
    expectBoundedPrivateSafeFailure(badStdioResult);
  });

  it("rejects missing, completed, and replayed authority before direct manager or registry effects", async () : Promise<any> => {
    const peer: any = await createHttpMcpPeer();
    const directHttpManager: any = createUpstreamMcpSessionManager();
    trackCleanup(() : any => directHttpManager.close());
    await expect(directHttpManager.callTool({
      transport: "streamable-http",
      url: peer.url,
      timeoutMs: 1_000,
      sessionKey: "direct-missing-authority",
      sessionScope: "direct-missing-authority"
    }, {
      name: "fixture.echo",
      arguments: {}
    })).rejects.toMatchObject({
      code: "mcp_final_effect_authority_required"
    });
    expect(peer.requests).toHaveLength(0);

    const root: any = await temporaryRoot("meshrix-mcp-direct-stdio-authority-");
    const profileFixture: any = await createPinnedLaunchProfile({ root });
    const directStdioManager: any = createUpstreamMcpSessionManager({
      stdioLaunchProfiles: [profileFixture.profile]
    });
    trackCleanup(() : any => directStdioManager.close());
    await expect(directStdioManager.callTool({
      transport: "stdio",
      launchProfileId: LAUNCH_PROFILE_ID,
      timeoutMs: 1_000,
      sessionKey: "direct-missing-authority",
      sessionScope: "direct-missing-authority"
    }, {
      name: "fixture.echo",
      arguments: {}
    })).rejects.toMatchObject({
      code: "mcp_final_effect_authority_required"
    });
    expect(await readEventLedger(profileFixture.eventFile)).toHaveLength(0);

    const governedFixture: any = await createHttpHarness();
    const input: any = mcpInput({ serviceId: HTTP_SERVICE_ID });
    await expect(governedFixture.registry.forward(
      input,
      {
        subjectId: governedFixture.governed.grant.id,
        scopes: ["gateway:read", "gateway:write"]
      }
    )).rejects.toMatchObject({
      code: "mcp_final_effect_authority_required"
    });
    expect(governedFixture.peer.requests).toHaveLength(0);
    expect(governedFixture.key.readCount).toBe(0);

    const first: any = await governedFixture.governed.execute(input);
    expect(first).toMatchObject({ ok: true, status: 200 });
    const authority: any =
      governedFixture.governed.capturedAuthorities.at(-1);
    const requestCount: any = governedFixture.peer.requests.length;
    const keyReads: any = governedFixture.key.readCount;

    await expect(governedFixture.registry.forward(
      input,
      {
        subjectId: governedFixture.governed.grant.id,
        scopes: ["gateway:read", "gateway:write"]
      },
      {
        mcpFinalEffectAuthority: authority
      }
    )).rejects.toMatchObject({
      code: "mcp_final_effect_authority_closed_or_replayed"
    });
    expect(governedFixture.peer.requests).toHaveLength(requestCount);
    expect(governedFixture.key.readCount).toBe(keyReads);

    const fresh: any = await governedFixture.governed.execute(input);
    expect(fresh).toMatchObject({ ok: true, status: 200 });
    expect(governedFixture.peer.requests.length).toBe(requestCount + 1);
    expect(governedFixture.key.readCount).toBe(keyReads + 1);
  });
});
