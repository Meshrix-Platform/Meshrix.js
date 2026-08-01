import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createUpstreamGatewayRegistry
} from "../../../packages/agents/src/upstream-gateway/index.ts";
import {
  installUpstreamRuntimeServices,
  structuredUpstreamServiceFixture
} from "../../helpers/upstream-runtime-snapshot.ts";

const SUBJECT: Readonly<Record<string, any>> = Object.freeze({
  subjectId: "scheduler-subject-marker",
  scopes: ["gateway:read", "gateway:write"]
});

const cleanupTasks: any[] = [];

function deferred() : any {
  let resolve: any;
  let reject: any;
  const promise: any = new Promise((onResolve?: any, onReject?: any) : any => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createManualSchedulerClock(startMs: any = 1_000_000) : any {
  let currentMs: any = startMs;
  let sequence: any = 0;
  const timers: any = new Map<any, any>();

  async function flushDue() : Promise<any> {
    for (;;) {
      const due: any = [...timers.entries()]
        .filter(([, timer]: any[]) : any => timer.dueAtMs <= currentMs)
        .sort((left?: any, right?: any) : any => (
          left[1].dueAtMs - right[1].dueAtMs ||
          left[1].sequence - right[1].sequence
        ));
      if (due.length === 0) return;
      for (const [handle, timer] of due) {
        if (!timers.delete(handle)) continue;
        await timer.callback();
      }
    }
  }

  return {
    runtime: Object.freeze({
      now: () : any => currentMs,
      setTimeout(callback?: any, delayMs?: any) : any {
        const handle: Readonly<Record<string, any>> = Object.freeze({ timerId: ++sequence });
        timers.set(handle, {
          callback,
          dueAtMs: currentMs + Math.max(0, Number(delayMs || 0)),
          sequence
        });
        return handle;
      },
      clearTimeout(handle?: any) : any {
        timers.delete(handle);
      }
    }),
    now: () : any => currentMs,
    pending: () : any => timers.size,
    async advanceBy(durationMs?: any) : Promise<any> {
      currentMs += durationMs;
      await flushDue();
    },
    flushDue
  };
}

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

function sendJson(response?: any, status?: any, payload?: any) : any {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close"
  });
  response.end(JSON.stringify(payload));
}

async function startLoopbackEndpoint(endpointId?: any) : Promise<any> {
  const state: Record<string, any> = {
    healthy: true,
    healthStatus: 200,
    healthHits: 0,
    healthGate: null,
    workStatus: 200,
    destroyAfterRequest: false,
    workHits: [],
    workHitWaiters: new Map<any, any>(),
    heldWork: new Map<any, any>(),
    activeWork: 0,
    maxActiveWork: 0,
    acceptedConnections: 0,
    closed: false
  };

  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    const chunks: any[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const url: any = new URL(request.url || "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      state.healthHits += 1;
      if (state.healthGate) {
        const gate: any = state.healthGate;
        gate.started.resolve();
        await gate.release.promise;
        if (state.healthGate === gate) state.healthGate = null;
      }
      sendJson(
        response,
        state.healthy ? state.healthStatus : 503,
        { ok: state.healthy }
      );
      return;
    }

    if (url.pathname !== "/work") {
      sendJson(response, 404, { ok: false });
      return;
    }

    const requestId: any = url.searchParams.get("id") || "";
    const body: any = Buffer.concat(chunks).toString("utf8");
    state.activeWork += 1;
    state.maxActiveWork = Math.max(state.maxActiveWork, state.activeWork);
    state.workHits.push({
      requestId,
      method: request.method || "",
      body
    });
    state.workHitWaiters.get(requestId)?.resolve();
    state.workHitWaiters.delete(requestId);

    try {
      if (state.destroyAfterRequest) {
        request.socket.destroy();
        return;
      }
      const gate: any = state.heldWork.get(requestId);
      if (gate) {
        await gate.promise;
        state.heldWork.delete(requestId);
      }
      sendJson(response, state.workStatus, {
        ok: state.workStatus >= 200 && state.workStatus < 300,
        endpoint: endpointId,
        id: requestId
      });
    } finally {
      state.activeWork -= 1;
    }
  });
  server.on("connection", () : any => {
    state.acceptedConnections += 1;
  });
  await listenLoopback(server);
  const address: any = server.address();

  async function stop() : Promise<any> {
    if (state.closed) return;
    state.closed = true;
    await new Promise((resolve?: any) : any => {
      server.close(() : any => resolve());
      server.closeAllConnections?.();
    });
  }

  cleanupTasks.push(stop);
  return {
    endpointId,
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    setHealthy(value?: any) : any {
      state.healthy = value === true;
    },
    setWorkStatus(status?: any) : any {
      state.workStatus = status;
    },
    setDestroyAfterRequest(value?: any) : any {
      state.destroyAfterRequest = value === true;
    },
    holdWork(requestId?: any) : any {
      const gate: any = deferred();
      state.heldWork.set(requestId, gate);
      return gate;
    },
    releaseWork(requestId?: any) : any {
      state.heldWork.get(requestId)?.resolve();
    },
    waitForWork(requestId?: any) : any {
      if (state.workHits.some((hit?: any) : any => hit.requestId === requestId)) {
        return Promise.resolve();
      }
      const waiter: any = deferred();
      state.workHitWaiters.set(requestId, waiter);
      return waiter.promise;
    },
    holdNextHealth() : any {
      const gate: Record<string, any> = {
        started: deferred(),
        release: deferred()
      };
      state.healthGate = gate;
      return gate;
    },
    stop
  };
}

function schedulerService({
  serviceId,
  endpoints,
  weights = {},
  endpointMaxConcurrent = 100,
  maxConcurrent = 100,
  queueCapacity = 4,
  queueWaitTimeoutMs = 100,
  rise = 1,
  fall = 2,
  probeIntervalMs = 60_000,
  probeTimeoutMs = 1_000,
  openMs = 200,
  slowStartMs = 0,
  operations = null
}: Record<string, any>) : any {
  return structuredUpstreamServiceFixture({
    serviceId,
    allowLocalNetwork: true,
    healthPath: "/health",
    healthPolicy: {
      enabled: true,
      probeIntervalMs,
      probeTimeoutMs,
      rise,
      fall,
      openMs,
      slowStartMs
    },
    trafficPolicy: {
      perMinute: 10_000,
      burst: 10_000,
      maxConcurrent,
      queueCapacity,
      queueWaitTimeoutMs
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: fall,
      cooldownMs: openMs
    },
    endpoints: endpoints.map((endpoint?: any) : any => ({
      endpointId: endpoint.endpointId,
      baseUrl: endpoint.baseUrl,
      weight: weights[endpoint.endpointId] || 1,
      trafficPolicy: {
        perMinute: 10_000,
        burst: 10_000,
        maxConcurrent: endpointMaxConcurrent
      },
      circuitBreaker: {
        enabled: true,
        failureThreshold: fall,
        cooldownMs: openMs
      }
    })),
    operations: operations || [
      {
        operationKey: "read",
        method: "GET",
        path: "/work",
        risk: "read_only",
        idempotent: true,
        requiredScopes: ["gateway:read"],
        publicResponseFields: ["ok", "endpoint", "id"],
        responseSchema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "endpoint", "id"],
          properties: {
            ok: { type: "boolean" },
            endpoint: { type: "string" },
            id: { type: "string" }
          }
        }
      }
    ]
  });
}

function installRegistry(clock?: any, services?: any) : any {
  const registry: any = createUpstreamGatewayRegistry({
    endpointTrafficRuntime: clock.runtime
  });
  installUpstreamRuntimeServices(registry, services);
  cleanupTasks.push(() : any => registry.close());
  return registry;
}

function forwardRead(registry?: any, serviceId?: any, requestId?: any, options: Record<string, any> = {}) : any {
  return registry.forward({
    serviceId,
    operationKey: "read",
    query: { id: requestId }
  }, SUBJECT, options);
}

function selectedEndpoint(result?: any) : any {
  return result.upstream.endpoint.endpointId;
}

async function markHealthy(registry?: any, serviceId?: any, rise: any = 1) : Promise<any> {
  for (let attempt: any = 0; attempt < rise; attempt += 1) {
    await registry.health(serviceId);
  }
}

afterEach(async () : Promise<any> => {
  while (cleanupTasks.length > 0) {
    const cleanup: any = cleanupTasks.pop();
    await cleanup();
  }
});

describe("upstream health-aware traffic scheduler", () : any => {
  it("starts unknown, applies active rise/fall to every endpoint, and fails fast when all are unavailable", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const primary: any = await startLoopbackEndpoint("primary");
    const secondary: any = await startLoopbackEndpoint("secondary");
    const serviceId: any = "health-hysteresis";
    const registry: any = installRegistry(clock, [
      schedulerService({
        serviceId,
        endpoints: [primary, secondary],
        rise: 2,
        fall: 2,
        probeIntervalMs: 100
      })
    ]);

    await expect(forwardRead(registry, serviceId, "before-probe")).rejects.toMatchObject({
      status: 503,
      reasonCode: "upstream_endpoint_unavailable"
    });
    expect(primary.state.workHits).toHaveLength(0);
    expect(secondary.state.workHits).toHaveLength(0);

    await clock.advanceBy(100);
    expect(primary.state.healthHits).toBe(1);
    expect(secondary.state.healthHits).toBe(1);
    await expect(forwardRead(registry, serviceId, "after-one-rise")).rejects.toMatchObject({
      status: 503,
      reasonCode: "upstream_endpoint_unavailable"
    });

    await clock.advanceBy(100);
    expect(primary.state.healthHits).toBe(2);
    expect(secondary.state.healthHits).toBe(2);
    await expect(forwardRead(registry, serviceId, "after-two-rise")).resolves.toMatchObject({
      ok: true
    });

    primary.setHealthy(false);
    await clock.advanceBy(100);
    const beforeFall: any = await forwardRead(registry, serviceId, "before-fall");
    expect(selectedEndpoint(beforeFall)).toBe("secondary");
    await clock.advanceBy(100);
    for (let index: any = 0; index < 6; index += 1) {
      expect(selectedEndpoint(
        await forwardRead(registry, serviceId, `primary-open-${index}`)
      )).toBe("secondary");
    }
    expect(primary.state.workHits).toHaveLength(1);

    secondary.setHealthy(false);
    await clock.advanceBy(100);
    await expect(forwardRead(registry, serviceId, "one-secondary-failure")).resolves.toMatchObject({
      ok: true
    });
    await clock.advanceBy(100);
    const workHitCount: any = primary.state.workHits.length + secondary.state.workHits.length;
    await expect(forwardRead(registry, serviceId, "all-unavailable")).rejects.toMatchObject({
      status: 503,
      reasonCode: "upstream_endpoint_unavailable"
    });
    expect(primary.state.workHits.length + secondary.state.workHits.length).toBe(workHitCount);
    expect(registry.getMetrics().boundedRuntimeState.trafficWaiterCount).toBe(0);
  });

  it("bounds passive half-open probing and restores weight through deterministic slow start", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const heavy: any = await startLoopbackEndpoint("heavy");
    const light: any = await startLoopbackEndpoint("light");
    const serviceId: any = "half-open-recovery";
    const registry: any = installRegistry(clock, [
      schedulerService({
        serviceId,
        endpoints: [heavy, light],
        weights: { heavy: 3, light: 1 },
        fall: 2,
        openMs: 200,
        slowStartMs: 400
      })
    ]);
    await markHealthy(registry, serviceId);
    await clock.advanceBy(400);

    heavy.setWorkStatus(503);
    expect(selectedEndpoint(await forwardRead(registry, serviceId, "fail-1"))).toBe("heavy");
    expect(selectedEndpoint(await forwardRead(registry, serviceId, "fail-2"))).toBe("heavy");
    heavy.setWorkStatus(200);

    for (let index: any = 0; index < 5; index += 1) {
      expect(selectedEndpoint(
        await forwardRead(registry, serviceId, `while-open-${index}`)
      )).toBe("light");
    }

    await clock.advanceBy(200);
    const halfOpenGate: any = heavy.holdWork("half-open");
    const halfOpen: any = forwardRead(registry, serviceId, "half-open");
    await heavy.waitForWork("half-open");
    const peer: any = await forwardRead(registry, serviceId, "peer-during-probe");
    expect(selectedEndpoint(peer)).toBe("light");
    expect(heavy.state.workHits.filter((hit?: any) : any => hit.requestId === "half-open")).toHaveLength(1);
    halfOpenGate.resolve();
    expect(selectedEndpoint(await halfOpen)).toBe("heavy");

    const recovering: any[] = [];
    for (let index: any = 0; index < 20; index += 1) {
      recovering.push(selectedEndpoint(
        await forwardRead(registry, serviceId, `recovering-${index}`)
      ));
    }
    expect(recovering.filter((endpointId?: any) : any => endpointId === "heavy").length).toBeLessThan(15);
    expect(recovering.filter((endpointId?: any) : any => endpointId === "light").length).toBeGreaterThan(5);

    await clock.advanceBy(400);
    const steady: any[] = [];
    for (let index: any = 0; index < 40; index += 1) {
      steady.push(selectedEndpoint(
        await forwardRead(registry, serviceId, `steady-${index}`)
      ));
    }
    expect(steady.filter((endpointId?: any) : any => endpointId === "heavy")).toHaveLength(30);
    expect(steady.filter((endpointId?: any) : any => endpointId === "light")).toHaveLength(10);
  });

  it("uses smooth configured weights only among currently eligible endpoints", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const heavy: any = await startLoopbackEndpoint("heavy");
    const medium: any = await startLoopbackEndpoint("medium");
    const light: any = await startLoopbackEndpoint("light");
    const excluded: any = await startLoopbackEndpoint("excluded");
    excluded.setHealthy(false);
    const serviceId: any = "healthy-weighted";
    const registry: any = installRegistry(clock, [
      schedulerService({
        serviceId,
        endpoints: [heavy, medium, light, excluded],
        weights: { heavy: 5, medium: 3, light: 2, excluded: 100 },
        fall: 1
      })
    ]);
    await markHealthy(registry, serviceId);

    const selected: any[] = [];
    for (let index: any = 0; index < 100; index += 1) {
      selected.push(selectedEndpoint(
        await forwardRead(registry, serviceId, `weighted-${index}`)
      ));
    }
    expect(Object.fromEntries(
      ["heavy", "medium", "light", "excluded"].map((endpointId?: any) : any => [
        endpointId,
        selected.filter((value?: any) : any => value === endpointId).length
      ])
    )).toEqual({
      heavy: 50,
      medium: 30,
      light: 20,
      excluded: 0
    });
    expect(excluded.state.workHits).toHaveLength(0);
  });

  it("enforces service and endpoint concurrency with bounded FIFO, overflow, and wait timeout", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const first: any = await startLoopbackEndpoint("first");
    const second: any = await startLoopbackEndpoint("second");
    const serviceId: any = "bounded-fifo";
    const registry: any = installRegistry(clock, [
      schedulerService({
        serviceId,
        endpoints: [first, second],
        endpointMaxConcurrent: 1,
        maxConcurrent: 2,
        queueCapacity: 2,
        queueWaitTimeoutMs: 100
      })
    ]);
    await markHealthy(registry, serviceId);

    first.holdWork("one");
    second.holdWork("two");
    const one: any = forwardRead(registry, serviceId, "one");
    await first.waitForWork("one");
    const two: any = forwardRead(registry, serviceId, "two");
    await second.waitForWork("two");
    expect(first.state.maxActiveWork).toBe(1);
    expect(second.state.maxActiveWork).toBe(1);

    first.holdWork("three");
    second.holdWork("four");
    const three: any = forwardRead(registry, serviceId, "three");
    const four: any = forwardRead(registry, serviceId, "four");
    expect(first.state.workHits.some((hit?: any) : any => hit.requestId === "three")).toBe(false);
    expect(second.state.workHits.some((hit?: any) : any => hit.requestId === "four")).toBe(false);

    await expect(forwardRead(registry, serviceId, "overflow")).rejects.toMatchObject({
      status: 429,
      reasonCode: "upstream_traffic_capacity_exceeded",
      details: {
        traffic: {
          deniedReason: "queue_full"
        }
      }
    });

    first.releaseWork("one");
    await first.waitForWork("three");
    expect(second.state.workHits.some((hit?: any) : any => hit.requestId === "four")).toBe(false);
    second.releaseWork("two");
    await second.waitForWork("four");
    first.releaseWork("three");
    second.releaseWork("four");
    await Promise.all([one, two, three, four]);

    first.holdWork("timeout-owner-first");
    second.holdWork("timeout-owner-second");
    const timeoutOwnerFirst: any = forwardRead(registry, serviceId, "timeout-owner-first");
    await first.waitForWork("timeout-owner-first");
    const timeoutOwnerSecond: any = forwardRead(registry, serviceId, "timeout-owner-second");
    await second.waitForWork("timeout-owner-second");
    const timedOut: any = forwardRead(registry, serviceId, "timed-out-waiter");
    await clock.advanceBy(101);
    await expect(timedOut).rejects.toMatchObject({
      status: 429,
      reasonCode: "upstream_traffic_capacity_exceeded",
      details: {
        traffic: {
          deniedReason: "queue_timeout"
        }
      }
    });
    expect(first.state.workHits.some((hit?: any) : any => hit.requestId === "timed-out-waiter")).toBe(false);
    expect(second.state.workHits.some((hit?: any) : any => hit.requestId === "timed-out-waiter")).toBe(false);
    first.releaseWork("timeout-owner-first");
    second.releaseWork("timeout-owner-second");
    await Promise.all([timeoutOwnerFirst, timeoutOwnerSecond]);

    expect(registry.getMetrics().boundedRuntimeState).toMatchObject({
      trafficQueueCount: 0,
      trafficWaiterCount: 0
    });
    expect(first.state.maxActiveWork).toBe(1);
    expect(second.state.maxActiveWork).toBe(1);
  });

  it("removes queued and active cancellations without leaking or retrying a slot", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const primary: any = await startLoopbackEndpoint("primary");
    const secondary: any = await startLoopbackEndpoint("secondary");
    const serviceId: any = "abort-cleanup";
    const registry: any = installRegistry(clock, [
      schedulerService({
        serviceId,
        endpoints: [primary, secondary],
        endpointMaxConcurrent: 2,
        maxConcurrent: 1,
        queueCapacity: 2
      })
    ]);
    await markHealthy(registry, serviceId);

    primary.holdWork("owner");
    const owner: any = forwardRead(registry, serviceId, "owner");
    await primary.waitForWork("owner");
    const queuedAbort: any = new AbortController();
    const queued: any = forwardRead(registry, serviceId, "queued-abort", {
      signal: queuedAbort.signal
    });
    queuedAbort.abort(new Error("synthetic queued cancellation marker"));
    await expect(queued).rejects.toMatchObject({
      status: 499,
      reasonCode: "upstream_request_aborted"
    });
    expect(primary.state.workHits.some((hit?: any) : any => hit.requestId === "queued-abort")).toBe(false);
    expect(secondary.state.workHits.some((hit?: any) : any => hit.requestId === "queued-abort")).toBe(false);
    primary.releaseWork("owner");
    await owner;
    await expect(forwardRead(registry, serviceId, "after-queued-abort")).resolves.toMatchObject({
      ok: true
    });

    const activeAbort: any = new AbortController();
    const activeEndpoint: any = selectedEndpoint(
      await forwardRead(registry, serviceId, "select-active-endpoint")
    );
    const heldEndpoint: any = activeEndpoint === "primary" ? secondary : primary;
    heldEndpoint.holdWork("active-abort");
    const active: any = forwardRead(registry, serviceId, "active-abort", {
      signal: activeAbort.signal
    });
    await heldEndpoint.waitForWork("active-abort");
    activeAbort.abort(new Error("synthetic active cancellation marker"));
    await expect(active).rejects.toMatchObject({
      status: 499,
      reasonCode: "upstream_request_aborted"
    });
    heldEndpoint.releaseWork("active-abort");
    await expect(forwardRead(registry, serviceId, "after-active-abort")).resolves.toMatchObject({
      ok: true
    });
    expect(primary.state.workHits.filter((hit?: any) : any => hit.requestId === "active-abort")).toHaveLength(
      activeEndpoint === "primary" ? 0 : 1
    );
    expect(secondary.state.workHits.filter((hit?: any) : any => hit.requestId === "active-abort")).toHaveLength(
      activeEndpoint === "primary" ? 1 : 0
    );
    expect(registry.getMetrics().boundedRuntimeState).toMatchObject({
      trafficQueueCount: 0,
      trafficWaiterCount: 0
    });
  });

  it("reselects only an explicitly idempotent zero-effect failure and bounds candidate attempts", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const first: any = await startLoopbackEndpoint("first");
    const second: any = await startLoopbackEndpoint("second");
    const readServiceId: any = "retry-read";
    const readRegistry: any = installRegistry(clock, [
      schedulerService({
        serviceId: readServiceId,
        endpoints: [first, second],
        fall: 3
      })
    ]);
    await markHealthy(readRegistry, readServiceId);
    await first.stop();
    const safeRetry: any = await forwardRead(readRegistry, readServiceId, "safe-retry");
    expect(selectedEndpoint(safeRetry)).toBe("second");
    expect(first.state.workHits).toHaveLength(0);
    expect(second.state.workHits.filter((hit?: any) : any => hit.requestId === "safe-retry")).toHaveLength(1);

    const effectClock: any = createManualSchedulerClock();
    const effectFirst: any = await startLoopbackEndpoint("effect-first");
    const effectSecond: any = await startLoopbackEndpoint("effect-second");
    const effectServiceId: any = "retry-after-effect";
    const effectRegistry: any = installRegistry(effectClock, [
      schedulerService({
        serviceId: effectServiceId,
        endpoints: [effectFirst, effectSecond],
        fall: 3
      })
    ]);
    await markHealthy(effectRegistry, effectServiceId);
    effectFirst.setDestroyAfterRequest(true);
    await expect(forwardRead(effectRegistry, effectServiceId, "effect-observed")).rejects.toMatchObject({
      status: 502
    });
    expect(effectFirst.state.workHits.filter((hit?: any) : any => hit.requestId === "effect-observed")).toHaveLength(1);
    expect(effectSecond.state.workHits).toHaveLength(0);

    const writeClock: any = createManualSchedulerClock();
    const writeFirst: any = await startLoopbackEndpoint("write-first");
    const writeSecond: any = await startLoopbackEndpoint("write-second");
    const writeServiceId: any = "retry-write";
    const writeRegistry: any = installRegistry(writeClock, [
      schedulerService({
        serviceId: writeServiceId,
        endpoints: [writeFirst, writeSecond],
        fall: 3,
        operations: [{
          operationKey: "write",
          method: "POST",
          path: "/work",
          risk: "safe_write",
          idempotent: false,
          requiredScopes: ["gateway:write"],
          publicResponseFields: ["ok", "endpoint", "id"],
          responseSchema: {
            type: "object",
            additionalProperties: false,
            required: ["ok", "endpoint", "id"],
            properties: {
              ok: { type: "boolean" },
              endpoint: { type: "string" },
              id: { type: "string" }
            }
          }
        }]
      })
    ]);
    await markHealthy(writeRegistry, writeServiceId);
    await writeFirst.stop();
    await expect(writeRegistry.forward({
      serviceId: writeServiceId,
      operationKey: "write",
      query: { id: "non-idempotent" },
      body: { marker: "write-payload-marker" }
    }, SUBJECT)).rejects.toMatchObject({
      status: 502
    });
    expect(writeSecond.state.workHits).toHaveLength(0);

    const exhaustedClock: any = createManualSchedulerClock();
    const exhaustedFirst: any = await startLoopbackEndpoint("exhausted-first");
    const exhaustedSecond: any = await startLoopbackEndpoint("exhausted-second");
    const exhaustedServiceId: any = "retry-exhausted";
    const exhaustedRegistry: any = installRegistry(exhaustedClock, [
      schedulerService({
        serviceId: exhaustedServiceId,
        endpoints: [exhaustedFirst, exhaustedSecond],
        fall: 3
      })
    ]);
    await markHealthy(exhaustedRegistry, exhaustedServiceId);
    const firstConnections: any = exhaustedFirst.state.acceptedConnections;
    const secondConnections: any = exhaustedSecond.state.acceptedConnections;
    await exhaustedFirst.stop();
    await exhaustedSecond.stop();
    await expect(forwardRead(
      exhaustedRegistry,
      exhaustedServiceId,
      "exhausted"
    )).rejects.toMatchObject({
      status: 502,
      reasonCode: "upstream_retry_budget_exhausted"
    });
    expect(exhaustedFirst.state.acceptedConnections).toBe(firstConnections);
    expect(exhaustedSecond.state.acceptedConnections).toBe(secondConnections);
  });

  it("resets volatile health on registry restart and keeps observations bounded and private", async () : Promise<any> => {
    const clock: any = createManualSchedulerClock();
    const primary: any = await startLoopbackEndpoint("private-primary");
    const secondary: any = await startLoopbackEndpoint("private-secondary");
    const serviceId: any = "private-metrics-service";
    const service: any = schedulerService({
      serviceId,
      endpoints: [primary, secondary],
      queueCapacity: 2
    });
    const registry: any = installRegistry(clock, [service]);
    await markHealthy(registry, serviceId);
    await registry.forward({
      serviceId,
      operationKey: "read",
      query: {
        id: "private-request-id",
        marker: "private-query-marker"
      }
    }, {
      ...SUBJECT,
      subjectId: "private-subject-marker",
      authorization: "private-credential-marker",
      sessionId: "private-session-marker"
    });

    const metrics: any = registry.getMetrics();
    expect(metrics.boundedRuntimeState).toMatchObject({
      endpointHealthCount: 2,
      trafficQueueCount: 0,
      trafficWaiterCount: 0
    });
    expect(metrics.boundedRuntimeState.endpointHealthCount).toBeLessThanOrEqual(2);
    const metricsText: any = JSON.stringify(metrics);
    for (const protectedMarker of [
      primary.baseUrl,
      secondary.baseUrl,
      "/work",
      "private-request-id",
      "private-query-marker",
      "private-subject-marker",
      "private-credential-marker",
      "private-session-marker"
    ]) {
      expect(metricsText).not.toContain(protectedMarker);
    }

    await registry.close();
    const workHitCount: any = primary.state.workHits.length + secondary.state.workHits.length;
    const restartedClock: any = createManualSchedulerClock(clock.now());
    const restarted: any = installRegistry(restartedClock, [service]);
    await expect(forwardRead(restarted, serviceId, "after-restart")).rejects.toMatchObject({
      status: 503,
      reasonCode: "upstream_endpoint_unavailable"
    });
    expect(primary.state.workHits.length + secondary.state.workHits.length).toBe(workHitCount);
    expect(restarted.getMetrics().boundedRuntimeState).toMatchObject({
      trafficQueueCount: 0,
      trafficWaiterCount: 0
    });
    expect(JSON.stringify(restarted.getMetrics())).not.toContain(primary.baseUrl);
    expect(JSON.stringify(restarted.getMetrics())).not.toContain(secondary.baseUrl);
  });
});
