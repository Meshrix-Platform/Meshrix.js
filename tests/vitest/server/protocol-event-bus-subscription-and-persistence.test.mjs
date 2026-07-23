import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.mjs";
import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.mjs";

async function withTempUserData(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-event-bus-extra-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  };
}

function openBus(userDataPath, options = {}) {
  const eventStore = createSqliteProtocolEventStore({
    userDataPath,
    policy: options.storePolicy
  });
  const bus = createProtocolEventBus({
    eventStore,
    logger: options.logger || logger(),
    ...options.busPolicy
  });
  return {
    bus,
    eventStore,
    async close() {
      await bus.close();
      eventStore.close();
    }
  };
}

describe("protocol event bus subscription and persistence", () => {
  it("shares a close barrier and never strands current or late subscribers", async () => {
    await withTempUserData(async (userDataPath) => {
      const runtime = openBus(userDataPath);
      const waiting = runtime.bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 5_000
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const firstClose = runtime.bus.close();
      const secondClose = runtime.bus.close();
      expect(firstClose).toBe(secondClose);
      await firstClose;
      await expect(waiting).resolves.toMatchObject({ events: [], nextCursor: 0 });
      await expect(runtime.bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 5_000
      })).resolves.toMatchObject({ events: [], nextCursor: 0 });
      await expect(runtime.bus.publish("after-close", {}))
        .rejects.toThrow("Protocol event bus is closed.");
      runtime.eventStore.close();
    });
  });

  it("publishes monotonic offsets, filters topics, and retains latest snapshots", async () => {
    await withTempUserData(async (userDataPath) => {
      const runtime = openBus(userDataPath);
      try {
        const [first, second, third] = await Promise.all([
          runtime.bus.publish("alpha", { index: 1 }, {
            type: "created",
            publisher: "unit"
          }),
          runtime.bus.publish("beta", { index: 2 }, {
            type: "updated",
            retain: false
          }),
          runtime.bus.publish("alpha", { index: 3 }, {
            trace: {
              traceId: "trace-1",
              requestId: "req-1",
              spanId: "span-1"
            }
          })
        ]);

        expect([first.offset, second.offset, third.offset]).toEqual([1, 2, 3]);
        expect(first).toMatchObject({
          schemaVersion: "v0.0.1:pubsub:event-schema-1",
          topic: "alpha",
          type: "created",
          publisher: "unit",
          payload: { index: 1 }
        });
        expect(third).toMatchObject({
          traceId: "trace-1",
          requestId: "req-1",
          spanId: "span-1"
        });

        const filtered = await runtime.bus.readEvents({
          cursor: 0,
          topics: ["alpha"],
          limit: 10
        });
        expect(filtered).toMatchObject({
          cursor: 0,
          nextCursor: 3,
          topics: ["alpha"]
        });
        expect(filtered.events.map((event) => event.offset)).toEqual([1, 3]);

        const snapshots = await runtime.bus.getSnapshots();
        expect(snapshots.map((event) => [event.topic, event.offset]))
          .toEqual([["alpha", 3]]);

        const subscribed = await runtime.bus.subscribe({
          cursor: 1,
          topics: ["alpha"],
          includeSnapshot: true
        });
        expect(subscribed.events.map((event) => event.offset)).toEqual([3]);
        expect(subscribed.snapshots.map((event) => event.offset)).toEqual([3]);
      } finally {
        await runtime.close();
      }
    });
  });

  it("wakes a local subscriber immediately and observes another process by revision polling", async () => {
    await withTempUserData(async (userDataPath) => {
      const firstRuntime = openBus(userDataPath, {
        busPolicy: { pollMinMs: 5, pollMaxMs: 20 }
      });
      const secondRuntime = openBus(userDataPath, {
        busPolicy: { pollMinMs: 5, pollMaxMs: 20 }
      });
      try {
        const seed = await firstRuntime.bus.publish("ready", { seed: true });
        const localPending = firstRuntime.bus.subscribe({
          cursor: seed.offset,
          topics: ["ready"],
          timeoutMs: 2_000
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const local = await firstRuntime.bus.publish("ready", { local: true });
        await expect(localPending).resolves.toMatchObject({
          events: [expect.objectContaining({ offset: local.offset })]
        });

        const remotePending = firstRuntime.bus.subscribe({
          cursor: local.offset,
          topics: ["ready"],
          timeoutMs: 2_000
        });
        const remote = await secondRuntime.bus.publish("ready", { remote: true });
        await expect(remotePending).resolves.toMatchObject({
          events: [expect.objectContaining({
            offset: remote.offset,
            payload: { remote: true }
          })]
        });
        expect(new Set([seed.offset, local.offset, remote.offset]).size).toBe(3);

        const concurrent = await Promise.all(
          Array.from({ length: 40 }, (_unused, index) => {
            const runtime = index % 2 === 0 ? firstRuntime : secondRuntime;
            return runtime.bus.publish("concurrent", { index });
          })
        );
        const offsets = concurrent.map((event) => event.offset);
        expect(new Set(offsets).size).toBe(40);
        expect([...offsets].sort((left, right) => left - right))
          .toEqual(Array.from({ length: 40 }, (_unused, index) => index + 4));
      } finally {
        await secondRuntime.close();
        await firstRuntime.close();
      }
    });
  });

  it("returns immediately for aborted or timed-out subscriptions", async () => {
    await withTempUserData(async (userDataPath) => {
      const runtime = openBus(userDataPath);
      try {
        const controller = new AbortController();
        controller.abort();
        await expect(runtime.bus.subscribe({
          cursor: 0,
          topics: ["missing"],
          timeoutMs: 1_000,
          signal: controller.signal
        })).resolves.toMatchObject({ events: [], nextCursor: 0 });

        await expect(runtime.bus.subscribe({
          cursor: 0,
          topics: ["missing"],
          timeoutMs: 1
        })).resolves.toMatchObject({ events: [], nextCursor: 0 });
      } finally {
        await runtime.close();
      }
    });
  });

  it("rejects empty topics and continues offsets across store instances", async () => {
    await withTempUserData(async (userDataPath) => {
      const firstRuntime = openBus(userDataPath);
      await expect(firstRuntime.bus.publish("  ", {}))
        .rejects.toThrow("发布事件缺少 topic。");
      await firstRuntime.bus.publish("persisted", { first: true });
      await firstRuntime.close();

      const secondRuntime = openBus(userDataPath);
      try {
        const second = await secondRuntime.bus.publish("persisted", { second: true });
        expect(second.offset).toBe(2);
        const allEvents = await secondRuntime.bus.readEvents({ cursor: 0, limit: 10 });
        expect(allEvents.events.map((event) => event.payload)).toEqual([
          { first: true },
          { second: true }
        ]);
      } finally {
        await secondRuntime.close();
      }
    });
  });
});
