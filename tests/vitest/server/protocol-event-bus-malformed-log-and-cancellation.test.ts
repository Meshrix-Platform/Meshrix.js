import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.ts";
import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.ts";

async function withTempUserData(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-event-bus-focused-")
  );
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function logger() : any {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  };
}

function openBus(userDataPath?: any) : any {
  const eventStore: any = createSqliteProtocolEventStore({ userDataPath });
  const bus: any = createProtocolEventBus({ eventStore, logger: logger() });
  return { bus, eventStore };
}

async function waitFor(predicate?: any, timeoutMs: any = 1_000) : Promise<any> {
  const startedAt: any = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 0));
  }
}

afterEach(() : any => {
  vi.restoreAllMocks();
});

describe("protocol event bus validation and cancellation", () : any => {
  it("normalizes and deduplicates topic filters before indexed reads", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const { bus, eventStore } = openBus(userDataPath);
      try {
        await bus.publish("alpha", { value: 1 });
        await bus.publish("beta", { value: 2 });
        const result: any = await bus.readEvents({
          cursor: 0,
          topics: [" alpha ", "", "alpha", "beta"],
          limit: 10
        });

        expect(result.topics).toEqual(["alpha", "beta"]);
        expect(result.events.map((event?: any) : any => event.topic)).toEqual(["alpha", "beta"]);
      } finally {
        await bus.close();
        eventStore.close();
      }
    });
  });

  it("propagates storage failures and records a bounded publication failure", async () : Promise<any> => {
    const storageFailure: any = Object.assign(new Error("storage busy"), {
      code: "protocol_event_store_busy"
    });
    const eventStore: Record<string, any> = {
      publish: vi.fn(async () : Promise<any> => {
        throw storageFailure;
      }),
      read: vi.fn(async () : Promise<any> => ({ events: [], nextCursor: 0, revision: 0 })),
      getLatest: vi.fn(async () : Promise<any> => []),
      getRevision: vi.fn(async () : Promise<any> => 0),
      getStats: vi.fn(async () : Promise<any> => ({}))
    };
    const currentLogger: any = logger();
    const bus: any = createProtocolEventBus({ eventStore, logger: currentLogger });

    await expect(bus.publish("alpha", { value: 1 })).rejects.toBe(storageFailure);
    await expect(bus.getStats()).resolves.toMatchObject({ rejectedPublishes: 1 });
    expect(currentLogger.error).toHaveBeenCalledWith(
      "event.publish.failed",
      expect.objectContaining({
        topic: "alpha",
        reasonCode: "protocol_event_store_busy"
      })
    );
  });

  it("removes abort listeners after a waiting subscription is cancelled", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const { bus, eventStore } = openBus(userDataPath);
      const controller: any = new AbortController();
      const addSpy: any = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const removeSpy: any = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      try {
        const pending: any = bus.subscribe({
          cursor: 0,
          topics: ["missing"],
          timeoutMs: 5_000,
          signal: controller.signal
        });

        await waitFor(() : any => addSpy.mock.calls.some(([name]: any[]) : any => name === "abort"));
        controller.abort();

        await expect(pending).resolves.toMatchObject({
          events: [],
          nextCursor: 0
        });
        expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
      } finally {
        await bus.close();
        eventStore.close();
      }
    });
  });

  it("rejects excess waiters without allocating another pending subscription", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const eventStore: any = createSqliteProtocolEventStore({ userDataPath });
      const currentLogger: any = logger();
      const bus: any = createProtocolEventBus({
        eventStore,
        logger: currentLogger,
        maxWaiters: 2,
        pollMinMs: 5,
        pollMaxMs: 10
      });
      const controllers: any[] = [new AbortController(), new AbortController()];
      try {
        const pending: any = controllers.map((controller?: any) : any => bus.subscribe({
          cursor: 0,
          topics: ["missing"],
          timeoutMs: 5_000,
          signal: controller.signal
        }));
        await waitFor(async () : Promise<any> => (await bus.getStats()).waiters === 2);
        await expect(bus.subscribe({
          cursor: 0,
          topics: ["overflow"],
          timeoutMs: 5_000
        })).resolves.toMatchObject({ events: [], nextCursor: 0 });
        expect(currentLogger.warn).toHaveBeenCalledWith(
          "event.subscribe.waiter_limit",
          { waiters: 2, maxWaiters: 2 }
        );
        controllers.forEach((controller?: any) : any => controller.abort());
        await Promise.all(pending);
      } finally {
        controllers.forEach((controller?: any) : any => controller.abort());
        await bus.close();
        eventStore.close();
      }
    });
  });
});
