import { EventEmitter } from "node:events";
import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-gateway-transport.ts";
import { createHttpMcpSession } from "../../../packages/protocols/mcp/upstream-mcp-http-session.ts";
const canned1 = "stdio-generation-one";
const canned2 = "missing-managed-egress";
const canned3 = "stdio-generation-two";
const canned4 = "monotonic-generation-one";
const canned5 = "monotonic-generation-two";
const canned6 = "monotonic-generation-conflict";
const canned7 = "http-generation-one";
const canned8 = "";
const canned9 = "http-dispatch-fence-recovery";
const canned10 = "stdio-dispatch-fence-queue";
const canned11 = "capacity-a";
const canned12 = "capacity-b";
const canned13 = "http-notification-flood";
const canned14 = "lifetime-generation";
const canned15 = "rejected-initialized-notification";
const canned16 = "unsupported-protocol-generation";
const canned17 = "initialization-recovery-generation";
const canned18 = "shared-initialization-cancellation";
const canned19 = "orphaned-initialization-cancellation";
const canned20 = "injected-environment-generation";




const managers: any = new Set<any>();
const servers: any = new Set<any>();

it.each([
  ["oversized JSON", "application/json", "x".repeat(8 * 1024 * 1024 + 1)],
  ["malformed SSE", "text/event-stream", "data: invalid-json\n\n"]
])("cancels an open %s response before releasing its HTTP transport", async (_label, contentType, body) => {
  const events: string[] = [];
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      // Keep the peer's response open after the rejected content.
    },
    cancel() { events.push("body-cancelled"); }
  }), { headers: { "content-type": contentType } });
  await expect(createHttpMcpSession({ transport: "http", url: "https://mcp.example.test/mcp" }, {
    fetchTransport: async () => ({
      response,
      close: async () => { events.push("transport-closed"); }
    })
  })).rejects.toMatchObject({ code: "UPSTREAM_MCP_PROTOCOL_ERROR" });
  expect(events).toEqual(["body-cancelled", "transport-closed"]);
  expect(response.body?.locked).toBe(false);
});

function listenLoopback(server?: any) : any {
  return new Promise((resolve?: any, reject?: any) : any => {
    const onError: any = (error?: any) : any => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening: any = () : any => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function delay(ms?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

function deferred() : any {
  let resolve: any;
  let reject: any;
  const promise: any = new Promise((accept?: any, decline?: any) : any => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function gatedInitializeTransport() : any {
  const started: any = deferred();
  const release: any = deferred();
  const aborted: any = deferred();
  const state: Record<string, any> = { initializeAttempts: 0, signal: null };
  const fetchTransport: any = async (url?: any, init?: any, context: Record<string, any> = {}) : Promise<any> => {
    await context.beforeFetch?.();
    const request: any = JSON.parse(String(init?.body || "{}"));
    if (request.method === "initialize") {
      state.initializeAttempts += 1;
      state.signal = init.signal;
      started.resolve();
      await new Promise((resolve?: any, reject?: any) : any => {
        let settled: any = false;
        const finish: any = (callback?: any, value?: any) : any => {
          if (settled) return;
          settled = true;
          init.signal?.removeEventListener("abort", onAbort);
          callback(value);
        };
        const onAbort: any = () : any => {
          aborted.resolve();
          finish(reject, Object.assign(new Error("synthetic initialize transport aborted"), { name: "AbortError" }));
        };
        init.signal?.addEventListener("abort", onAbort, { once: true });
        release.promise.then(() : any => finish(resolve));
        if (init.signal?.aborted) onAbort();
      });
    }
    return { response: await fetch(url, init) };
  };
  return { fetchTransport, started, release, aborted, state };
}

function gatedInitializeStdioLauncher() : any {
  const started: any = deferred();
  const release: any = deferred();
  const state: Record<string, any> = { initializeAttempts: 0, methods: [] };
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () : any => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () : any => {};
  child.stdin = {
    writable: true,
    write(value?: any, _encoding?: any, callback?: any) : any {
      const message: any = JSON.parse(String(value));
      state.methods.push(message.method);
      queueMicrotask(() : any => callback?.());
      const respond: any = (result?: any) : any => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
      if (message.method === "initialize") {
        state.initializeAttempts += 1;
        started.resolve();
        release.promise.then(() : any => respond({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" }
        }));
      } else if (message.method === "tools/list") {
        respond({ tools: [] });
      }
      return true;
    },
    end() : any { child.emit("exit", 0, null); },
    ref() : any {},
    unref() : any {}
  };
  child.ref = () : any => {};
  child.unref = () : any => {};
  child.kill = () : any => { child.emit("exit", 0, null); return true; };
  return { stdioLauncher: { launch: () : any => child }, started, release, state };
}

function createLoopbackHttpManager(options: Record<string, any> = {}) : any {
  const fetchTransport: any = options.fetchTransport || (async (url?: any, init?: any, context: Record<string, any> = {}) : Promise<any> => {
    await context.beforeFetch?.();
    return { response: await fetch(url, init) };
  });
  return createUpstreamMcpSessionManager({
    ...options,
    fetchTransport
  });
}

function stdioFixtureScript() : any {
  return String.raw`
let buffer = "";
let state = 0;
const timers = new Map();
const pingAnswers = new Set();
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\n"); }
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function handle(message) {
  if (!message) return;
  if (!message.method && message.id !== undefined) {
    if (message.result) pingAnswers.add(message.id);
    return;
  }
  if (!message.method) return;
  if (message.method === "notifications/cancelled") {
    const timer = timers.get(message.params && message.params.requestId);
    if (timer) clearTimeout(timer);
    timers.delete(message.params && message.params.requestId);
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    result(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, { tools: [{ name: "state.increment", inputSchema: { type: "object" } }, { name: "state.probe", inputSchema: { type: "object" } }] });
    return;
  }
  if (message.method !== "tools/call") return;
  const name = message.params.name;
  if (name === "state.increment") {
    state += 1;
    result(message.id, { structuredContent: { value: state } });
    return;
  }
  if (name === "state.probe") {
    result(message.id, { structuredContent: { value: state } });
    return;
  }
  if (name === "ping-check") {
    send({ jsonrpc: "2.0", id: message.id, method: "ping", params: {} });
    setTimeout(() => result(message.id, { structuredContent: { answered: pingAnswers.has(message.id) } }), 10);
    return;
  }
  if (name === "slow") {
    setTimeout(() => result(message.id, { structuredContent: { name } }), 60);
    return;
  }
  if (name === "fast") {
    setTimeout(() => result(message.id, { structuredContent: { name } }), 5);
    return;
  }
  if (name === "cancel-me") {
    const timer = setTimeout(() => {
      timers.delete(message.id);
      state += 100;
      result(message.id, { structuredContent: { value: state } });
    }, 80);
    timers.set(message.id, timer);
    return;
  }
  if (name === "survivor") {
    setTimeout(() => result(message.id, { structuredContent: { name } }), 25);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
`;
}

function stdioConfig(overrides: Record<string, any> = {}) : any {
  return {
    transport: "stdio",
    command: process.execPath,
    args: ["-e", stdioFixtureScript()],
    timeoutMs: 1000,
    sessionKey: canned1,
    sessionScope: "stdio-service",
    ...overrides
  };
}

async function readJsonBody(request?: any) : Promise<any> {
  let body: any = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function jsonResponse(response?: any, status?: any, payload?: any, headers: Record<string, any> = {}) : any {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(payload === undefined ? "" : JSON.stringify(payload));
}

async function createHttpFixture({
  negotiatedProtocolVersion = "2025-06-18",
  rejectInitialized = false,
  missingInitializedOnce = false
}: Record<string, any> = {}) : Promise<any> {
  const evidence: Record<string, any> = {
    initializations: [],
    initializedNotifications: [],
    calls: [],
    effectCount: 0,
    cancellations: [],
    deletions: [],
    clientResponses: [],
    state: 0,
    recovered: false,
    resourceReadRecovered: false
  };
  let nextSessionId: any = 1;
  const activeSessions: any = new Set<any>();
  const pendingEffects: any = new Map<any, any>();
  let initializedMissingDelivered: any = false;
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    if (request.method === "DELETE") {
      const sessionId: any = String(request.headers["mcp-session-id"] || "");
      evidence.deletions.push(sessionId);
      activeSessions.delete(sessionId);
      response.writeHead(204);
      response.end();
      return;
    }
    const message: any = await readJsonBody(request);
    const sessionId: any = String(request.headers["mcp-session-id"] || "");
    const protocolVersion: any = String(request.headers["mcp-protocol-version"] || "");
    if (!message.method && message.id !== undefined) {
      evidence.clientResponses.push({
        id: message.id,
        result: message.result,
        error: message.error,
        sessionId,
        protocolVersion
      });
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === "initialize") {
      const createdSessionId: any = `session-${nextSessionId++}`;
      activeSessions.add(createdSessionId);
      evidence.initializations.push({
        sessionHeaderPresent: Boolean(sessionId),
        protocolHeaderPresent: Boolean(protocolVersion),
        authorization: String(request.headers.authorization || ""),
        contentType: String(request.headers["content-type"] || ""),
        accept: String(request.headers.accept || "")
      });
      jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: negotiatedProtocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" }
        }
      }, { "mcp-session-id": createdSessionId });
      return;
    }
    if (message.method === "notifications/initialized") {
      evidence.initializedNotifications.push({ sessionId, protocolVersion });
      if (missingInitializedOnce && !initializedMissingDelivered) {
        initializedMissingDelivered = true;
        activeSessions.delete(sessionId);
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(rejectInitialized ? 500 : 202);
      response.end();
      return;
    }
    if (message.method === "notifications/cancelled") {
      evidence.cancellations.push({
        requestId: message.params.requestId,
        reason: message.params.reason,
        sessionId,
        protocolVersion
      });
      const timer: any = pendingEffects.get(message.params.requestId);
      if (timer) clearTimeout(timer);
      pendingEffects.delete(message.params.requestId);
      response.writeHead(202);
      response.end();
      return;
    }
    evidence.calls.push({ method: message.method, name: message.params?.name, sessionId, protocolVersion });
    if (!activeSessions.has(sessionId)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (message.method === "tools/list") {
      jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "fixture.echo", inputSchema: { type: "object" } }] }
      });
      return;
    }
    if (message.method === "resources/read") {
      if (!evidence.resourceReadRecovered) {
        evidence.resourceReadRecovered = true;
        activeSessions.delete(sessionId);
        response.writeHead(404);
        response.end();
        return;
      }
      jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "recovered" }] }
      });
      return;
    }
    const name: any = message.params?.name;
    if (name === "recover-effect") {
      evidence.effectCount += 1;
      if (evidence.effectCount === 1) {
        activeSessions.delete(sessionId);
        response.writeHead(404);
        response.end();
        return;
      }
      jsonResponse(response, 200, { jsonrpc: "2.0", id: message.id, result: { structuredContent: { value: evidence.effectCount } } });
      return;
    }
    if (name === "recover" && !evidence.recovered) {
      evidence.recovered = true;
      activeSessions.delete(sessionId);
      response.writeHead(404);
      response.end();
      return;
    }
    if (name === "cancel-http") {
      const timer: any = setTimeout(() : any => {
        pendingEffects.delete(message.id);
        evidence.state += 100;
        if (!response.destroyed) {
          jsonResponse(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { structuredContent: { value: evidence.state } }
          });
        }
      }, 100);
      pendingEffects.set(message.id, timer);
      return;
    }
    if (name === "slow-close") {
      setTimeout(() : any => {
        if (!response.destroyed) {
          jsonResponse(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { structuredContent: { completed: true } }
          });
        }
      }, 100);
      return;
    }
    if (name === "probe") {
      jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { structuredContent: { value: evidence.state } }
      });
      return;
    }
    if (name === "notification-flood") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      for (let index: any = 0; index < 100; index += 1) {
        response.write(`data: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { index }
        })}\n\n`);
      }
      response.end(`data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { structuredContent: { name } }
      })}\n\n`);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "ping", params: {} })}\n\n`);
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: `unsupported-${message.id}`, method: "roots/list", params: {} })}\n\n`);
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 0.5 } })}\n\n`);
    const result: any = JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { structuredContent: { name } }
    });
    response.write(`data: ${result.slice(0, Math.floor(result.length / 2))}`);
    setTimeout(() : any => response.end(`${result.slice(Math.floor(result.length / 2))}\n\n`), 5);
  });
  await listenLoopback(server);
  servers.add(server);
  const address: any = server.address();
  return {
    evidence,
    url: `http://127.0.0.1:${address.port}/mcp`
  };
}

afterEach(async () : Promise<any> => {
  await Promise.allSettled([...managers].map((manager?: any) : any => manager.close()));
  managers.clear();
  await Promise.allSettled([...servers].map((server?: any) : any => new Promise((resolve?: any) : any => server.close(resolve))));
  servers.clear();
});

describe("upstream MCP managed sessions", () : any => {
  it("fails closed when HTTP forwarding has no gateway-managed egress transport", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager();
    managers.add(manager);

    await expect(manager.listTools({
      transport: "streamable-http",
      url: "http://169.254.169.254/latest/meta-data",
      sessionKey: canned2,
      sessionScope: "missing-managed-egress"
    })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_MANAGED_EGRESS_REQUIRED",
      status: 500
    });
  });

  it("keeps stdio state, routes concurrent ids, and isolates cancellation", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager({
      maxSessions: 2,
      maxConcurrentRequestsPerSession: 4,
      idleTtlMs: 5000
    });
    managers.add(manager);
    const config: any = stdioConfig();

    const listed: any = await manager.listTools(config);
    expect(listed.tools.map((tool?: any) : any => tool.name)).toContain("state.increment");
    await manager.callTool(config, { name: "state.increment" });
    const probe: any = await manager.callTool(config, { name: "state.probe" });
    expect(probe.result.structuredContent.value).toBe(1);
    const ping: any = await manager.callTool(config, { name: "ping-check" });
    expect(ping.result.structuredContent.answered).toBe(true);

    const [slow, fast] = await Promise.all([
      manager.callTool(config, { name: "slow" }),
      manager.callTool(config, { name: "fast" })
    ]);
    expect(slow.result.structuredContent.name).toBe("slow");
    expect(fast.result.structuredContent.name).toBe("fast");

    const controller: any = new AbortController();
    const cancelled: any = manager.callTool(config, { name: "cancel-me" }, { signal: controller.signal });
    const survivor: any = manager.callTool(config, { name: "survivor" });
    setTimeout(() : any => controller.abort("private caller reason"), 10);
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    await expect(survivor).resolves.toMatchObject({ result: { structuredContent: { name: "survivor" } } });
    await delay(100);
    const afterCancel: any = await manager.callTool(config, { name: "state.probe" });
    expect(afterCancel.result.structuredContent.value).toBe(1);
    expect(manager.snapshot()).toMatchObject({ sessionCount: 1, inFlightRequestCount: 0 });
  });

  it("enforces concurrency and rotates a session scope without reusing old state", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager({
      maxSessions: 2,
      maxConcurrentRequestsPerSession: 1,
      idleTtlMs: 5000
    });
    managers.add(manager);
    const first: any = stdioConfig();
    await manager.listTools(first);
    const slow: any = manager.callTool(first, { name: "slow" });
    await delay(10);
    await expect(manager.callTool(first, { name: "fast" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_CONCURRENCY"
    });
    await slow;
    await manager.callTool(first, { name: "state.increment" });

    const rotated: any = stdioConfig({ sessionKey: canned3 });
    const probe: any = await manager.callTool(rotated, { name: "state.probe" });
    expect(probe.result.structuredContent.value).toBe(0);
    expect(manager.snapshot().reusableSessionCount).toBe(1);
    await expect(manager.callTool(first, { name: "state.probe" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STALE_SESSION_GENERATION"
    });
    const current: any = await manager.callTool(rotated, { name: "state.probe" });
    expect(current.result.structuredContent.value).toBe(0);
  });

  it("rejects stale or conflicting explicit generations without unbounded tombstones", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager({
      maxSessions: 2,
      idleTtlMs: 5000
    });
    managers.add(manager);
    const first: any = stdioConfig({
      sessionKey: canned4,
      sessionScope: "monotonic-service",
      sessionGeneration: { serviceRevision: 1, credentialRevisions: [] }
    });
    const second: any = stdioConfig({
      sessionKey: canned5,
      sessionScope: "monotonic-service",
      sessionGeneration: { serviceRevision: 2, credentialRevisions: [] }
    });
    await manager.listTools(first);
    await manager.listTools(second);
    await expect(manager.listTools(first)).rejects.toMatchObject({
      code: "UPSTREAM_MCP_STALE_SESSION_GENERATION"
    });
    await expect(manager.listTools({
      ...second,
      sessionKey: canned6
    })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_GENERATION_CONFLICT"
    });
    expect(manager.snapshot()).toMatchObject({
      trackedScopeCount: 1,
      retiredGenerationCount: 1,
      maxRetiredGenerationsPerScope: 64
    });
    await expect(manager.retireScope("monotonic-service")).resolves.toMatchObject({
      retired: 1,
      removed: false
    });
    await expect(manager.listTools(second)).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_GENERATION_CONFLICT"
    });
    await expect(manager.retireScope("monotonic-service", { remove: true })).resolves.toMatchObject({
      removed: true
    });
    expect(manager.snapshot()).toMatchObject({ trackedScopeCount: 0, retiredGenerationCount: 0 });
  });

  it("streams HTTP notifications, rebuilds a missing session, propagates cancel, and closes with DELETE", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    let openedTransports: any = 0;
    let closedTransports: any = 0;
    const manager: any = createUpstreamMcpSessionManager({
      idleTtlMs: 5000,
      async fetchTransport(url?: any, init?: any) : Promise<any> {
        openedTransports += 1;
        try {
          return {
            response: await fetch(url, init),
            async close() : Promise<any> {
              closedTransports += 1;
            }
          };
        } catch (error: any) {
          closedTransports += 1;
          throw error;
        }
      }
    });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      timeoutMs: 1000,
      sessionKey: canned7,
      sessionScope: "http-service"
    };
    const order: any[] = [];
    const echo: any = await manager.callTool(config, { name: "echo" }, {
      onNotification(notification?: any) : any {
        order.push(notification.method);
      }
    });
    order.push(echo.result.structuredContent.name);
    expect(order).toEqual(["notifications/progress", "echo"]);
    expect(fixture.evidence.initializations[0]).toMatchObject({
      sessionHeaderPresent: false,
      protocolHeaderPresent: false,
      authorization: canned8
    });
    expect(fixture.evidence.initializedNotifications[0]).toMatchObject({
      sessionId: "session-1",
      protocolVersion: "2025-06-18"
    });
    expect(fixture.evidence.clientResponses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 2, result: {} }),
      expect.objectContaining({ id: "unsupported-2", error: expect.objectContaining({ code: -32601 }) })
    ]));

    const callbackDidRun: any[] = [];
    const nonBlockingNotification: any = await Promise.race([
      manager.callTool(config, { name: "non-blocking-callback" }, {
        onNotification(notification?: any) : any {
          callbackDidRun.push(notification.method);
          return new Promise(() : any => {});
        }
      }),
      delay(250).then(() : any => {
        throw new Error("notification callback blocked the MCP response");
      })
    ]);
    expect(nonBlockingNotification.result.structuredContent.name).toBe("non-blocking-callback");
    expect(callbackDidRun).toContain("notifications/progress");

    await expect(manager.callTool(config, { name: "recover" })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_NOT_FOUND"
    });
    expect(fixture.evidence.initializations).toHaveLength(1);
    const recovered: any = await manager.callTool(config, { name: "recover" });
    expect(recovered.result.structuredContent.name).toBe("recover");
    expect(fixture.evidence.initializations).toHaveLength(2);
    expect(fixture.evidence.calls.filter((call?: any) : any => call.name === "recover")).toHaveLength(2);

    const recoveredRead: any = await manager.invokeGateway(config, {
      method: "resources/read",
      params: { uri: "fixture://resource" }
    });
    expect(recoveredRead.result.contents[0].text).toBe("recovered");
    expect(fixture.evidence.initializations).toHaveLength(3);
    expect(fixture.evidence.calls.filter((call?: any) : any => call.method === "resources/read")).toHaveLength(2);

    const controller: any = new AbortController();
    const cancelled: any = manager.callTool(config, { name: "cancel-http" }, { signal: controller.signal });
    setTimeout(() : any => controller.abort("private caller reason"), 10);
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await delay(120);
    const probe: any = await manager.callTool(config, { name: "probe" });
    expect(probe.result.structuredContent.value).toBe(0);
    expect(fixture.evidence.cancellations).toHaveLength(1);
    expect(fixture.evidence.cancellations[0].reason).toBe("Upstream MCP request was cancelled by the gateway.");
    expect(fixture.evidence.cancellations[0].reason).not.toContain("private caller reason");

    await manager.close();
    expect(fixture.evidence.deletions).toContain("session-2");
    expect(openedTransports).toBeGreaterThan(0);
    expect(closedTransports).toBe(openedTransports);
  });

  it("does not replay a tools/call after a session disappears after dispatch", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const manager: any = createLoopbackHttpManager({ idleTtlMs: 5000 });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      timeoutMs: 1000,
      sessionKey: canned9,
      sessionScope: "http-dispatch-fence-recovery"
    };
    let admissions = 0;
    await expect(manager.invokeGateway(config, {
      method: "tools/call",
      params: { name: "recover-effect", arguments: {} }
    }, {
      async beforeSend() {
        admissions += 1;
        if (admissions > 1) throw Object.assign(new Error("dispatch receipt already exists"), { code: "dispatch_receipt_replayed" });
      }
    })).rejects.toMatchObject({
      code: "UPSTREAM_MCP_SESSION_NOT_FOUND",
      mcpSessionFatal: true
    });
    expect(admissions).toBe(1);
    expect(fixture.evidence.calls.filter((call: any) => call.name === "recover-effect")).toHaveLength(1);
    expect(fixture.evidence.effectCount).toBe(1);
    expect(fixture.evidence.initializations).toHaveLength(1);

    const independentCall: any = await manager.callTool(config, { name: "recover-effect" });
    expect(independentCall.result.structuredContent.value).toBe(2);
    expect(fixture.evidence.effectCount).toBe(2);
    expect(fixture.evidence.calls.filter((call: any) => call.name === "recover-effect")).toHaveLength(2);
    expect(fixture.evidence.initializations).toHaveLength(2);
  });

  it("runs stdio admission after queued writes are ready and never writes an aborted queued call", async () : Promise<any> => {
    const manager: any = createUpstreamMcpSessionManager({ idleTtlMs: 5000 });
    managers.add(manager);
    const config: Record<string, any> = stdioConfig({
      sessionKey: canned10,
      sessionScope: "stdio-dispatch-fence-queue"
    });
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstAdmission = new Promise<void>((resolve) => { announceFirst = resolve; });
    let queuedAdmissions = 0;
    const first = manager.invokeGateway(config, {
      method: "tools/call",
      params: { name: "state.increment", arguments: {} }
    }, {
      async beforeSend() {
        announceFirst();
        await firstGate;
      }
    });
    await firstAdmission;
    const controller = new AbortController();
    const queued = manager.invokeGateway(config, {
      method: "tools/call",
      params: { name: "state.increment", arguments: {} }
    }, {
      signal: controller.signal,
      beforeSend() { queuedAdmissions += 1; }
    });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ result: { structuredContent: { value: 1 } } });
    expect(queuedAdmissions).toBe(0);
    await expect(manager.callTool(config, { name: "state.probe" })).resolves.toMatchObject({ result: { structuredContent: { value: 1 } } });
  });

  it("evicts at capacity and reaps idle HTTP sessions", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const manager: any = createLoopbackHttpManager({ maxSessions: 1, idleTtlMs: 30 });
    managers.add(manager);
    const base: Record<string, any> = { transport: "streamable-http", url: fixture.url, timeoutMs: 1000 };
    await Promise.all([
      manager.listTools({ ...base, sessionKey: canned11, sessionScope: "scope-a" }),
      manager.listTools({ ...base, sessionKey: canned11, sessionScope: "scope-a" })
    ]);
    expect(fixture.evidence.initializations).toHaveLength(1);
    await manager.listTools({ ...base, sessionKey: canned12, sessionScope: "scope-b" });
    expect(manager.snapshot().sessionCount).toBe(1);
    expect(fixture.evidence.deletions.length).toBeGreaterThanOrEqual(1);
    await delay(80);
    expect(manager.snapshot().sessionCount).toBe(0);
    expect(fixture.evidence.deletions.length).toBeGreaterThanOrEqual(2);
  });

  it("bounds HTTP notification callbacks and fails a flooding upstream session closed", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const manager: any = createLoopbackHttpManager({ idleTtlMs: 5000 });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      timeoutMs: 1000,
      sessionKey: canned13,
      sessionScope: "http-notification-flood"
    };
    let activeCallbacks: any = 0;
    let maximumActiveCallbacks: any = 0;

    await expect(manager.callTool(config, { name: "notification-flood" }, {
      onNotification() : any {
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
        return new Promise(() : any => {});
      }
    })).rejects.toMatchObject({ code: "UPSTREAM_MCP_PROTOCOL_ERROR" });
    expect(maximumActiveCallbacks).toBe(1);
    expect(manager.snapshot().reusableSessionCount).toBe(0);
  });

  it("retires sessions at their maximum lifetime", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const manager: any = createLoopbackHttpManager({
      maxSessions: 1,
      idleTtlMs: 5000,
      maxLifetimeMs: 30
    });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      sessionKey: canned14,
      sessionScope: "lifetime-service"
    };
    await manager.listTools(config);
    await delay(60);
    await manager.listTools(config);
    expect(fixture.evidence.initializations).toHaveLength(2);
    expect(fixture.evidence.deletions).toContain("session-1");
  });

  it("deletes issued HTTP sessions when initialization cannot complete", async () : Promise<any> => {
    const rejectedNotification: any = await createHttpFixture({ rejectInitialized: true });
    const firstManager: any = createLoopbackHttpManager();
    managers.add(firstManager);
    await expect(firstManager.listTools({
      transport: "streamable-http",
      url: rejectedNotification.url,
      sessionKey: canned15,
      sessionScope: "rejected-initialized-service"
    })).rejects.toMatchObject({ code: "UPSTREAM_MCP_SESSION_FATAL" });
    expect(rejectedNotification.evidence.deletions).toEqual(["session-1"]);

    const unsupported: any = await createHttpFixture({ negotiatedProtocolVersion: "2024-11-05" });
    const secondManager: any = createLoopbackHttpManager();
    managers.add(secondManager);
    await expect(secondManager.listTools({
      transport: "streamable-http",
      url: unsupported.url,
      sessionKey: canned16,
      sessionScope: "unsupported-protocol-service"
    })).rejects.toMatchObject({ code: "UPSTREAM_MCP_PROTOCOL_ERROR" });
    expect(unsupported.evidence.deletions).toEqual(["session-1"]);
  });

  it("retries once when an issued HTTP session disappears during initialization", async () : Promise<any> => {
    const fixture: any = await createHttpFixture({ missingInitializedOnce: true });
    const manager: any = createLoopbackHttpManager({ maxSessions: 1 });
    managers.add(manager);
    const listed: any = await manager.listTools({
      transport: "streamable-http",
      url: fixture.url,
      sessionKey: canned17,
      sessionScope: "initialization-recovery-service"
    });
    expect(listed.tools).toHaveLength(1);
    expect(fixture.evidence.initializations).toHaveLength(2);
    expect(fixture.evidence.initializedNotifications).toHaveLength(2);
    expect(fixture.evidence.deletions).toContain("session-1");
  });

  it("lets viable HTTP initialization and initialized control finish beyond the implicit 30-second window", async () : Promise<any> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const initializeStarted: any = deferred();
    const initializeRelease: any = deferred();
    const initializedNotificationStarted: any = deferred();
    const initializedNotificationRelease: any = deferred();
    const state: Record<string, any> = { initializeSignal: null, notificationSignal: null, methods: [] };
    const fetchTransport: any = async (_url?: any, init?: any) : Promise<any> => {
      const message: any = JSON.parse(String(init?.body || "{}"));
      state.methods.push(message.method);
      if (message.method === "initialize") {
        state.initializeSignal = init.signal;
        initializeStarted.resolve();
        await initializeRelease.promise;
        return {
          response: new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "slow-session" } })
        };
      }
      if (message.method === "notifications/initialized") {
        state.notificationSignal = init.signal;
        initializedNotificationStarted.resolve();
        await initializedNotificationRelease.promise;
        return { response: new Response(null, { status: 202 }) };
      }
      if (message.method === "tools/list") {
        return {
          response: new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "slow-session" }
          })
        };
      }
      throw new Error(`Unexpected synthetic MCP method: ${message.method}`);
    };
    const manager: any = createLoopbackHttpManager({
      fetchTransport,
      idleTtlMs: 120_000,
      maxLifetimeMs: 120_000
    });
    managers.add(manager);
    const listing: any = manager.listTools({ transport: "streamable-http", url: "http://fixture.invalid/mcp" });

    try {
      await initializeStarted.promise;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(state.initializeSignal.aborted).toBe(false);

      initializeRelease.resolve();
      await initializedNotificationStarted.promise;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(state.notificationSignal.aborted).toBe(false);

      initializedNotificationRelease.resolve();
      await expect(listing).resolves.toMatchObject({ tools: [] });
      expect(state.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    } finally {
      initializeRelease.resolve();
      initializedNotificationRelease.resolve();
      await Promise.allSettled([listing]);
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("lets viable stdio initialization finish beyond the implicit 30-second window", async () : Promise<any> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate: any = gatedInitializeStdioLauncher();
    const manager: any = createUpstreamMcpSessionManager({
      stdioLauncher: gate.stdioLauncher,
      idleTtlMs: 120_000,
      maxLifetimeMs: 120_000
    });
    managers.add(manager);
    let settled: any = false;
    const listing: any = manager.listTools({ transport: "stdio", command: "fixture" })
      .finally(() : any => { settled = true; });
    void listing.catch((error?: any) : any => gate.started.reject(error));

    try {
      await gate.started.promise;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      expect(gate.state.initializeAttempts).toBe(1);

      gate.release.resolve();
      await expect(listing).resolves.toMatchObject({ tools: [] });
      expect(gate.state.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    } finally {
      gate.release.resolve();
      await Promise.allSettled([listing]);
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("keeps a shared initialization alive while another caller still owns it", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const gate: any = gatedInitializeTransport();
    const manager: any = createLoopbackHttpManager({ fetchTransport: gate.fetchTransport });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      sessionKey: canned18,
      sessionScope: "shared-initialization-cancellation"
    };
    const firstController: any = new AbortController();
    const first: any = manager.listTools(config, { signal: firstController.signal });
    const second: any = manager.listTools(config);

    // Queue a harmless pool operation behind both acquires so the second caller
    // has joined the in-progress creation before the first caller is cancelled.
    await manager.retireScope("unrelated-pool-lock-barrier");
    await gate.started.promise;
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.state.signal.aborted).toBe(false);

    gate.release.resolve();
    const listed: any = await second;
    expect(listed.tools).toHaveLength(1);
    expect(gate.state.initializeAttempts).toBe(1);
    expect(fixture.evidence.initializations).toHaveLength(1);
    expect(fixture.evidence.calls.filter((call?: any) : any => call.method === "tools/list")).toHaveLength(1);
  });

  it("aborts setup when the last caller cancels before HTTP initialization is sent", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const gate: any = gatedInitializeTransport();
    const manager: any = createLoopbackHttpManager({ fetchTransport: gate.fetchTransport });
    managers.add(manager);
    const controller: any = new AbortController();
    const listed: any = manager.listTools({
      transport: "streamable-http",
      url: fixture.url,
      sessionKey: canned19,
      sessionScope: "orphaned-initialization-cancellation"
    }, { signal: controller.signal });

    await gate.started.promise;
    controller.abort();
    await expect(listed).rejects.toMatchObject({ name: "AbortError" });
    await gate.aborted.promise;
    await manager.close();

    expect(gate.state.initializeAttempts).toBe(1);
    expect(fixture.evidence.initializations).toHaveLength(0);
    expect(fixture.evidence.calls).toHaveLength(0);
    expect(manager.snapshot()).toMatchObject({ state: "closed", sessionCount: 0, creatingSessionCount: 0 });
  });

  it("keeps MCP HTTP headers literal and waits for active requests during close", async () : Promise<any> => {
    const fixture: any = await createHttpFixture();
    const envName: any = "MCP_SESSION_HEADER_FIXTURE";
    const manager: any = createLoopbackHttpManager({
      env: { [envName]: "synthetic-header-environment-value" }
    });
    managers.add(manager);
    const config: Record<string, any> = {
      transport: "streamable-http",
      url: fixture.url,
      headers: {
        authorization: ("$"+envName),
        "content-type": "text/plain",
        accept: "text/plain"
      },
      sessionKey: canned20,
      sessionScope: "injected-environment-service"
    };
    await manager.listTools(config);
    expect(fixture.evidence.initializations[0].authorization).toBe(`$${envName}`);
    expect(fixture.evidence.initializations[0].authorization).not.toBe("synthetic-header-environment-value");
    expect(fixture.evidence.initializations[0].contentType).toBe("application/json");
    expect(fixture.evidence.initializations[0].accept).toBe("application/json, text/event-stream");
    const slowOutcome: any = manager.callTool(config, { name: "slow-close" })
      .then(() : any => null, (error?: any) : any => error);
    await delay(10);
    await manager.close();
    await expect(slowOutcome).resolves.toMatchObject({ name: "AbortError" });
    expect(manager.snapshot()).toMatchObject({ state: "closed", inFlightRequestCount: 0 });
  });
});
