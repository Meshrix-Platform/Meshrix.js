import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.ts";
import { createProtocolEventRuntime } from "../../../packages/server-runtime/src/events/protocol-event-runtime.ts";
import { createSqliteProtocolEventStore } from "../../../packages/server-runtime/src/events/sqlite-protocol-event-store.ts";

async function withTempUserData(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-event-bus-final-extra-")
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

describe("protocol event SQLite retention and recovery", () : any => {
  it("bounds records, bytes, and latest topics while retaining recent offsets", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const runtime: any = await createProtocolEventRuntime({
        userDataPath,
        logger: logger(),
        createEventBus: createProtocolEventBus,
        storePolicy: {
          maxRecords: 5,
          maxBytes: 4_096,
          maxLatestTopics: 3,
          maxLatestBytes: 2_048,
          maxEventBytes: 1_024
        },
        busPolicy: { maxEventBytes: 1_024 }
      });
      try {
        for (let index: any = 0; index < 20; index += 1) {
          const published: any = await runtime.protocolEventBus.publish(`topic-${index}`, {
            index,
            detail: "x".repeat(2_000)
          });
          expect(published.offset).toBe(index + 1);
          expect(published.payload).toMatchObject({
            oversized: true,
            omittedBytes: expect.any(Number),
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            reason: "event_payload_too_large_for_persistence"
          });
        }

        const stats: any = await runtime.protocolEventBus.getStats();
        expect(stats.eventCount).toBeLessThanOrEqual(5);
        expect(stats.eventBytes).toBeLessThanOrEqual(4_096);
        expect(stats.latestCount).toBeLessThanOrEqual(3);
        expect(stats.latestBytes).toBeLessThanOrEqual(2_048);
        expect((await runtime.protocolEventBus.getSnapshots())
          .map((event?: any) : any => event.topic))
          .toEqual(["topic-17", "topic-18", "topic-19"]);
        await expect(runtime.protocolEventBus.readEvents({ cursor: 19, limit: 10 }))
          .resolves.toMatchObject({
            events: [expect.objectContaining({ offset: 20, topic: "topic-19" })]
          });
      } finally {
        await runtime.close();
      }
    });
  });

  it("bounds subscription responses and advances the cursor past an omitted oversized event", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createSqliteProtocolEventStore({
        userDataPath,
        policy: {
          maxEventBytes: 16_384,
          maxBytes: 64_000
        }
      });
      const bus: any = createProtocolEventBus({
        eventStore: store,
        logger: logger(),
        maxEventBytes: 16_384,
        maxResponseBytes: 1_024
      });
      try {
        const published: any = await bus.publish("large", {
          detail: "x".repeat(5_000)
        });
        const result: any = await bus.readEvents({ cursor: 0, limit: 10 });
        expect(result.nextCursor).toBe(published.offset);
        expect(result.events).toEqual([
          expect.objectContaining({
            offset: published.offset,
            topic: "large",
            payload: {
              oversized: true,
              omittedBytes: expect.any(Number),
              reason: "event_payload_too_large_for_subscription_response"
            }
          })
        ]);
        expect(Buffer.byteLength(JSON.stringify(result.events))).toBeLessThanOrEqual(1_024);
        const subscribed: any = await bus.subscribe({
          cursor: 0,
          includeSnapshot: true,
          limit: 10
        });
        expect(Buffer.byteLength(JSON.stringify({
          events: subscribed.events,
          snapshots: subscribed.snapshots
        }))).toBeLessThanOrEqual(1_024);
      } finally {
        await bus.close();
        store.close();
      }
    });
  });

  it("uses indexed cursor/topic reads and rejects excessive topic fan-out", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createSqliteProtocolEventStore({ userDataPath });
      const bus: any = createProtocolEventBus({
        eventStore: store,
        logger: logger(),
        maxTopics: 2
      });
      try {
        const plan: any = store.explainRead({ topics: ["alpha"] })
          .map((entry?: any) : any => String(entry.detail || "")).join(" ");
        expect(plan).toContain("idx_protocol_events_topic_offset");
        await expect(bus.readEvents({
          topics: ["alpha", "beta", "gamma"]
        })).rejects.toMatchObject({
          code: "protocol_event_topics_exceeded",
          statusCode: 400
        });
      } finally {
        await bus.close();
        store.close();
      }
    });
  });

  it("rejects an event larger than total retention without deleting admitted history", async () : Promise<any> => {
    await withTempUserData(async (userDataPath?: any) : Promise<any> => {
      const store: any = createSqliteProtocolEventStore({
        userDataPath,
        policy: {
          maxRecords: 10,
          maxBytes: 1_024,
          maxEventBytes: 2_048
        }
      });
      const bus: any = createProtocolEventBus({
        eventStore: store,
        logger: logger(),
        maxEventBytes: 2_048
      });
      try {
        const first: any = await bus.publish("kept", { value: "small" });
        await expect(bus.publish("rejected", { value: "x".repeat(1_500) }))
          .rejects.toMatchObject({ code: "protocol_event_record_too_large" });
        const page: any = await bus.readEvents({ cursor: 0, limit: 10 });
        expect(page.events.map((event?: any) : any => event.offset)).toEqual([first.offset]);
      } finally {
        await bus.close();
        store.close();
      }
    });
  });
});
