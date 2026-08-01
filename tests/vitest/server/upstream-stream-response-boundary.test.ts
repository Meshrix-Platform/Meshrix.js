import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServerRequestHandler } from "../../../apps/server/runtime/http-server-routes.ts";
import { createUpstreamGatewayRegistry } from "../../../packages/agents/src/upstream-gateway/index.ts";
import { installUpstreamRuntimeServices } from "../../helpers/upstream-runtime-snapshot.ts";

const cleanup: any[] = [];
const HEADER_END: any = Buffer.from("\r\n\r\n");
const LINE_END: any = Buffer.from("\r\n");
const MEBIBYTE: any = 1024 * 1024;

function deferred() : any {
  let resolve: any;
  let reject: any;
  const promise: any = new Promise((resolvePromise?: any, rejectPromise?: any) : any => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function delay(milliseconds?: any) : any {
  return new Promise((resolve?: any) : any => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate?: any, {
  label = "condition",
  timeoutMs = 3_000
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

function parseRequestHeaders(headerBlock?: any) : any {
  const lines: any = headerBlock.toString("latin1").split("\r\n");
  const [method = "", target = "", protocol = ""] = String(lines.shift() || "").split(" ");
  const headers: Record<string, any> = {};
  for (const line of lines) {
    const separator: any = line.indexOf(":");
    if (separator <= 0) continue;
    const name: any = line.slice(0, separator).trim().toLowerCase();
    const value: any = line.slice(separator + 1).trim();
    headers[name] = Object.hasOwn(headers, name)
      ? `${headers[name]}, ${value}`
      : value;
  }
  return { headers, method, protocol, target };
}

async function createRawUpstreamPeer(responder?: any) : Promise<any> {
  const sockets: any = new Set<any>();
  const requests: any[] = [];
  const pendingResponders: any = new Set<any>();
  let connectionSequence: any = 0;
  const server: any = net.createServer((socket?: any) : any => {
    const connectionId: any = ++connectionSequence;
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () : any => {});
    socket.on("close", () : any => sockets.delete(socket));
    let buffered: any = Buffer.alloc(0);
    socket.on("data", (chunk?: any) : any => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      while (buffered.length > 0) {
        const headerOffset: any = buffered.indexOf(HEADER_END);
        if (headerOffset < 0) return;
        const parsed: any = parseRequestHeaders(buffered.subarray(0, headerOffset));
        const declaredLength: any = Number(parsed.headers["content-length"] || 0);
        const bodyLength: any = Number.isSafeInteger(declaredLength) && declaredLength >= 0
          ? declaredLength
          : 0;
        const consumed: any = headerOffset + HEADER_END.length + bodyLength;
        if (buffered.length < consumed) return;
        const request: Readonly<Record<string, any>> = Object.freeze({
          ...parsed,
          body: Buffer.from(buffered.subarray(headerOffset + HEADER_END.length, consumed)),
          connectionId,
          requestIndex: requests.length
        });
        buffered = buffered.subarray(consumed);
        requests.push(request);
        const pending: any = Promise.resolve(responder({ request, socket }))
          .catch((error?: any) : any => socket.destroy(error instanceof Error ? error : undefined))
          .finally(() : any => pendingResponders.delete(pending));
        pendingResponders.add(pending);
      }
    });
  });
  const port: any = await listen(server);
  cleanup.push(async () : Promise<any> => {
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...pendingResponders]);
    if (server.listening) {
      await new Promise((resolve?: any) : any => server.close(resolve));
    }
  });
  return { port, requests, server, sockets };
}

function opaqueTransport(responseMaxBytes: any = MEBIBYTE) : any {
  return {
    request: {
      mode: "opaque_stream",
      maxBytes: MEBIBYTE,
      mediaTypes: ["application/octet-stream"]
    },
    response: {
      mode: "opaque_stream",
      maxBytes: responseMaxBytes,
      mediaTypes: ["application/octet-stream"]
    }
  };
}

function operationFixture(operationKey?: any, responseMaxBytes: any = MEBIBYTE) : any {
  return {
    operationKey,
    method: "POST",
    path: `/${operationKey}`,
    risk: "safe_write",
    requiredScopes: ["gateway:write"],
    payloadTransport: opaqueTransport(responseMaxBytes)
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

async function createGatewayServer(registry?: any) : Promise<any> {
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
    lifecycle,
    loginRateLimiter: allowRateLimit(),
    operationAuditStore: null,
    operationConcurrencyScope: "upstream-stream-response-boundary",
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
      authorizeOperation: async () : Promise<any> => ({
        ok: true,
        session: {
          user: {
            roleId: "member",
            scopes: ["gateway:write"],
            subjectId: "owner",
            tenantId: "tenant",
            userId: "owner",
            username: "owner"
          }
        }
      }),
      verifyProcessIdentity: async () : Promise<any> => ({ ok: true })
    },
    subjectRateLimiter: allowRateLimit(),
    tenantRateLimiter: allowRateLimit(),
    toolSkillManagementProvider: {},
    upstreamGatewayRegistryForMcp: registry,
    ipRateLimiter: allowRateLimit()
  });
  const sockets: any = new Set<any>();
  const server: any = http.createServer(handler);
  server.keepAliveTimeout = 5_000;
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
  return { lifecycle, port, server };
}

function transitRequest(port?: any, operationKey?: any, {
  connection = "close",
  requestByte = "x"
}: Record<string, any> = {}) : any {
  return Buffer.from([
    `POST /api/gateway/v1/transit/response-boundary/${operationKey} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Content-Type: application/octet-stream",
    `Content-Length: ${Buffer.byteLength(requestByte)}`,
    `Connection: ${connection}`,
    "",
    requestByte
  ].join("\r\n"), "latin1");
}

async function rawExchange(port?: any, requestBytes?: any, { timeoutMs = 5_000 }: Record<string, any> = {}) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const chunks: any[] = [];
    let socketError: any = null;
    let settled: any = false;
    const socket: any = net.createConnection({ host: "127.0.0.1", port });
    const timer: any = setTimeout(() : any => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Timed out waiting for the raw downstream exchange."));
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
    socket.setNoDelay(true);
    socket.on("data", (chunk?: any) : any => chunks.push(Buffer.from(chunk)));
    socket.on("error", (error?: any) : any => {
      socketError = error;
    });
    socket.on("close", finish);
    socket.once("connect", () : any => socket.write(requestBytes));
  });
}

function headerValue(headers?: any, name?: any) : any {
  return String(headers[String(name || "").toLowerCase()] || "");
}

function parseResponseHead(bytes?: any, offset?: any) : any {
  const headerOffset: any = bytes.indexOf(HEADER_END, offset);
  if (headerOffset < 0) return null;
  const lines: any = bytes.subarray(offset, headerOffset).toString("latin1").split("\r\n");
  const statusLine: any = String(lines.shift() || "");
  const match: any = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/u.exec(statusLine);
  if (!match) return null;
  const headers: Record<string, any> = {};
  for (const line of lines) {
    const separator: any = line.indexOf(":");
    if (separator <= 0) continue;
    const name: any = line.slice(0, separator).trim().toLowerCase();
    const value: any = line.slice(separator + 1).trim();
    headers[name] = Object.hasOwn(headers, name)
      ? `${headers[name]}, ${value}`
      : value;
  }
  return {
    bodyOffset: headerOffset + HEADER_END.length,
    headers,
    status: Number(match[1]),
    statusLine
  };
}

function parseChunkedBody(bytes?: any, offset?: any) : any {
  const chunks: any[] = [];
  const chunkLines: any[] = [];
  let cursor: any = offset;
  while (cursor < bytes.length) {
    const lineOffset: any = bytes.indexOf(LINE_END, cursor);
    if (lineOffset < 0) {
      return { body: Buffer.concat(chunks), chunkLines, complete: false, offset: bytes.length };
    }
    const chunkLine: any = bytes.subarray(cursor, lineOffset).toString("latin1");
    chunkLines.push(chunkLine);
    const sizeToken: any = chunkLine.split(";", 1)[0].trim();
    if (!/^[0-9a-f]+$/iu.test(sizeToken)) {
      return { body: Buffer.concat(chunks), chunkLines, complete: false, offset: cursor };
    }
    const size: any = Number.parseInt(sizeToken, 16);
    cursor = lineOffset + LINE_END.length;
    if (size === 0) {
      while (cursor <= bytes.length) {
        const trailerOffset: any = bytes.indexOf(LINE_END, cursor);
        if (trailerOffset < 0) {
          return { body: Buffer.concat(chunks), chunkLines, complete: false, offset: bytes.length };
        }
        const trailer: any = bytes.subarray(cursor, trailerOffset);
        cursor = trailerOffset + LINE_END.length;
        if (trailer.length === 0) {
          return { body: Buffer.concat(chunks), chunkLines, complete: true, offset: cursor };
        }
      }
    }
    if (bytes.length < cursor + size + LINE_END.length) {
      return { body: Buffer.concat(chunks), chunkLines, complete: false, offset: bytes.length };
    }
    chunks.push(Buffer.from(bytes.subarray(cursor, cursor + size)));
    cursor += size;
    if (!bytes.subarray(cursor, cursor + LINE_END.length).equals(LINE_END)) {
      return { body: Buffer.concat(chunks), chunkLines, complete: false, offset: cursor };
    }
    cursor += LINE_END.length;
  }
  return { body: Buffer.concat(chunks), chunkLines, complete: false, offset: cursor };
}

function parseRawResponses(bytes?: any) : any {
  const responses: any[] = [];
  let offset: any = 0;
  while (offset < bytes.length) {
    const head: any = parseResponseHead(bytes, offset);
    if (!head) break;
    const transferEncoding: any = headerValue(head.headers, "transfer-encoding").toLowerCase();
    const contentLengthText: any = headerValue(head.headers, "content-length");
    let body: any = Buffer.alloc(0);
    let complete: any = true;
    let nextOffset: any = head.bodyOffset;
    let chunkLines: any[] = [];
    if (head.status >= 100 && head.status < 200) {
      // Informational responses do not carry a message body.
    } else if (transferEncoding.split(",").map((value?: any) : any => value.trim()).includes("chunked")) {
      const chunked: any = parseChunkedBody(bytes, head.bodyOffset);
      body = chunked.body;
      chunkLines = chunked.chunkLines;
      complete = chunked.complete;
      nextOffset = chunked.offset;
    } else if (/^\d+$/u.test(contentLengthText)) {
      const contentLength: any = Number(contentLengthText);
      const available: any = Math.max(0, bytes.length - head.bodyOffset);
      body = Buffer.from(bytes.subarray(
        head.bodyOffset,
        head.bodyOffset + Math.min(contentLength, available)
      ));
      complete = available >= contentLength;
      nextOffset = head.bodyOffset + Math.min(contentLength, available);
    } else {
      body = Buffer.from(bytes.subarray(head.bodyOffset));
      nextOffset = bytes.length;
    }
    responses.push({
      ...head,
      body,
      chunkLines,
      complete,
      offset,
      nextOffset
    });
    if (!complete || nextOffset <= offset) break;
    offset = nextOffset;
  }
  return {
    responses,
    trailing: Buffer.from(bytes.subarray(offset))
  };
}

function expectPrivateTransitBoundary(response?: any, {
  requireHostChunking = false
}: Record<string, any> = {}) : any {
  expect(headerValue(response.headers, "cache-control")).toBe("private, no-store");
  expect(response.headers).not.toHaveProperty("vary");
  expect(response.headers).not.toHaveProperty("upgrade");
  expect(headerValue(response.headers, "connection").toLowerCase()).not.toContain("x-upstream-hop");
  if (requireHostChunking) {
    expect(response.headers).not.toHaveProperty("content-length");
    expect(headerValue(response.headers, "transfer-encoding").toLowerCase()).toBe("chunked");
  }
}

function normalResponse(socket?: any, body: any = "FRESH", {
  cacheControl = "public, max-age=86400",
  connection = "keep-alive",
  contentLength = Buffer.byteLength(body),
  status = 200,
  statusText = "OK",
  vary = "authorization, cookie"
}: Record<string, any> = {}) : any {
  socket.write(Buffer.from([
    `HTTP/1.1 ${status} ${statusText}`,
    "Content-Type: application/octet-stream",
    `Content-Length: ${contentLength}`,
    `Cache-Control: ${cacheControl}`,
    `Vary: ${vary}`,
    `Connection: ${connection}`,
    "",
    body
  ].join("\r\n"), "latin1"));
}

async function waitForDrainOrClose(socket?: any) : Promise<any> {
  return new Promise((resolve?: any) : any => {
    const settle: any = (value?: any) : any => {
      socket.off("close", onClose);
      socket.off("drain", onDrain);
      socket.off("error", onError);
      resolve(value);
    };
    const onClose: any = () : any => settle("closed");
    const onDrain: any = () : any => settle("drain");
    const onError: any = () : any => settle("closed");
    socket.once("close", onClose);
    socket.once("drain", onDrain);
    socket.once("error", onError);
  });
}

async function writeBackpressuredChunkedBody(socket?: any, tracker?: any) : Promise<any> {
  tracker.started = true;
  socket.write(Buffer.from([
    "HTTP/1.1 200 OK",
    "Content-Type: application/octet-stream",
    "Cache-Control: public, max-age=86400",
    "Vary: authorization, cookie",
    "Transfer-Encoding: chunked",
    "Connection: keep-alive",
    "",
    ""
  ].join("\r\n"), "latin1"));
  const payload: any = Buffer.alloc(64 * 1024, 0x61);
  const frame: any = Buffer.concat([
    Buffer.from(`${payload.length.toString(16)}\r\n`, "latin1"),
    payload,
    LINE_END
  ]);
  while (tracker.bytesScheduled < tracker.totalBytes && !socket.destroyed) {
    tracker.bytesScheduled += payload.length;
    if (!socket.write(frame)) {
      tracker.backpressureCount += 1;
      const outcome: any = await waitForDrainOrClose(socket);
      if (outcome !== "drain") return;
    }
  }
  if (!socket.destroyed) {
    socket.write(Buffer.from("0\r\n\r\n", "latin1"));
    tracker.completed = true;
  }
}

async function createFixture() : Promise<any> {
  const slowClosed: any = deferred();
  const slowTracker: Record<string, any> = {
    backpressureCount: 0,
    bytesScheduled: 0,
    completed: false,
    started: false,
    totalBytes: 64 * MEBIBYTE
  };
  const peer: any = await createRawUpstreamPeer(async ({ request, socket }: Record<string, any>) : Promise<any> => {
    const pathname: any = new URL(request.target, "http://upstream.invalid").pathname;
    if (pathname === "/sanitized") {
      socket.write(Buffer.from([
        "HTTP/1.1 200 OK",
        "Content-Type: application/octet-stream",
        "Cache-Control: public, max-age=86400",
        "Vary: authorization, cookie",
        "Connection: keep-alive, x-upstream-hop",
        "X-Upstream-Hop: must-not-cross",
        "Upgrade: h2c",
        "Transfer-Encoding: chunked",
        "",
        "4;upstream-marker=must-not-cross",
        "SAFE",
        "0",
        "X-Upstream-Trailer: must-not-cross",
        "",
        ""
      ].join("\r\n"), "latin1"));
      return;
    }
    if (pathname === "/length-equal") {
      normalResponse(socket, "SAFE");
      return;
    }
    if (pathname === "/length-smaller") {
      socket.end(Buffer.from([
        "HTTP/1.1 200 OK",
        "Content-Type: application/octet-stream",
        "Content-Length: 4",
        "Cache-Control: public, max-age=86400",
        "Vary: authorization, cookie",
        "Connection: keep-alive",
        "",
        "SAFE",
        "HTTP/1.1 200 Smuggled",
        "Content-Length: 6",
        "X-Smuggled: must-not-cross",
        "",
        "POISON"
      ].join("\r\n"), "latin1"));
      return;
    }
    if (pathname === "/length-larger") {
      socket.end(Buffer.from([
        "HTTP/1.1 200 OK",
        "Content-Type: application/octet-stream",
        "Content-Length: 12",
        "Cache-Control: public, max-age=86400",
        "Vary: authorization, cookie",
        "Connection: keep-alive",
        "",
        "CUT"
      ].join("\r\n"), "latin1"));
      return;
    }
    if (pathname === "/status-599") {
      normalResponse(socket, "LIMIT", {
        status: 599,
        statusText: "Upstream Limit"
      });
      return;
    }
    if (pathname === "/status-600") {
      normalResponse(socket, "BAD", {
        status: 600,
        statusText: "Invalid Final"
      });
      return;
    }
    if (pathname === "/status-101") {
      socket.end(Buffer.from([
        "HTTP/1.1 101 Switching Protocols",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "",
        "UPGRADED-BYTES"
      ].join("\r\n"), "latin1"));
      return;
    }
    if (pathname === "/status-103") {
      socket.end(Buffer.from([
        "HTTP/1.1 103 Early Hints",
        "Link: </private.css>; rel=preload",
        "",
        ""
      ].join("\r\n"), "latin1"));
      return;
    }
    if (pathname === "/oversized") {
      socket.write(Buffer.from([
        "HTTP/1.1 200 OK",
        "Content-Type: application/octet-stream",
        "Cache-Control: public, max-age=86400",
        "Vary: authorization, cookie",
        "Transfer-Encoding: chunked",
        "Connection: keep-alive",
        "",
        "8",
        "12345678",
        "1",
        "X",
        "0",
        "",
        ""
      ].join("\r\n"), "latin1"));
      return;
    }
    if (pathname === "/slow") {
      socket.once("close", () : any => slowClosed.resolve());
      await writeBackpressuredChunkedBody(socket, slowTracker);
      return;
    }
    normalResponse(socket, "FRESH");
  });
  const registry: any = createUpstreamGatewayRegistry();
  cleanup.push(() : any => registry.close());
  const ordinaryOperations: any = [
    "sanitized",
    "length-equal",
    "length-smaller",
    "length-larger",
    "status-599",
    "status-600",
    "status-101",
    "status-103",
    "healthy"
  ].map((operationKey?: any) : any => operationFixture(operationKey));
  installUpstreamRuntimeServices(registry, [{
    serviceId: "response-boundary",
    serviceProtocol: "http",
    baseUrl: `http://127.0.0.1:${peer.port}`,
    allowLocalNetwork: true,
    operations: [
      ...ordinaryOperations,
      operationFixture("oversized", 8),
      operationFixture("slow", 128 * MEBIBYTE)
    ]
  }]);
  const gateway: any = await createGatewayServer(registry);
  return {
    gateway,
    peer,
    registry,
    slowClosed,
    slowTracker
  };
}

async function healthyControl(port?: any) : Promise<any> {
  const exchange: any = await rawExchange(port, transitRequest(port, "healthy"));
  const parsed: any = parseRawResponses(exchange.bytes);
  expect(parsed.responses).toHaveLength(1);
  expect(parsed.responses[0]).toMatchObject({ complete: true, status: 200 });
  expect(parsed.responses[0].body.toString("utf8")).toBe("FRESH");
  expectPrivateTransitBoundary(parsed.responses[0]);
  return parsed.responses[0];
}

afterEach(async () : Promise<any> => {
  while (cleanup.length > 0) {
    await cleanup.pop()();
  }
});

describe("authorized gateway.payload.transit upstream stream response boundary", () : any => {
  it("removes upstream framing, hop, cache, and vary authority before host-owned HTTP/1 framing", async () : Promise<any> => {
    const { gateway, peer } = await createFixture();
    const requests: any = Buffer.concat([
      transitRequest(gateway.port, "sanitized", { connection: "keep-alive" }),
      transitRequest(gateway.port, "healthy")
    ]);

    const exchange: any = await rawExchange(gateway.port, requests);
    const parsed: any = parseRawResponses(exchange.bytes);

    expect(parsed.responses).toHaveLength(2);
    expect(parsed.responses[0]).toMatchObject({ complete: true, status: 200 });
    expect(parsed.responses[0].body.toString("utf8")).toBe("SAFE");
    expect(parsed.responses[1]).toMatchObject({ complete: true, status: 200 });
    expect(parsed.responses[1].body.toString("utf8")).toBe("FRESH");
    expectPrivateTransitBoundary(parsed.responses[0], { requireHostChunking: true });
    expectPrivateTransitBoundary(parsed.responses[1]);
    const rawText: any = exchange.bytes.toString("latin1").toLowerCase();
    expect(rawText).not.toContain("upstream-marker");
    expect(rawText).not.toContain("x-upstream-hop");
    expect(rawText).not.toContain("x-upstream-trailer");
    expect(rawText).not.toContain("upgrade: h2c");
    expect(peer.requests.map((request?: any) : any => request.target)).toEqual(expect.arrayContaining([
      "/sanitized",
      "/healthy"
    ]));
  });

  it("isolates smaller, equal, and larger upstream length declarations from downstream keep-alive framing", async () : Promise<any> => {
    const { gateway } = await createFixture();

    const equal: any = await rawExchange(gateway.port, Buffer.concat([
      transitRequest(gateway.port, "length-equal", { connection: "keep-alive" }),
      transitRequest(gateway.port, "healthy")
    ]));
    const equalParsed: any = parseRawResponses(equal.bytes);
    expect(equalParsed.responses).toHaveLength(2);
    expect(equalParsed.responses[0]).toMatchObject({ complete: true, status: 200 });
    expect(equalParsed.responses[0].body.toString("utf8")).toBe("SAFE");
    expect(equalParsed.responses[1]).toMatchObject({ complete: true, status: 200 });
    expect(equalParsed.responses[1].body.toString("utf8")).toBe("FRESH");
    expectPrivateTransitBoundary(equalParsed.responses[0], { requireHostChunking: true });

    const smaller: any = await rawExchange(gateway.port, Buffer.concat([
      transitRequest(gateway.port, "length-smaller", { connection: "keep-alive" }),
      transitRequest(gateway.port, "healthy")
    ]));
    const smallerParsed: any = parseRawResponses(smaller.bytes);
    const smallerText: any = smaller.bytes.toString("latin1").toLowerCase();
    expect(smallerParsed.responses.length).toBeGreaterThanOrEqual(1);
    expect(smallerParsed.responses.length).toBeLessThanOrEqual(2);
    expect([200, 502]).toContain(smallerParsed.responses[0].status);
    expect(smallerParsed.responses[0].headers).not.toHaveProperty("content-length");
    expectPrivateTransitBoundary(smallerParsed.responses[0]);
    expect(smallerText).not.toContain("x-smuggled");
    expect(smallerText).not.toContain("poison");
    if (smallerParsed.responses[0].status === 200) {
      expect(smallerParsed.responses[0].body.toString("utf8")).toBe("SAFE");
    }
    if (smallerParsed.responses.length === 2) {
      expect(smallerParsed.responses[1]).toMatchObject({ complete: true, status: 200 });
      expect(smallerParsed.responses[1].body.toString("utf8")).toBe("FRESH");
    }
    await healthyControl(gateway.port);

    const larger: any = await rawExchange(gateway.port, Buffer.concat([
      transitRequest(gateway.port, "length-larger", { connection: "keep-alive" }),
      transitRequest(gateway.port, "healthy")
    ]));
    const largerParsed: any = parseRawResponses(larger.bytes);
    expect(largerParsed.responses.length).toBeGreaterThanOrEqual(1);
    expect(largerParsed.responses[0].headers).not.toHaveProperty("content-length");
    expectPrivateTransitBoundary(largerParsed.responses[0]);
    expect(larger.bytes.toString("latin1")).not.toContain("FRESH");
    await healthyControl(gateway.port);
  });

  it("accepts only final 200-599 responses and never exposes 1xx, upgrade, or status 600", async () : Promise<any> => {
    const { gateway } = await createFixture();

    const accepted: any = await rawExchange(
      gateway.port,
      transitRequest(gateway.port, "status-599")
    );
    const acceptedParsed: any = parseRawResponses(accepted.bytes);
    expect(acceptedParsed.responses).toHaveLength(1);
    expect(acceptedParsed.responses[0]).toMatchObject({ complete: true, status: 599 });
    expect(acceptedParsed.responses[0].body.toString("utf8")).toBe("LIMIT");
    expectPrivateTransitBoundary(acceptedParsed.responses[0]);

    for (const operationKey of ["status-600", "status-101", "status-103"]) {
      const rejected: any = await rawExchange(
        gateway.port,
        transitRequest(gateway.port, operationKey)
      );
      const rejectedParsed: any = parseRawResponses(rejected.bytes);
      expect(rejectedParsed.responses).toHaveLength(1);
      expect(rejectedParsed.responses[0]).toMatchObject({ complete: true, status: 502 });
      expectPrivateTransitBoundary(rejectedParsed.responses[0]);
      expect(rejectedParsed.responses[0].headers).not.toHaveProperty("upgrade");
      expect(rejected.bytes.toString("latin1")).not.toMatch(
        /HTTP\/1\.[01]\s+(?:101|103|600)\b/u
      );
    }
  });

  it("enforces the actual streamed-byte ceiling and closes an incomplete response before reuse", async () : Promise<any> => {
    const { gateway } = await createFixture();
    const oversized: any = await rawExchange(
      gateway.port,
      transitRequest(gateway.port, "oversized", { connection: "keep-alive" })
    );
    const parsed: any = parseRawResponses(oversized.bytes);

    expect(parsed.responses).toHaveLength(1);
    expect(parsed.responses[0].status).toBe(200);
    expect(parsed.responses[0].complete).toBe(false);
    expect(parsed.responses[0].body.byteLength).toBeLessThanOrEqual(8);
    expect(parsed.responses[0].body.toString("utf8")).not.toContain("X");
    expectPrivateTransitBoundary(parsed.responses[0], { requireHostChunking: true });
    await healthyControl(gateway.port);
  });

  it("propagates downstream backpressure and cancellation, closes upstream, and releases the traffic slot", async () : Promise<any> => {
    const { gateway, slowClosed, slowTracker } = await createFixture();
    const downstream: any = net.createConnection({
      host: "127.0.0.1",
      port: gateway.port
    });
    downstream.on("error", () : any => {});
    downstream.pause();
    await new Promise((resolve?: any, reject?: any) : any => {
      downstream.once("connect", resolve);
      downstream.once("error", reject);
    });
    downstream.write(transitRequest(gateway.port, "slow", { connection: "keep-alive" }));

    await waitFor(() : any => slowTracker.started, { label: "upstream response start" });
    await waitFor(
      () : any => slowTracker.backpressureCount > 0,
      { label: "real upstream socket backpressure" }
    );
    const scheduledAtBackpressure: any = slowTracker.bytesScheduled;
    await delay(150);
    expect(slowTracker.completed).toBe(false);
    expect(slowTracker.bytesScheduled).toBeLessThan(slowTracker.totalBytes);
    expect(slowTracker.bytesScheduled - scheduledAtBackpressure).toBeLessThan(8 * MEBIBYTE);

    downstream.destroy();
    await withTimeout(slowClosed.promise, 3_000, "upstream cancellation");
    await healthyControl(gateway.port);
  }, 15_000);
});
