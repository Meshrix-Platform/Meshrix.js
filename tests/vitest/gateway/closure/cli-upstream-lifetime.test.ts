import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRpc, StdioPeerTransport } from "../../../../apps/mcp-gateway-installer/src/upstream-transport.ts";
import { assertPeerReady, readHttpPeerPort } from "./cli-fixture-readiness.ts";

const sleepForFilePoll = setTimeout;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if (!isMissingFile(error)) throw error;
      await new Promise((resolve) => sleepForFilePoll(resolve, 10));
    }
  }
  throw new Error("The controlled stdio peer did not write its fixture marker.");
}

function withTestWatchdog<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The controlled transport did not settle.")), timeoutMs); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function assertTransportPeerReady(transport: StdioPeerTransport, marker: string, requestId: string): Promise<void> {
  const readiness = await withTestWatchdog(transport.send({ request: { jsonrpc: "2.0", id: requestId, method: "fixture/ready" } }), 5_000);
  expect(readiness.body).toMatchObject({ id: requestId, result: { ready: true } });
  assertPeerReady(await waitForFile(`${marker}.ready`));
}

const controlledPeer = `
const fs = require("node:fs");
const marker = process.argv[1];
function publishFile(target, value) {
  const pending = target + ".writing";
  fs.writeFileSync(pending, value);
  fs.renameSync(pending, target);
}
function reply(message, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
let buffered = "";
const held = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "fixture/ready") {
      publishFile(marker + ".ready", "ready");
      reply(message, { ready: true });
      continue;
    }
    if (message.method === "fixture/release") {
      const requestId = String(message.params?.requestId ?? "");
      const pending = held.get(requestId);
      if (pending) {
        held.delete(requestId);
        reply(pending, { source: "controlled-peer" });
      }
      reply(message, { released: Boolean(pending) });
      continue;
    }
    if (message.method === "fixture/signal-exit") {
      if (message.params?.signal !== "SIGUSR2" && message.params?.signal !== "SIGTERM") throw new Error("Unsupported fixture self-signal.");
      process.kill(process.pid, message.params.signal);
      continue;
    }
    held.set(String(message.id), message);
    const pending = marker + ".request.writing";
    fs.writeFileSync(pending, String(message.id));
    fs.renameSync(pending, marker + ".request");
  }
});
`;

const floodAfterInvalidPeer = `
const fs = require("node:fs");
const marker = process.argv[1];
function publishFile(target, value) {
  const pending = target + ".writing";
  fs.writeFileSync(pending, value);
  fs.renameSync(pending, target);
}
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "fixture/ready") {
      publishFile(marker + ".ready", "ready");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ready: true } }) + "\\n");
      continue;
    }
    const pending = marker + ".request.writing";
    fs.writeFileSync(pending, String(message.id));
    fs.renameSync(pending, marker + ".request");
    process.stdout.write("not-json\\n");
    setInterval(() => process.stdout.write("x".repeat(32 * 1024)), 10);
  }
});
process.on("SIGTERM", () => publishFile(marker + ".term", "seen"));
`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("standalone upstream transport lifetimes", () => {
  it("accepts only complete fixture readiness records and valid HTTP listener ports", () => {
    expect(() => assertPeerReady("ready")).not.toThrow();
    for (const value of ["", "rea", "ready\n"]) expect(() => assertPeerReady(value)).toThrow();

    expect(readHttpPeerPort('{"port":4123}')).toBe(4123);
    for (const value of ["", "{", '{"port":0}', '{"port":65536}', '{"port":4123,"host":"127.0.0.1"}']) {
      expect(() => readHttpPeerPort(value)).toThrow();
    }
  });

  it("keeps an HTTP call pending beyond the retired operation limit and completes it normally", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = deferred<Response>();
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let settled = false;
    const pending = fetchRpc("http://127.0.0.1:4123/mcp", { jsonrpc: "2.0", id: "long-call" }, {}).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);
    expect(timeout).not.toHaveBeenCalled();

    response.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: "long-call", result: { ok: true } }), { status: 200 }));
    await expect(pending).resolves.toMatchObject({ status: 200, body: { result: { ok: true } } });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: undefined, redirect: "manual" });
  });

  it("passes caller cancellation through HTTP without combining it with a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let receivedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      receivedSignal = init.signal;
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchRpc("http://127.0.0.1:4123/mcp", { jsonrpc: "2.0", id: "cancel-call" }, {}, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal).toBe(controller.signal);
    expect(timeout).not.toHaveBeenCalled();
  });

  it("keeps a stdio request pending beyond the retired limit, then clears it on response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-lifetime-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, marker] });
    let closePromise: Promise<void> | undefined;
    const closeTransport = () => closePromise ??= transport.close();
    try {
      await assertTransportPeerReady(transport, marker, "fixture-ready");

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      const pending = transport.send({ request: { jsonrpc: "2.0", id: "long-stdio-call", method: "tools/call" } }).then((value) => {
        settled = true;
        return value;
      });
      await waitForFile(`${marker}.request`);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      const release = transport.send({ request: { jsonrpc: "2.0", id: "release-long-call", method: "fixture/release", params: { requestId: "long-stdio-call" } } });
      await expect(release).resolves.toMatchObject({ body: { id: "release-long-call", result: { released: true } } });
      await expect(pending).resolves.toMatchObject({ status: 200, body: { id: "long-stdio-call", result: { source: "controlled-peer" } } });

      await rm(`${marker}.request`, { force: true });
      const reusedId = transport.send({ request: { jsonrpc: "2.0", id: "long-stdio-call", method: "tools/call" } });
      await waitForFile(`${marker}.request`);
      const releaseReused = transport.send({ request: { jsonrpc: "2.0", id: "release-reused-call", method: "fixture/release", params: { requestId: "long-stdio-call" } } });
      await expect(releaseReused).resolves.toMatchObject({ body: { id: "release-reused-call", result: { released: true } } });
      await expect(reusedId).resolves.toMatchObject({ status: 200, body: { id: "long-stdio-call" } });
    } finally {
      vi.useRealTimers();
      try { await closeTransport(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  it("settles an aborted stdio waiter once, removes its listener, and releases the request id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-abort-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, marker] });
    let closePromise: Promise<void> | undefined;
    const closeTransport = () => closePromise ??= transport.close();
    try {
      await assertTransportPeerReady(transport, marker, "fixture-ready");

      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const request = { jsonrpc: "2.0", id: "reusable-id", method: "tools/call" };
      let settlementCount = 0;
      const pending = transport.send({ request, signal: controller.signal }).then(
        (value) => { settlementCount += 1; return value; },
        (error: unknown) => { settlementCount += 1; throw error; }
      );
      await waitForFile(`${marker}.request`);
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: "gateway_stdio_cancelled" });
      expect(settlementCount).toBe(1);
      const attachedAbort = addListener.mock.calls[0]?.[1];
      expect(typeof attachedAbort).toBe("function");
      expect(removeListener).toHaveBeenCalledWith("abort", attachedAbort);

      await rm(`${marker}.request`, { force: true });
      const retry = transport.send({ request });
      await waitForFile(`${marker}.request`);
      const release = transport.send({ request: { jsonrpc: "2.0", id: "release-retry", method: "fixture/release", params: { requestId: "reusable-id" } } });
      await expect(release).resolves.toMatchObject({ body: { id: "release-retry", result: { released: true } } });
      await expect(retry).resolves.toMatchObject({ status: 200, body: { id: "reusable-id" } });
    } finally {
      try { await closeTransport(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  it("keeps a ready peer isolated when a concurrent peer exits before readiness", async () => {
    const survivorDirectory = await mkdtemp(join(tmpdir(), "meshrix-upstream-survivor-"));
    const failedDirectory = await mkdtemp(join(tmpdir(), "meshrix-upstream-early-exit-"));
    const survivorMarker = join(survivorDirectory, "peer");
    const failedMarker = join(failedDirectory, "peer");
    const survivor = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, survivorMarker] });
    const failed = new StdioPeerTransport({ command: process.execPath, args: ["-e", "process.exit(9)"] });
    let closeSurvivorPromise: Promise<void> | undefined;
    let closeFailedPromise: Promise<void> | undefined;
    const closeSurvivor = () => closeSurvivorPromise ??= survivor.close();
    const closeFailed = () => closeFailedPromise ??= failed.close();
    try {
      await assertTransportPeerReady(survivor, survivorMarker, "survivor-ready");
      await expect(assertTransportPeerReady(failed, failedMarker, "early-exit-ready")).rejects.toMatchObject({ code: "gateway_stdio_lost" });

      const survivorCall = survivor.send({ request: { jsonrpc: "2.0", id: "survivor-call", method: "tools/call" } });
      await waitForFile(`${survivorMarker}.request`);
      const release = survivor.send({ request: { jsonrpc: "2.0", id: "survivor-release", method: "fixture/release", params: { requestId: "survivor-call" } } });
      await expect(release).resolves.toMatchObject({ body: { id: "survivor-release", result: { released: true } } });
      await expect(survivorCall).resolves.toMatchObject({ body: { id: "survivor-call", result: { source: "controlled-peer" } } });
    } finally {
      try { await Promise.all([closeSurvivor(), closeFailed()]); }
      finally { await Promise.all([rm(survivorDirectory, { recursive: true, force: true }), rm(failedDirectory, { recursive: true, force: true })]); }
    }
  });

  it("settles pending stdio requests when the peer exits on its own signal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-peer-failure-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, marker] });
    let closePromise: Promise<void> | undefined;
    const closeTransport = () => closePromise ??= transport.close();
    try {
      await assertTransportPeerReady(transport, marker, "fixture-ready");

      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const pending = transport.send({ request: { jsonrpc: "2.0", id: "peer-failure", method: "tools/call" }, signal: controller.signal });
      const pendingError = expect(pending).rejects.toMatchObject({ code: "gateway_stdio_lost" });
      await waitForFile(`${marker}.request`);
      const signalExit = transport.send({ request: { jsonrpc: "2.0", id: "signal-peer", method: "fixture/signal-exit", params: { signal: "SIGUSR2" } } });
      const signalError = expect(signalExit).rejects.toMatchObject({ code: "gateway_stdio_lost" });

      await Promise.all([pendingError, signalError]);
      const attachedAbort = addListener.mock.calls[0]?.[1];
      expect(typeof attachedAbort).toBe("function");
      expect(removeListener).toHaveBeenCalledWith("abort", attachedAbort);
      await expect(transport.send({ request: { jsonrpc: "2.0", id: "after-peer-failure", method: "tools/call" } })).rejects.toMatchObject({ code: "gateway_stdio_lost" });
    } finally {
      try { await closeTransport(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  it("treats signalCode as exit and does not wait for a second exit event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-signal-exit-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, marker] });
    let closePromise: Promise<void> | undefined;
    const closeTransport = () => closePromise ??= transport.close();
    try {
      await assertTransportPeerReady(transport, marker, "fixture-ready");

      const pending = transport.send({ request: { jsonrpc: "2.0", id: "signal-exit", method: "tools/call" } });
      const pendingError = expect(pending).rejects.toMatchObject({ code: "gateway_stdio_lost" });
      await waitForFile(`${marker}.request`);
      const signalExit = transport.send({ request: { jsonrpc: "2.0", id: "signal-peer", method: "fixture/signal-exit", params: { signal: "SIGTERM" } } });
      const signalError = expect(signalExit).rejects.toMatchObject({ code: "gateway_stdio_lost" });
      await Promise.all([pendingError, signalError]);
      await expect(withTestWatchdog(closeTransport(), 1_500)).resolves.toBeUndefined();
    } finally {
      try { await closeTransport(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  it("stops retaining peer output after protocol failure and closes the ignoring child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-invalid-output-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", floodAfterInvalidPeer, marker] });
    let closePromise: Promise<void> | undefined;
    const closeTransport = () => closePromise ??= transport.close();
    try {
      await assertTransportPeerReady(transport, marker, "fixture-ready");

      const pending = transport.send({ request: { jsonrpc: "2.0", id: "invalid-output", method: "tools/call" } });
      const pendingError = expect(pending).rejects.toMatchObject({ code: "gateway_stdio_invalid" });
      await waitForFile(`${marker}.request`);
      await pendingError;
      expect(await withTestWatchdog(waitForFile(`${marker}.term`), 1_000)).toBe("seen");
      await expect(withTestWatchdog(closeTransport(), 2_500)).resolves.toBeUndefined();
    } finally {
      try { await closeTransport(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
