import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.mjs";

async function withTempUserData(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-event-bus-final-extra-"));
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

function eventRoot(userDataPath) {
  return path.join(userDataPath, "protocol-events");
}

async function writeProtocolFile(userDataPath, fileName, content) {
  await fs.mkdir(eventRoot(userDataPath), { recursive: true });
  await fs.writeFile(path.join(eventRoot(userDataPath), fileName), content, "utf8");
}

describe("protocol event bus behavior", () => {
  it("bounds disk, memory payloads, and retained snapshots without losing recent offsets", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({
        userDataPath,
        logger: logger(),
        maxEventLogBytes: 4096,
        retainedEventLogBytes: 2048,
        maxMemoryEventBytes: 2048,
        maxLatestBytes: 2048,
        maxRetainedTopics: 3,
        maxEventBytes: 1024
      });

      for (let index = 0; index < 20; index += 1) {
        const published = await bus.publish(`topic-${index}`, {
          index,
          detail: "x".repeat(2000)
        });
        expect(published.offset).toBe(index + 1);
        expect(published.payload).toMatchObject({
          oversized: true,
          omittedBytes: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          reason: "event_payload_too_large_for_persistence"
        });
        const stat = await fs.stat(path.join(eventRoot(userDataPath), "events.jsonl"));
        expect(stat.size).toBeLessThanOrEqual(4096);
      }

      const snapshots = await bus.getSnapshots();
      expect(snapshots.map((event) => event.topic)).toEqual([
        "topic-17",
        "topic-18",
        "topic-19"
      ]);
      const recent = await bus.readEvents({ cursor: 19, limit: 10 });
      expect(recent.events).toHaveLength(1);
      expect(recent.events[0]).toMatchObject({ offset: 20, topic: "topic-19" });
    });
  });

  it("recovers state from an existing event log when persisted state and latest snapshots are malformed", async () => {
    await withTempUserData(async (userDataPath) => {
      await writeProtocolFile(userDataPath, "state.json", "{bad-state");
      await writeProtocolFile(userDataPath, "latest.json", "{bad-latest");
      await writeProtocolFile(
        userDataPath,
        "events.jsonl",
        [
          JSON.stringify({
            schemaVersion: "v0.0.1:schema:definition-1",
            offset: 8,
            id: "old-8",
            topic: "seed",
            type: "snapshot",
            publisher: "unit",
            publishedAt: "2026-06-05T00:00:00.000Z",
            payload: { old: true }
          }),
          JSON.stringify({
            schemaVersion: "v0.0.1:schema:definition-1",
            offset: 9,
            id: "old-9",
            topic: "seed",
            type: "snapshot",
            publisher: "unit",
            publishedAt: "2026-06-05T00:00:01.000Z",
            payload: { newer: true }
          }),
          ""
        ].join("\n")
      );

      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      expect(await bus.getSnapshots()).toEqual([]);

      const published = await bus.publish("seed", { afterMalformedState: true });
      expect(published.offset).toBe(10);

      const state = JSON.parse(await fs.readFile(path.join(eventRoot(userDataPath), "state.json"), "utf8"));
      expect(state.nextOffset).toBe(11);
      const snapshots = await bus.getSnapshots(["seed"]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        offset: 10,
        payload: { afterMalformedState: true }
      });
    });
  });

  it("returns oversized persisted JSONL events as metadata-only payloads and stops at the requested limit", async () => {
    await withTempUserData(async (userDataPath) => {
      const oversizedLine = JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        offset: 3,
        id: "huge-3",
        topic: "huge",
        type: "snapshot",
        publisher: "unit",
        publishedAt: "2026-06-05T00:00:03.000Z",
        payload: "x".repeat(2_000_020)
      });
      const secondLine = JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        offset: 4,
        id: "huge-4",
        topic: "huge",
        type: "snapshot",
        publisher: "unit",
        publishedAt: "2026-06-05T00:00:04.000Z",
        payload: { shouldNotBeReadPastLimit: true }
      });
      await writeProtocolFile(userDataPath, "events.jsonl", `\n${oversizedLine}\n${secondLine}\n`);

      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      const result = await bus.readEvents({
        cursor: 0,
        topics: ["huge"],
        limit: 1
      });

      expect(result).toMatchObject({
        cursor: 0,
        nextCursor: 3,
        topics: ["huge"]
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        schemaVersion: "v0.0.1:pubsub:event-schema-1",
        offset: 3,
        id: "huge-3",
        topic: "huge",
        type: "snapshot",
        publisher: "unit",
        publishedAt: "2026-06-05T00:00:03.000Z",
        payload: {
          oversized: true,
          reason: "event_payload_too_large_for_inline_subscription"
        }
      });
      expect(result.events[0].payload.omittedChars).toBeGreaterThan(2_000_000);
    });
  });

  it("clamps invalid cursor, limit, and timeout inputs while using memory reads for fresh events", async () => {
    await withTempUserData(async (userDataPath) => {
      const bus = createProtocolEventBus({ userDataPath, logger: logger() });
      await bus.publish("memory", { value: 1 });
      await bus.publish("other", { value: 2 });
      await bus.publish("memory", { value: 3 });

      const result = await bus.readEvents({
        cursor: "not-a-number",
        topics: ["memory"],
        limit: -10
      });
      expect(result.cursor).toBe(0);
      expect(result.nextCursor).toBe(1);
      expect(result.events.map((event) => event.payload)).toEqual([{ value: 1 }]);

      const subscribed = await bus.subscribe({
        cursor: 3,
        topics: ["memory"],
        timeoutMs: "also-not-a-number"
      });
      expect(subscribed).toMatchObject({
        cursor: 3,
        nextCursor: 3,
        events: []
      });
    });
  });

  it("logs and resolves immediately when the subscriber waiter limit is reached", async () => {
    await withTempUserData(async (userDataPath) => {
      const currentLogger = logger();
      const bus = createProtocolEventBus({ userDataPath, logger: currentLogger });
      await bus.publish("seed", { ready: true });
      const addAbortListenerSpy = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const controllers = [];
      const pending = [];

      try {
        for (let index = 0; index < 1000; index += 1) {
          const controller = new AbortController();
          controllers.push(controller);
          pending.push(bus.subscribe({
            cursor: 1,
            topics: [`missing-${index}`],
            timeoutMs: 30000,
            signal: controller.signal
          }));
        }

        await vi.waitFor(() => {
          expect(addAbortListenerSpy).toHaveBeenCalledTimes(1000);
        });

        const limited = await bus.subscribe({
          cursor: 1,
          topics: ["overflow"],
          timeoutMs: 30000
        });

        expect(limited.events).toEqual([]);
        expect(currentLogger.warn).toHaveBeenCalledWith("event.subscribe.waiter_limit", {
          waiters: 1000,
          maxWaiters: 1000
        });
      } finally {
        for (const controller of controllers) {
          controller.abort();
        }
        await Promise.all(pending);
        addAbortListenerSpy.mockRestore();
      }
    });
  }, 10000);
});
