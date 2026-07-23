import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.mjs";

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
    warn: vi.fn(),
  };
}

describe("protocol event bus behavior", () => {
  it("shares a close barrier and never strands current or late subscribers", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      const waiting = bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 5_000
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const firstClose = bus.close();
      const secondClose = bus.close();
      expect(firstClose).toBe(secondClose);
      await firstClose;
      await expect(waiting).resolves.toMatchObject({ events: [], nextCursor: 0 });
      await expect(bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 5_000
      })).resolves.toMatchObject({ events: [], nextCursor: 0 });
      await expect(bus.publish("after-close", {})).rejects.toThrow("Protocol event bus is closed.");
    });
  });

  it("publishes serialized offsets, filters topics, and retains latest snapshots", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({ userDataPath, logger: logger() });

      const [first, second, third] = await Promise.all([
        bus.publish("alpha", { index: 1 }, { type: "created", publisher: "unit" }),
        bus.publish("beta", { index: 2 }, { type: "updated", retain: false }),
        bus.publish("alpha", { index: 3 }, { trace: { traceId: "trace-1", requestId: "req-1", spanId: "span-1" } }),
      ]);

      expect([first.offset, second.offset, third.offset]).toEqual([1, 2, 3]);
      expect(first).toMatchObject({
        schemaVersion: "v0.0.1:pubsub:event-schema-1",
        topic: "alpha",
        type: "created",
        publisher: "unit",
        payload: { index: 1 },
      });
      expect(third).toMatchObject({
        traceId: "trace-1",
        requestId: "req-1",
        spanId: "span-1",
      });

      const filtered = await bus.readEvents({ cursor: 0, topics: ["alpha"], limit: 10 });
      expect(filtered).toMatchObject({
        cursor: 0,
        nextCursor: 3,
        topics: ["alpha"],
      });
      expect(filtered.events.map((event) => event.offset)).toEqual([1, 3]);

      const snapshots = await bus.getSnapshots();
      expect(snapshots.map((event) => [event.topic, event.offset])).toEqual([["alpha", 3]]);

      const subscribed = await bus.subscribe({
        cursor: 1,
        topics: ["alpha"],
        includeSnapshot: true,
      });
      expect(subscribed.events.map((event) => event.offset)).toEqual([3]);
      expect(subscribed.snapshots.map((event) => event.offset)).toEqual([3]);
    });
  });

  it("wakes a waiting subscriber when a matching event is published", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      await bus.publish("ready", { seed: true });

      const pending = bus.subscribe({
        cursor: 1,
        topics: ["ready"],
        timeoutMs: 2000,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await bus.publish("ready", { woken: true });

      const result = await pending;
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        topic: "ready",
        offset: 2,
        payload: { woken: true },
      });
      expect(result.nextCursor).toBe(2);
    });
  });

  it("returns immediately for aborted or timed-out subscriptions without new events", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      const controller = new AbortController();
      controller.abort();

      await expect(bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 1000,
        signal: controller.signal,
      })).resolves.toMatchObject({
        events: [],
        nextCursor: 0,
      });

      const timedOut = await bus.subscribe({
        cursor: 0,
        topics: ["missing"],
        timeoutMs: 1,
      });
      expect(timedOut.events).toEqual([]);
      expect(timedOut.nextCursor).toBe(0);
    });
  });

  it("rejects empty topics and recovers the next offset from persisted state", async () => {
    await withTempUserData(async (userDataPath) => {
      const firstBus = createProtocolEventBus({ userDataPath, logger: logger() });

      await expect(firstBus.publish("  ", {})).rejects.toThrow("发布事件缺少 topic。");
      await firstBus.publish("persisted", { first: true });

      const secondBus = createProtocolEventBus({ userDataPath, logger: logger() });
      const second = await secondBus.publish("persisted", { second: true });
      expect(second.offset).toBe(2);

      const allEvents = await secondBus.readEvents({ cursor: 0, limit: 10 });
      expect(allEvents.events.map((event) => event.payload)).toEqual([
        { first: true },
        { second: true },
      ]);
    });
  });
});
