import { afterEach, describe, expect, it, vi } from "vitest";
import { createModernDownstreamAdapter } from "../../../../packages/protocols/mcp/modern-downstream/index.ts";
import { standardHttpResult } from "../../../../packages/protocols/mcp/modern-downstream/standard-http.ts";
import { disconnectMcpGrantSessions } from "../../../../packages/protocols/mcp/notifications.ts";
import { context, descriptor } from "../support.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.useRealTimers(); });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
function fixture(options: Record<string, any> = {}) {
  const invoke = vi.fn(async (_context: unknown, _invocation: any) => ({ kind: "complete", value: { content: [{ type: "text", text: "ok" }] } }));
  const auth = vi.fn(async () => ({ ...context, grant: { ...context.grant, id: "synthetic-standard-http-grant" } }));
  const adapter = createModernDownstreamAdapter({ gateway: { catalog: () => ({ items: [descriptor()] }), invoke } as any, authenticate: auth, ...options });
  cleanup.push(() => adapter.close());
  const request = (message: any, session = "", headers: Record<string, any> = {}, signal?: AbortSignal) => adapter.handle({
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" } : {}), ...headers }, body: message, signal
  });
  const initialize = (version = "2025-11-25") => request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } });
  const initialized = (session: string) => request({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const call = (id: string | number, session: string) => request({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "demo", arguments: {} } }, session);
  const cancel = (id: string | number, session: string) => request({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, session);
  return { adapter, invoke, auth, request, initialize, initialized, call, cancel };
}

describe("standard HTTP session and result semantics", () => {
  it("requires initialized state, validates the envelope and cleans capacity on explicit termination", async () => {
    const f = fixture({ standardSessionLimit: 1 });
    const first = await f.initialize();
    const session = first.headers["Mcp-Session-Id"];
    expect((await f.call(2, session)).status).toBe(400);
    expect((await f.initialize()).status).toBe(429);
    await f.initialized(session);
    expect((await f.call(2, session)).status).toBe(200);
    const malformed = [
      { jsonrpc: "2.0", id: null, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: [] },
      [{ jsonrpc: "2.0", id: 3, method: "tools/list" }]
    ];
    for (const message of malformed) expect((await f.request(message, session)).status).toBe(400);
    expect((await f.request({ jsonrpc: "2.0", id: 4, method: "tools/list" }, session, { accept: "application/json" })).status).toBe(406);
    expect((await f.adapter.handle({ method: "DELETE", headers: { "mcp-session-id": session }, body: undefined })).status).toBe(200);
    expect((await f.call(3, session)).status).toBe(404);
    expect((await f.initialize()).status).toBe(200);
  });

  it("isolates concurrent equal ids across sessions and number ids from string ids without elapsed-time expiry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = (await f.initialize()).headers["Mcp-Session-Id"], second = (await f.initialize()).headers["Mcp-Session-Id"];
    await f.initialized(first); await f.initialized(second);
    const entered = [deferred(), deferred(), deferred()];
    const signals: AbortSignal[] = [];
    const completions = [deferred(), deferred(), deferred()];
    f.invoke.mockImplementation(async (_context, invocation) => {
      const index = signals.length; signals.push(invocation.signal);
      invocation.signal.addEventListener("abort", () => completions[index].resolve(), { once: true });
      entered[index].resolve(); await completions[index].promise;
      return { kind: "complete", value: { content: [{ type: "text", text: "settled" }] } };
    });
    const calls = [f.call(7, first), f.call(7, second), f.call("7", first)];
    await Promise.all(entered.map(item => item.promise));
    try {
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      await f.cancel(7, second);
      expect(signals.map(signal => signal.aborted)).toEqual([false, true, false]);
      await f.cancel("7", first);
      expect(signals.map(signal => signal.aborted)).toEqual([false, true, true]);
      f.adapter.close();
      expect(signals.every(signal => signal.aborted)).toBe(true);
      await Promise.all(calls);
      expect(f.invoke).toHaveBeenCalledTimes(3);
    } finally { completions.forEach(item => item.resolve()); await Promise.all(calls); }
  });

  it("authenticates cancellation and reaches requests still awaiting authentication", async () => {
    const f = fixture();
    const session = (await f.initialize()).headers["Mcp-Session-Id"];
    await f.initialized(session);
    const authenticating = deferred(), resume = deferred();
    f.auth.mockImplementationOnce(async () => { authenticating.resolve(); await resume.promise; return { ...context, grant: { ...context.grant, id: "synthetic-standard-http-grant" } }; });
    const pending = f.call(9, session);
    await authenticating.promise;
    try {
      f.auth.mockRejectedValueOnce(Object.assign(new Error("synthetic"), { status: 401 }));
      expect((await f.cancel(9, session)).status).toBe(401);
      expect((await f.cancel(9, session)).status).toBe(202);
      resume.resolve();
      expect((await pending).body).toMatchObject({ error: { message: "MCP request was cancelled." } });
      expect(f.invoke).not.toHaveBeenCalled();
    } finally { resume.resolve(); await pending; }
  });

  it("retains capacity until the cancelled operation actually settles and retires sessions without a stream", async () => {
    const f = fixture({ standardRequestsPerSession: 1 });
    const session = (await f.initialize()).headers["Mcp-Session-Id"];
    await f.initialized(session);
    const entered = deferred(), settle = deferred();
    f.invoke.mockImplementationOnce(async () => { entered.resolve(); await settle.promise; return { kind: "complete", value: { content: [] } }; });
    const pending = f.call(1, session); await entered.promise;
    try {
      await f.cancel(1, session);
      expect((await f.call(2, session)).status).toBe(429);
      disconnectMcpGrantSessions("synthetic-standard-http-grant");
      expect((await f.call(3, session)).status).toBe(404);
    } finally { settle.resolve(); await pending; }
  });

  it("does not mislabel modern continuations or extension results as successful standard tools", () => {
    for (const resultType of ["input_required", "synthetic_extension"]) {
      expect(standardHttpResult({ status: 200, headers: {}, body: { jsonrpc: "2.0", id: 1, result: { resultType, requestState: "opaque-synthetic-state" } } }, 1)).toMatchObject({
        status: 200, body: { error: { code: -32000, data: { code: "mcp_result_capability_required", requestState: "opaque-synthetic-state" } } }
      });
    }
    expect(standardHttpResult({ status: 200, headers: {}, body: { jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [], isError: true } } }, 1).body).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } });
  });
});
