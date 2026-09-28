import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpstreamMcpSessionManager } from "../../../packages/protocols/mcp/upstream-mcp-gateway-transport.ts";
import { createStdioMcpSession } from "../../../packages/protocols/mcp/upstream-mcp-stdio-session.ts";

function createWaitableLog() : any {
  const items: any[] = [];
  const waiters: any[] = [];
  return {
    items,
    push(item?: any) : any {
      items.push(item);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter: any = waiters[index];
        const matches: any[] = items.filter(waiter.predicate);
        if (matches.length >= waiter.count) {
          waiters.splice(index, 1);
          waiter.resolve(matches);
        }
      }
    },
    waitFor(predicate?: any, count: any = 1) : any {
      const matches: any[] = items.filter(predicate);
      if (matches.length >= count) return Promise.resolve(matches);
      return new Promise((resolve?: any) : any => {
        waiters.push({ predicate, count, resolve });
      });
    }
  };
}

function track(promise?: any) : any {
  const state: Record<string, any> = { status: "pending" };
  const settled: any = promise.then(
    (value?: any) : any => {
      state.status = "fulfilled";
      state.value = value;
    },
    (error?: any) : any => {
      state.status = "rejected";
      state.error = error;
    }
  );
  return { state, settled };
}

function createHttpPeer() : any {
  const calls: any = createWaitableLog();
  const notifications: any = createWaitableLog();
  let nextSessionId: any = 1;

  async function fetchTransport(_url?: any, init?: any) : Promise<any> {
    const message: any = JSON.parse(init?.body || "{}");
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (message.method === "initialize") {
      const sessionId: any = `session-${nextSessionId++}`;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "request-lifetime-fixture", version: "1" }
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId
        }
      });
    }
    if (message.method === "tools/call") {
      const record: Record<string, any> = {
        id: message.id,
        name: message.params?.name,
        finished: false
      };
      const body: any = new ReadableStream({
        start(controller?: any) : any {
          record.controller = controller;
          init.signal?.addEventListener("abort", () : any => {
            if (record.finished) return;
            record.finished = true;
            controller.error(new Error("Fixture transport request was aborted."));
          }, { once: true });
        }
      });
      calls.push(record);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      notifications.push(message);
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 200 });
  }

  function completeCall(name?: any, result: Record<string, any> = {}) : any {
    const record: any = calls.items.find((item?: any) => item.name === name);
    if (!record || record.finished) throw new Error(`No pending fixture call named ${name}.`);
    record.finished = true;
    record.controller.enqueue(new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0",
      id: record.id,
      result
    })));
    record.controller.close();
  }

  return { calls, notifications, fetchTransport, completeCall };
}

function createStdioPeer() : any {
  const messages: any = createWaitableLog();
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () : any => child.emit("exit", null, "SIGTERM");
  let inputBuffer: any = "";

  child.stdin = new Writable({
    write(chunk?: any, _encoding?: any, callback?: any) : any {
      inputBuffer += String(chunk);
      const lines: any[] = inputBuffer.split(/\r?\n/);
      inputBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message: any = JSON.parse(line);
        messages.push(message);
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "request-lifetime-fixture", version: "1" }
            }
          })}\n`);
        }
      }
      callback();
    },
    final(callback?: any) : any {
      callback();
      queueMicrotask(() : any => {
        child.emit("exit", 0, null);
        child.stdout.end();
        child.stderr.end();
      });
    }
  });

  function respond(id?: any, result: Record<string, any> = {}) : any {
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  return { child, messages, respond };
}

describe("upstream MCP request lifetime", () : any => {
  afterEach(() : any => vi.useRealTimers());

  it("leaves HTTP business requests unbounded by default and applies configured and per-call budgets", async () : Promise<any> => {
    vi.useFakeTimers();
    const peer: any = createHttpPeer();
    const manager: any = createUpstreamMcpSessionManager({
      fetchTransport: peer.fetchTransport,
      maxSessions: 4,
      maxConcurrentRequestsPerSession: 4
    });
    const sharedConfig: Record<string, any> = {
      sessionKey: "request-lifetime-shared",
      mcp: {
        transport: "streamable-http",
        url: "https://mcp.fixture.invalid/mcp"
      }
    };
    try {
      const invalidConfigBudget: any = track(manager.callTool({
        sessionKey: "request-lifetime-invalid-config",
        mcp: { ...sharedConfig.mcp, timeoutMs: 2_147_483_648 }
      }, { name: "invalid-config-budget" }));
      const invalidCallBudget: any = track(manager.callTool(
        sharedConfig,
        { name: "invalid-call-budget" },
        { timeoutMs: 1.5 }
      ));
      await Promise.all([invalidConfigBudget.settled, invalidCallBudget.settled]);
      expect(invalidConfigBudget.state.error).toBeInstanceOf(RangeError);
      expect(invalidCallBudget.state.error).toBeInstanceOf(RangeError);
      expect(peer.calls.items).toHaveLength(0);

      const unbudgeted: any = track(manager.callTool(sharedConfig, { name: "unbudgeted" }));
      const perCallBudget: any = track(manager.callTool(
        sharedConfig,
        { name: "per-call-budget" },
        { timeoutMs: 35_000 }
      ));
      const configuredBudget: any = track(manager.callTool({
        sessionKey: "request-lifetime-configured",
        mcp: { ...sharedConfig.mcp, timeoutMs: 50_000 }
      }, { name: "configured-budget" }));

      await peer.calls.waitFor(() : any => true, 3);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(unbudgeted.state.status).toBe("pending");
      expect(perCallBudget.state.status).toBe("pending");
      expect(configuredBudget.state.status).toBe("pending");
      expect(peer.notifications.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(4_999);
      await perCallBudget.settled;
      expect(perCallBudget.state.status).toBe("rejected");
      expect(unbudgeted.state.status).toBe("pending");
      expect(configuredBudget.state.status).toBe("pending");
      expect(peer.notifications.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(1);

      peer.completeCall("unbudgeted", { structuredContent: { completed: true } });
      await unbudgeted.settled;
      expect(unbudgeted.state.status).toBe("fulfilled");

      await vi.advanceTimersByTimeAsync(15_000);
      await configuredBudget.settled;
      expect(configuredBudget.state.status).toBe("rejected");
      expect(peer.notifications.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  it("settles an active HTTP reader on caller cancellation and session close", async () : Promise<any> => {
    vi.useFakeTimers();
    const peer: any = createHttpPeer();
    const manager: any = createUpstreamMcpSessionManager({
      fetchTransport: peer.fetchTransport,
      maxSessions: 2,
      maxConcurrentRequestsPerSession: 2
    });
    const config: Record<string, any> = {
      sessionKey: "request-lifetime-cancellation",
      mcp: {
        transport: "streamable-http",
        url: "https://mcp.fixture.invalid/mcp",
        timeoutMs: 35_000
      }
    };
    const delegatedController: any = new AbortController();
    const delegatedBudget: any = track(manager.callTool(
      config,
      { name: "delegated-budget" },
      { signal: delegatedController.signal, timeoutMs: null }
    ));
    const ordinaryController: any = new AbortController();
    const ordinaryBudget: any = track(manager.callTool(
      config,
      { name: "ordinary-budget" },
      { signal: ordinaryController.signal }
    ));

    try {
      await peer.calls.waitFor(() : any => true, 2);
      await vi.advanceTimersByTimeAsync(35_001);
      await ordinaryBudget.settled;
      expect(ordinaryBudget.state.status).toBe("rejected");
      expect(ordinaryController.signal.aborted).toBe(false);
      expect(delegatedBudget.state.status).toBe("pending");
      expect(peer.notifications.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(1);

      delegatedController.abort();
      await delegatedBudget.settled;
      expect(delegatedBudget.state.status).toBe("rejected");
      expect(peer.notifications.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(2);

      const closedWithRequest: any = track(manager.callTool(config, { name: "closed-with-request" }));
      await peer.calls.waitFor(() : any => true, 3);
      await manager.close();
      await closedWithRequest.settled;
      expect(closedWithRequest.state.status).toBe("rejected");
      expect(manager.snapshot().inFlightRequestCount).toBe(0);
      expect(peer.notifications.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  it("keeps stdio requests without a configured budget active until completion or caller cancellation", async () : Promise<any> => {
    vi.useFakeTimers();
    const peer: any = createStdioPeer();
    const session: any = await createStdioMcpSession({
      transport: "stdio",
      command: "request-lifetime-fixture"
    }, {
      stdioLauncher: { launch: () : any => peer.child }
    });
    try {
      const completed: any = track(session.request("tools/call", { name: "unbudgeted" }));
      const [firstCall]: any[] = await peer.messages.waitFor((item?: any) : any => item.method === "tools/call");
      await vi.advanceTimersByTimeAsync(30_001);
      expect(completed.state.status).toBe("pending");
      expect(peer.messages.items.filter((item?: any) => item.method === "notifications/cancelled")).toHaveLength(0);
      peer.respond(firstCall.id, { structuredContent: { completed: true } });
      await completed.settled;
      expect(completed.state.status).toBe("fulfilled");

      const controller: any = new AbortController();
      const cancelled: any = track(session.request("tools/call", { name: "unbudgeted-cancelled" }, {
        signal: controller.signal
      }));
      const calls: any[] = await peer.messages.waitFor((item?: any) : any => item.method === "tools/call", 2);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(cancelled.state.status).toBe("pending");
      controller.abort();
      await cancelled.settled;
      expect(cancelled.state.error).toMatchObject({ name: "AbortError" });
      const [notification]: any[] = await peer.messages.waitFor((item?: any) : any => item.method === "notifications/cancelled");
      expect(notification.params.requestId).toBe(calls.at(-1).id);
    } finally {
      await session.close();
    }
  });

  it("never sends a queued stdio request after its deadline or caller cancellation", async () : Promise<any> => {
    vi.useFakeTimers();
    const peer: any = createStdioPeer();
    const session: any = await createStdioMcpSession({
      transport: "stdio", command: "request-lifetime-fixture"
    }, { stdioLauncher: { launch: () : any => peer.child } });
    let release!: () => void;
    let signalEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let expiredAdmissions = 0;
    try {
      const first: any = track(session.request("tools/call", { name: "first" }, {
        async beforeSend() { signalEntered(); await gate; }
      }));
      await entered;
      const expired: any = track(session.request("tools/call", { name: "expired" }, {
        timeoutMs: 10,
        beforeSend() { expiredAdmissions += 1; }
      }));
      const controller = new AbortController();
      const cancelled: any = track(session.request("tools/call", { name: "cancelled" }, {
        signal: controller.signal
      }));
      controller.abort();
      await vi.advanceTimersByTimeAsync(11);
      await Promise.all([expired.settled, cancelled.settled]);
      expect(expired.state.status).toBe("rejected");
      expect(cancelled.state.error).toMatchObject({ name: "AbortError" });
      release();
      const [firstCall]: any[] = await peer.messages.waitFor((item?: any) => item.method === "tools/call");
      peer.respond(firstCall.id, { structuredContent: { completed: true } });
      await first.settled;
      const probe: any = track(session.request("tools/call", { name: "probe" }));
      const calls: any[] = await peer.messages.waitFor((item?: any) => item.method === "tools/call" && item.params.name === "probe");
      peer.respond(calls[0].id, { structuredContent: { completed: true } });
      await probe.settled;
      expect(first.state.status).toBe("fulfilled");
      expect(probe.state.status).toBe("fulfilled");
      expect(expiredAdmissions).toBe(0);
      expect(peer.messages.items.filter((item?: any) => item.method === "tools/call").map((item?: any) => item.params.name))
        .toEqual(["first", "probe"]);
    } finally {
      release();
      await session.close();
    }
  });

  it("defers configured stdio budgets only with the explicit marker and keeps request cancellation isolated", async () : Promise<any> => {
    vi.useFakeTimers();
    const peer: any = createStdioPeer();
    const manager: any = createUpstreamMcpSessionManager({
      stdioLauncher: { launch: () : any => peer.child },
      maxSessions: 2,
      maxConcurrentRequestsPerSession: 2
    });
    const config: Record<string, any> = {
      sessionKey: "request-lifetime-stdio",
      mcp: {
        transport: "stdio",
        command: "request-lifetime-fixture",
        timeoutMs: 35_000
      }
    };
    const firstSignal: any = new AbortController();
    const delegatedCompletion: any = track(manager.callTool(config, { name: "delegated-completion" }, {
      signal: firstSignal.signal,
      timeoutMs: null
    }));
    try {
      const [firstCall]: any[] = await peer.messages.waitFor((item?: any) : any => item.method === "tools/call");
      await vi.advanceTimersByTimeAsync(35_001);
      expect(delegatedCompletion.state.status).toBe("pending");
      peer.respond(firstCall.id, { structuredContent: { completed: true } });
      await delegatedCompletion.settled;
      expect(delegatedCompletion.state.status).toBe("fulfilled");

      const controller: any = new AbortController();
      const cancelled: any = track(manager.callTool(config, { name: "caller-cancelled" }, {
        timeoutMs: null,
        signal: controller.signal
      }));
      const toolCalls: any[] = await peer.messages.waitFor((item?: any) : any => item.method === "tools/call", 2);
      const secondCall: any = toolCalls[toolCalls.length - 1];
      const ordinaryController: any = new AbortController();
      const ordinaryBudget: any = track(manager.callTool(config, { name: "ordinary-budget" }, {
        signal: ordinaryController.signal
      }));
      const allCalls: any[] = await peer.messages.waitFor((item?: any) : any => item.method === "tools/call", 3);
      const ordinaryCall: any = allCalls[allCalls.length - 1];
      await vi.advanceTimersByTimeAsync(35_001);
      expect(cancelled.state.status).toBe("pending");
      await ordinaryBudget.settled;
      expect(ordinaryBudget.state.status).toBe("rejected");
      expect(ordinaryController.signal.aborted).toBe(false);
      controller.abort();
      await cancelled.settled;
      expect(cancelled.state.status).toBe("rejected");
      const cancellations: any[] = await peer.messages.waitFor(
        (item?: any) : any => item.method === "notifications/cancelled",
        2
      );
      expect(cancellations.map((item?: any) : any => item.params.requestId)).toEqual(
        expect.arrayContaining([secondCall.id, ordinaryCall.id])
      );
    } finally {
      await manager.close();
    }
  });
});
