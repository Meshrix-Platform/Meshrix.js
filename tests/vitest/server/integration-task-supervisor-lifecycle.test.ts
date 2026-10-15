import { afterEach, describe, expect, it, vi } from "vitest";

import { createIntegrationTaskSupervisor } from "../../../packages/server-runtime/src/composition/integration-task-supervisor.ts";

function deferred<T = unknown>() : { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForAdapterReady(supervisor: ReturnType<typeof createIntegrationTaskSupervisor>): Promise<void> {
  for (;;) {
    const state = supervisor.snapshot().adapters[0]?.state;
    if (state === "ready") return;
    if (state === "degraded" || state === "stopping" || state === "stopped") {
      throw new Error(`Synthetic adapter did not become ready: ${state}.`);
    }
    await Promise.resolve();
  }
}

afterEach(() : void => {
  vi.useRealTimers();
});

describe("integration task supervisor invocation lifetime", () : any => {
  it("keeps caller cancellation pending and records, but does not return, a late success", async () : Promise<any> => {
    vi.useFakeTimers();
    const connected = deferred<void>();
    const firstStarted = deferred<AbortSignal>();
    const firstGate = deferred<unknown>();
    let executeCount = 0;
    const supervisor = createIntegrationTaskSupervisor({
      maxConcurrent: 1,
      adapters: [{
        id: "synthetic",
        enabled: true,
        configured: true,
        connect: async () : Promise<void> => { connected.resolve(); },
        execute: async ({ signal }: { signal: AbortSignal }) : Promise<unknown> => {
          executeCount += 1;
          if (executeCount === 1) {
            firstStarted.resolve(signal);
            return await firstGate.promise;
          }
          return { result: "second" };
        }
      }]
    });
    supervisor.start({ coreReady: true });
    await connected.promise;
    await waitForAdapterReady(supervisor);

    const cancellation = new AbortController();
    let firstSettled = false;
    const first = supervisor.execute("synthetic", { action: 1 }, { signal: cancellation.signal })
      .then((value: unknown) => {
        firstSettled = true;
        return value;
      });
    const activeSignal = await firstStarted.promise;
    const second = supervisor.execute("synthetic", { action: 2 });
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "integration_adapter_unavailable"
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(activeSignal.aborted).toBe(false);
    expect(supervisor.snapshot().summary).toMatchObject({ activeJobCount: 1, queuedJobCount: 1 });

    cancellation.abort();
    expect(activeSignal.aborted).toBe(true);
    expect(firstSettled).toBe(false);
    expect(executeCount).toBe(1);
    expect(supervisor.snapshot().summary).toMatchObject({ activeJobCount: 1, queuedJobCount: 1 });

    firstGate.resolve({ result: "first completed" });
    await expect(first).rejects.toMatchObject({ code: "integration_task_cancelled" });
    await secondRejected;
    await supervisor.shutdown();
    expect(supervisor.snapshot().summary.activeJobCount).toBe(0);
    expect(supervisor.snapshot().adapters[0]).toMatchObject({
      completedTasks: 1,
      failedTasks: 0,
      fenced: true,
      state: "stopped"
    });
  });

  it("preserves timeout after an invocation ignores cancellation and later fulfills", async () : Promise<any> => {
    vi.useFakeTimers();
    const connected = deferred<void>();
    const taskStarted = deferred<AbortSignal>();
    const cancellationObserved = deferred<void>();
    const finishInvocation = deferred<void>();
    const supervisor = createIntegrationTaskSupervisor({
      adapters: [{
        id: "synthetic",
        enabled: true,
        configured: true,
        connect: async () : Promise<void> => { connected.resolve(); },
        execute: async ({ signal }: { signal: AbortSignal }) : Promise<unknown> => {
          taskStarted.resolve(signal);
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", async () => {
              cancellationObserved.resolve();
              await finishInvocation.promise;
              resolve();
            }, { once: true });
          });
          return { result: "late completion" };
        }
      }]
    });
    supervisor.start({ coreReady: true });
    await connected.promise;
    await waitForAdapterReady(supervisor);
    let taskSettledAtCaller = false;
    const task = supervisor.execute("synthetic", {}, { timeoutMs: 10 })
      .finally(() => { taskSettledAtCaller = true; });
    void task.catch(() => {});
    const signal = await taskStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(signal.aborted).toBe(true);
    await cancellationObserved.promise;
    expect(taskSettledAtCaller).toBe(false);
    finishInvocation.resolve();
    await expect(task).rejects.toMatchObject({ code: "integration_task_timeout" });
    await supervisor.shutdown();
    expect(supervisor.snapshot().summary.activeJobCount).toBe(0);
    expect(supervisor.snapshot().adapters[0]).toMatchObject({
      completedTasks: 1,
      failedTasks: 0,
      fenced: true,
      state: "stopped"
    });
  });

  it("retains and closes a connection that settles after shutdown starts", async () : Promise<any> => {
    vi.useFakeTimers();
    const connectStarted = deferred<AbortSignal>();
    const connectGate = deferred<{ id: string }>();
    const closedConnections: unknown[] = [];
    const supervisor = createIntegrationTaskSupervisor({
      connectTimeoutMs: 10,
      adapters: [{
        id: "synthetic",
        enabled: true,
        configured: true,
        connect: async ({ signal }: { signal: AbortSignal }) : Promise<{ id: string }> => {
          connectStarted.resolve(signal);
          return await connectGate.promise;
        },
        execute: async () : Promise<unknown> => null,
        close: async ({ connection }: { connection: unknown }) : Promise<void> => {
          closedConnections.push(connection);
        }
      }]
    });
    supervisor.start({ coreReady: true });
    const connectSignal = await connectStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(connectSignal.aborted).toBe(true);

    let shutdownSettled = false;
    const shutdown = supervisor.shutdown().then((value: unknown) => {
      shutdownSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(closedConnections).toEqual([]);

    const connection = { id: "late-connection" };
    connectGate.resolve(connection);
    await shutdown;
    expect(closedConnections).toEqual([connection]);
  });

  it("does not impose a default timeout on an active adapter close", async () : Promise<any> => {
    vi.useFakeTimers();
    const connected = deferred<void>();
    const closeStarted = deferred<{ signal: AbortSignal; connection: unknown }>();
    const finishClose = deferred<void>();
    const connection = { id: "slow-close" };
    const supervisor = createIntegrationTaskSupervisor({
      adapters: [{
        id: "synthetic",
        enabled: true,
        configured: true,
        connect: async () : Promise<{ id: string }> => {
          connected.resolve();
          return connection;
        },
        execute: async () : Promise<unknown> => null,
        close: async ({ signal, connection: closing }: { signal: AbortSignal; connection: unknown }): Promise<void> => {
          closeStarted.resolve({ signal, connection: closing });
          await finishClose.promise;
        }
      }]
    });
    supervisor.start({ coreReady: true });
    await connected.promise;
    await waitForAdapterReady(supervisor);

    let shutdownSettled = false;
    const shutdown = supervisor.shutdown().then((value: unknown) => {
      shutdownSettled = true;
      return value;
    });
    const closing = await closeStarted.promise;
    expect(closing.connection).toBe(connection);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(closing.signal.aborted).toBe(false);
    expect(shutdownSettled).toBe(false);

    finishClose.resolve();
    await shutdown;
    expect(supervisor.snapshot().adapters[0]).toMatchObject({
      code: "integration_stopped",
      state: "stopped"
    });
  });

  it("keeps close ownership until an explicitly timed close actually settles", async () : Promise<any> => {
    vi.useFakeTimers();
    const connected = deferred<void>();
    const closeStarted = deferred<AbortSignal>();
    const finishClose = deferred<void>();
    const supervisor = createIntegrationTaskSupervisor({
      closeTimeoutMs: 10,
      adapters: [{
        id: "synthetic",
        enabled: true,
        configured: true,
        connect: async () : Promise<{ id: string }> => {
          connected.resolve();
          return { id: "explicit-close-budget" };
        },
        execute: async () : Promise<unknown> => null,
        close: async ({ signal }: { signal: AbortSignal }): Promise<void> => {
          closeStarted.resolve(signal);
          await finishClose.promise;
        }
      }]
    });
    supervisor.start({ coreReady: true });
    await connected.promise;
    await waitForAdapterReady(supervisor);

    let shutdownSettled = false;
    const shutdown = supervisor.shutdown().then((value: unknown) => {
      shutdownSettled = true;
      return value;
    });
    const closeSignal = await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(closeSignal.aborted).toBe(true);
    expect(shutdownSettled).toBe(false);

    finishClose.resolve();
    await shutdown;
    expect(supervisor.snapshot().adapters[0]).toMatchObject({
      code: "integration_close_timeout",
      state: "stopped"
    });
  });
});
