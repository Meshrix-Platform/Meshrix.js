import { spawn, type ChildProcess } from "node:child_process";
import { createServer, get as httpGet, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { modernHttpRequest } from "../support.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (hasExited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve({ code, signal });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("CLI did not exit through graceful shutdown before the test watchdog."));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function withWatchdog<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function waitForListenerClose(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const request = httpGet(new URL("/health", endpoint), { headers: { Connection: "close" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(true));
      });
      request.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve(false);
        else reject(error);
      });
    });
    if (!listening) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("CLI listener remained open after SIGTERM.");
}

async function openPartialRequest(endpoint: string, wire: ReturnType<typeof modernHttpRequest>): Promise<{ socket: Socket; closed: Promise<void> }> {
  const target = new URL(endpoint);
  const payload = JSON.stringify(wire.body);
  const headers = [
    `POST ${target.pathname} HTTP/1.1`,
    `Host: ${target.host}`,
    ...Object.entries(wire.headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${Buffer.byteLength(payload) + 32}`,
    "Expect: 100-continue",
    "Connection: keep-alive",
    "",
    ""
  ].join("\r\n");
  const socket = connectTcp(Number(target.port), target.hostname);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let received = "";
    const timeout = setTimeout(() => fail(new Error("CLI did not accept the partial-body fixture.")), 1_000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString("latin1");
      if (!received.includes("HTTP/1.1 100 Continue\r\n\r\n")) return;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.write(payload.slice(0, Math.ceil(payload.length / 2)));
      resolve();
    };
    socket.once("error", fail);
    socket.on("data", onData);
    socket.once("connect", () => socket.write(headers));
  });
  return { socket, closed };
}

interface GatewayFixture {
  readonly child: ChildProcess;
  readonly endpoint: string;
  readonly peer: Server;
  readonly callStarted: Promise<void>;
  readonly releaseToolCall: () => void;
  readonly toolCallCount: () => number;
  readonly stderr: () => string;
  close(): Promise<void>;
}

async function startFixture(holdToolCall = false): Promise<GatewayFixture> {
  const callStarted = deferred<void>();
  const release = deferred<void>();
  const stderrChunks: string[] = [];
  let toolCalls = 0;
  let child: ChildProcess | undefined;
  let closed = false;
  const peer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const wire = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string | number; method: string };
    if (wire.method === "tools/call") {
      toolCalls += 1;
      callStarted.resolve();
      if (holdToolCall) await release.promise;
    }
    if (response.destroyed) return;
    const result = wire.method === "server/discover"
      ? { resultType: "complete", supportedVersions: ["2026-07-28"] }
      : wire.method === "tools/list"
        ? { resultType: "complete", tools: [{ name: "synthetic", inputSchema: { type: "object" } }] }
        : wire.method === "tools/call"
          ? { resultType: "complete", content: [{ type: "text", text: "completed" }] }
          : { resultType: "complete", resources: [], resourceTemplates: [], prompts: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result }));
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(0, "127.0.0.1", resolve); });
  const directory = await mkdtemp(join(tmpdir(), "meshrix-cli-shutdown-"));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Synthetic peer has no TCP address.");
  const config = join(directory, "gateway.json");
  await writeFile(config, JSON.stringify({ profile: "local", services: [{ serviceId: "synthetic", baseUrl: `http://127.0.0.1:${address.port}/mcp`, toolRisk: { synthetic: "read" } }] }));
  const installed = process.env.MESHRIX_TEST_INSTALLED_GATEWAY_ENTRY;
  child = spawn(process.execPath, [...(installed ? [] : ["--conditions=source"]), installed ?? join(repo, "apps/mcp-gateway-installer/src/cli.ts"), "serve", "--config", config], {
    cwd: installed ? dirname(installed) : repo,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  const liveChild = child;
  const close = async () => {
    if (closed) return;
    closed = true;
    release.resolve();
    if (!hasExited(liveChild)) {
      liveChild.kill("SIGKILL");
      await waitForExit(liveChild, 1_000).catch(() => undefined);
    }
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CLI readiness watchdog expired.")), 10_000);
      liveChild.once("exit", () => { clearTimeout(timeout); reject(new Error("CLI exited before readiness.")); });
      let output = "";
      liveChild.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const line = output.split("\n")[0];
        if (!line.endsWith("}")) return;
        clearTimeout(timeout);
        resolve(JSON.parse(line).interopEndpoint as string);
      });
    });
    return { child: liveChild, endpoint, peer, callStarted: callStarted.promise, releaseToolCall: () => release.resolve(), toolCallCount: () => toolCalls, stderr: () => stderrChunks.join(""), close };
  } catch (error) {
    await close();
    throw error;
  }
}

const fixtures: GatewayFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });

describe("standalone gateway graceful HTTP shutdown", () => {
  it("ends a held subscriptions/listen stream on SIGTERM and tolerates a repeated signal", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const wire = modernHttpRequest("subscriptions/listen", "shutdown-subscription", { notifications: { toolsListChanged: true } });
    const response = await fetch(fixture.endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader!.read()).done).toBe(false);

    fixture.child.kill("SIGTERM");
    fixture.child.kill("SIGINT");
    await waitForListenerClose(fixture.endpoint, 1_000);
    const streamEnd = await withWatchdog(reader!.read(), "SSE response did not end after gateway close.", 1_000);
    expect(streamEnd.done).toBe(true);
    const exit = await waitForExit(fixture.child, 2_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(fixture.stderr()).not.toMatch(/UnhandledPromiseRejection|uncaughtException/u);
  }, 8_000);

  it("allows a held in-flight operation to complete after the listener stops accepting work", async () => {
    const fixture = await startFixture(true);
    fixtures.push(fixture);
    const wire = modernHttpRequest("tools/call", "shutdown-in-flight", { name: "synthetic", arguments: {} });
    const pendingResponse = fetch(fixture.endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) });
    await fixture.callStarted;

    fixture.child.kill("SIGTERM");
    await waitForListenerClose(fixture.endpoint, 2_000);
    fixture.releaseToolCall();

    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { content: [{ type: "text", text: "completed" }] } });
    expect(await waitForExit(fixture.child, 5_000)).toEqual({ code: 0, signal: null });
    expect(fixture.stderr()).not.toMatch(/UnhandledPromiseRejection|uncaughtException/u);
  }, 10_000);

  it("keeps the completed-request path and normal SIGTERM exit intact", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const wire = modernHttpRequest("tools/list", "completed-before-shutdown");
    const response = await fetch(fixture.endpoint, { method: wire.method, headers: wire.headers, body: JSON.stringify(wire.body) });
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "synthetic" })]));

    fixture.child.kill("SIGTERM");
    expect(await waitForExit(fixture.child, 2_000)).toEqual({ code: 0, signal: null });
    expect(fixture.stderr()).not.toMatch(/UnhandledPromiseRejection|uncaughtException/u);
  }, 8_000);

  it("closes an incomplete POST body on SIGTERM without dispatching it", async () => {
    const fixture = await startFixture();
    fixtures.push(fixture);
    const wire = modernHttpRequest("tools/call", "partial-body", { name: "synthetic", arguments: {} });
    const partial = await openPartialRequest(fixture.endpoint, wire);
    try {
      fixture.child.kill("SIGTERM");
      expect(await waitForExit(fixture.child, 2_000)).toEqual({ code: 0, signal: null });
      await withWatchdog(partial.closed, "The incomplete HTTP request socket did not close on shutdown.", 1_000);
      expect(fixture.toolCallCount()).toBe(0);
      expect(fixture.stderr()).not.toMatch(/UnhandledPromiseRejection|uncaughtException/u);
    } finally {
      partial.socket.destroy();
    }
  }, 8_000);
});
