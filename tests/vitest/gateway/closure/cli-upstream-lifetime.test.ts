import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRpc, StdioPeerTransport } from "../../../../apps/mcp-gateway-installer/src/upstream-transport.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitForFile(path: string): Promise<string> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    try { return await readFile(path, "utf8"); }
    catch { await new Promise<void>((resolve) => setImmediate(resolve)); }
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

const controlledPeer = `
const fs = require("node:fs");
const marker = process.argv[1];
fs.writeFileSync(marker + ".pid", String(process.pid));
let buffered = "";
let current;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (!line) continue;
    current = JSON.parse(line);
    if (current.id !== undefined) fs.writeFileSync(marker + ".request", String(current.id));
  }
});
process.on("SIGUSR1", () => {
  if (!current || current.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: current.id, result: { source: "controlled-peer" } }) + "\\n");
  current = undefined;
});
process.on("SIGUSR2", () => process.exit(7));
process.on("SIGTERM", () => process.exit(0));
`;

const signalTerminatedPeer = `
const fs = require("node:fs");
const marker = process.argv[1];
fs.writeFileSync(marker + ".pid", String(process.pid));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (line) fs.writeFileSync(marker + ".request", JSON.parse(line).id);
  }
});
`;

const floodAfterInvalidPeer = `
const fs = require("node:fs");
const marker = process.argv[1];
fs.writeFileSync(marker + ".pid", String(process.pid));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffered += chunk;
  let boundary;
  while ((boundary = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    if (!line) continue;
    process.stdout.write("not-json\\n");
    setInterval(() => process.stdout.write("x".repeat(32 * 1024)), 10);
  }
});
process.on("SIGTERM", () => fs.writeFileSync(marker + ".term", "seen"));
`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("standalone upstream transport lifetimes", () => {
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
    try {
      const pid = Number(await waitForFile(`${marker}.pid`));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      const pending = transport.send({ request: { jsonrpc: "2.0", id: "long-stdio-call", method: "tools/call" } }).then((value) => {
        settled = true;
        return value;
      });
      await waitForFile(`${marker}.request`);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      process.kill(pid, "SIGUSR1");
      await expect(pending).resolves.toMatchObject({ status: 200, body: { id: "long-stdio-call", result: { source: "controlled-peer" } } });

      await rm(`${marker}.request`, { force: true });
      const reusedId = transport.send({ request: { jsonrpc: "2.0", id: "long-stdio-call", method: "tools/call" } });
      await waitForFile(`${marker}.request`);
      process.kill(pid, "SIGUSR1");
      await expect(reusedId).resolves.toMatchObject({ status: 200, body: { id: "long-stdio-call" } });
    } finally {
      vi.useRealTimers();
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles an aborted stdio waiter once, removes its listener, and releases the request id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-abort-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, marker] });
    try {
      const pid = Number(await waitForFile(`${marker}.pid`));
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
      process.kill(pid, "SIGUSR1");
      await expect(retry).resolves.toMatchObject({ status: 200, body: { id: "reusable-id" } });
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles pending stdio requests and removes their listeners when the peer exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-peer-failure-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", controlledPeer, marker] });
    try {
      const pid = Number(await waitForFile(`${marker}.pid`));
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const pending = transport.send({ request: { jsonrpc: "2.0", id: "peer-failure", method: "tools/call" }, signal: controller.signal });
      await waitForFile(`${marker}.request`);
      process.kill(pid, "SIGUSR2");

      await expect(pending).rejects.toMatchObject({ code: "gateway_stdio_lost" });
      const attachedAbort = addListener.mock.calls[0]?.[1];
      expect(typeof attachedAbort).toBe("function");
      expect(removeListener).toHaveBeenCalledWith("abort", attachedAbort);
      await expect(transport.send({ request: { jsonrpc: "2.0", id: "after-peer-failure", method: "tools/call" } })).rejects.toMatchObject({ code: "gateway_stdio_lost" });
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats signalCode as exit and does not wait for a second exit event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-signal-exit-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", signalTerminatedPeer, marker] });
    try {
      const pid = Number(await waitForFile(`${marker}.pid`));
      const pending = transport.send({ request: { jsonrpc: "2.0", id: "signal-exit", method: "tools/call" } });
      await waitForFile(`${marker}.request`);
      process.kill(pid, "SIGTERM");
      await expect(pending).rejects.toMatchObject({ code: "gateway_stdio_lost" });
      await expect(withTestWatchdog(transport.close(), 1_500)).resolves.toBeUndefined();
    } finally {
      await withTestWatchdog(transport.close(), 1_500).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops retaining peer output after protocol failure and closes the ignoring child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meshrix-upstream-invalid-output-"));
    const marker = join(directory, "peer");
    const transport = new StdioPeerTransport({ command: process.execPath, args: ["-e", floodAfterInvalidPeer, marker] });
    try {
      const pending = transport.send({ request: { jsonrpc: "2.0", id: "invalid-output", method: "tools/call" } });
      await waitForFile(`${marker}.pid`);
      await expect(pending).rejects.toMatchObject({ code: "gateway_stdio_invalid" });
      expect(await withTestWatchdog(waitForFile(`${marker}.term`), 1_000)).toBe("seen");
      await expect(withTestWatchdog(transport.close(), 2_500)).resolves.toBeUndefined();
    } finally {
      await withTestWatchdog(transport.close(), 2_500).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
