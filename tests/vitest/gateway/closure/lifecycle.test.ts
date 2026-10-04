import { describe, expect, it, vi } from "vitest";
import { context, createTestGateway, descriptor, route } from "../support";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic invocation did not reach the expected lifecycle phase.");
}

async function untilEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Synthetic invocation did not reach the expected lifecycle phase.");
}

describe("gateway lifecycle under pressure", () => {
  it("[GC-048 GC-049 partial] cancels queued and active calls, closes only owned resources and rejects late work", async () => {
    let invoked = 0;
    let closed = 0;
    let borrowedClosed = 0;
    const gateway = createTestGateway({
      descriptors: [descriptor({ route: route({ effectClass: "read" }) })],
      admissionOptions: { maxInFlight: 1, maxQueue: 2 },
      lifecycleResources: [{ owned: true, close: () => { closed += 1; } }, { owned: false, close: () => { borrowedClosed += 1; } }],
      upstream: { invoke: async ({ signal }) => {
        invoked += 1;
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(new DOMException("aborted", "AbortError"));
          else signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        return { status: 200, body: { resultType: "complete", content: [] } };
      } }
    });
    await gateway.start();
    const first = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
    await until(() => invoked === 1);
    const queued = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
    await until(() => gateway.stats().admission.queued > 0);
    const closing = gateway.close({ drainDeadline: 25 });
    await closing;
    expect((await first).kind).toBe("failure");
    expect((await queued).kind).toBe("failure");
    expect(gateway.stats().activeInvocations).toBe(0);
    expect(gateway.stats().admission.active).toBe(0);
    expect({ closed, borrowedClosed, invoked }).toEqual({ closed: 1, borrowedClosed: 0, invoked: 1 });
    expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", code: "gateway_not_started" });
  });

  it("[GC-050] a slow upstream's queue cannot serialize a fast upstream", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let fastCalls = 0;
    const gateway = createTestGateway({
      descriptors: [
        descriptor({ publicName: "slow", route: route({ logicalRoute: "slow", upstreamIdentity: "slow-peer", effectClass: "read" }) }),
        descriptor({ publicName: "fast", route: route({ logicalRoute: "fast", upstreamIdentity: "fast-peer", effectClass: "read" }) })
      ], admissionOptions: { maxInFlight: 1, maxQueue: 32 },
      upstream: { invoke: async ({ route: target }) => { if (target.upstreamIdentity === "slow-peer") await slow; else fastCalls += 1; return { status: 200, body: { resultType: "complete", content: [] } }; } }
    });
    await gateway.start();
    try {
      const blocked = Array.from({ length: 12 }, () => gateway.invoke(context, { routeRef: "slow", method: "tools/call", params: {} }));
      const fast = Array.from({ length: 12 }, () => gateway.invoke(context, { routeRef: "fast", method: "tools/call", params: {} }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcomes = await Promise.race([Promise.all(fast), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("fast upstream stalled behind slow peer")), 5000); })])
        .finally(() => { if (timer) clearTimeout(timer); });
      expect(outcomes.every((outcome) => outcome.kind === "complete")).toBe(true);
      expect(fastCalls).toBe(12);
      expect(gateway.stats().admission.queued).toBeGreaterThan(0);
      release();
      expect((await Promise.all(blocked)).every((outcome) => outcome.kind === "complete")).toBe(true);
    } finally { release(); await gateway.close({ drainDeadline: 5000 }); }
  }, 10_000);

  it("[GC-051] an actual gateway invocation survives the former implicit queue cutoff", async () => {
    const hold = deferred<void>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    let upstreamCalls = 0;
    const gateway = createTestGateway({
      descriptors: [descriptor({ route: route({ metadata: { credentialBinding: "synthetic" }, effectClass: "read" }) })],
      admissionOptions: { maxInFlight: 1, queueSize: 2 },
      credentialProvider: { resolve: async () => ({ Authorization: "synthetic" }) },
      upstream: { invoke: async () => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) { firstEntered.resolve(); await hold.promise; }
        else secondEntered.resolve();
        return { status: 200, body: { resultType: "complete", content: [] } };
      } }
    });
    const calls: Array<ReturnType<typeof gateway.invoke>> = [];
    await gateway.start();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const longLivedContext = { ...context, grant: { ...context.grant, expiresAt: Date.now() + 120_000 } };
      calls.push(gateway.invoke(longLivedContext, { routeRef: "route.demo", method: "tools/call", params: {} }));
      await firstEntered.promise;
      calls.push(gateway.invoke(longLivedContext, { routeRef: "route.demo", method: "tools/call", params: {} }));
      await untilEventLoop(() => gateway.stats().admission.queued === 1);

      expect(gateway.stats().admission).toMatchObject({ active: 1, queued: 1, timers: 0 });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(gateway.stats().admission).toMatchObject({ active: 1, queued: 1, timers: 0 });
      expect(upstreamCalls).toBe(1);

      hold.resolve();
      expect((await calls[0]).kind).toBe("complete");
      await secondEntered.promise;
      expect((await calls[1]).kind).toBe("complete");
      expect(upstreamCalls).toBe(2);
    } finally {
      vi.useRealTimers();
      hold.resolve();
      await Promise.allSettled(calls);
      await gateway.close();
    }
  });

  it("[GC-052] revalidates revoked authority after dequeue before permit, credential, or upstream effect", async () => {
    const hold = deferred<void>();
    const firstEntered = deferred<void>();
    let revoked = false;
    let credentialCalls = 0;
    let upstreamCalls = 0;
    const gateway = createTestGateway({
      descriptors: [descriptor({ route: route({ metadata: { credentialBinding: "synthetic" }, effectClass: "read" }) })],
      admissionOptions: { maxInFlight: 1, queueSize: 1 },
      currentAuthority: { read: async ({ context: original }) => ({ ...original, grant: { ...original.grant, revoked } }) },
      credentialProvider: { resolve: async () => { credentialCalls += 1; return { Authorization: "synthetic" }; } },
      upstream: { invoke: async () => {
        upstreamCalls += 1;
        if (upstreamCalls === 1) { firstEntered.resolve(); await hold.promise; }
        return { status: 200, body: { resultType: "complete", content: [] } };
      } }
    });
    const calls: Array<ReturnType<typeof gateway.invoke>> = [];
    await gateway.start();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      calls.push(gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} }));
      await firstEntered.promise;
      calls.push(gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} }));
      await untilEventLoop(() => gateway.stats().admission.queued === 1);
      expect(gateway.stats().admission).toMatchObject({ active: 1, queued: 1, timers: 0 });
      revoked = true;

      hold.resolve();
      expect((await calls[0]).kind).toBe("complete");
      expect(await calls[1]).toMatchObject({ kind: "failure", code: "grant_revoked", effectOutcome: "not_started" });
      expect({ credentialCalls, upstreamCalls, permits: gateway.stats().permits }).toMatchObject({
        credentialCalls: 1,
        upstreamCalls: 1,
        permits: { records: 1 }
      });
    } finally {
      vi.useRealTimers();
      hold.resolve();
      await Promise.allSettled(calls);
      await gateway.close();
    }
  });
});
