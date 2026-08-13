import { describe, expect, it } from "vitest";
import { createProtocolEventBus } from "../../../packages/protocols/pubsub/event-bus.ts";

function createStore() : any {
  const events: any[] = [];
  let revision: any = 0;
  let reads: any = 0;
  return {
    async publish(candidate?: any) : Promise<any> {
      const event: any = Object.freeze({ ...candidate, offset: events.length + 1 });
      events.push(event);
      revision += 1;
      return { event, revision };
    },
    async read({ cursor = 0, topics = [], limit = 100 }: Record<string, any> = {}) : Promise<any> {
      reads += 1;
      const topicSet: any = topics.length > 0 ? new Set<any>(topics) : null;
      const selected: any = events
        .filter((event?: any) : any => event.offset > cursor && (!topicSet || topicSet.has(event.topic)))
        .slice(0, limit);
      return {
        events: selected,
        nextCursor: selected.length >= limit ? selected.at(-1).offset : events.length,
        revision
      };
    },
    async getLatest() : Promise<any> { return []; },
    async getRevision() : Promise<any> { return revision; },
    async getStats() : Promise<any> { return { eventCount: events.length, revision }; },
    get reads() : any { return reads; }
  };
}

async function waitFor(predicate?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1));
  }
  throw new Error("condition_not_reached");
}

describe("protocol event bus indexed waiter runtime", () : any => {
  it("wakes only matching multi-topic waiters once and uses one runtime timer", async () : Promise<any> => {
    const store: any = createStore();
    const bus: any = createProtocolEventBus({
      eventStore: store,
      maxWaiters: 1_000,
      pollMinMs: 1_000,
      pollMaxMs: 1_000
    });
    const controllers: any[] = [];
    const pending: any[] = [];
    for (let index: any = 0; index < 1_000; index += 1) {
      const controller: any = new AbortController();
      controllers.push(controller);
      pending.push(bus.subscribe({
        cursor: 0,
        topics: index < 10 ? ["hot", `tenant-${index}`] : [`tenant-${index}`],
        timeoutMs: 2_000,
        signal: controller.signal
      }));
    }
    await waitFor(async () : Promise<any> => (await bus.getStats()).waiters === 1_000);
    const readsBeforePublish: any = store.reads;
    await bus.publish("hot", { value: 1 });
    const matched: any = await Promise.all(pending.slice(0, 10));
    expect(matched.every((page?: any) : any => page.events.length === 1)).toBe(true);
    const stats: any = await bus.getStats();
    expect(stats.waiters).toBe(990);
    expect(stats.runtimeTimers).toBe(1);
    expect(stats.scheduledWakeups).toBe(10);
    expect(store.reads).toBe(readsBeforePublish);
    controllers.slice(10).forEach((controller?: any) : any => controller.abort());
    await Promise.all(pending.slice(10));
    await bus.close();
  });

  it("bounds the recent ring by records and bytes", async () : Promise<any> => {
    const bus: any = createProtocolEventBus({
      eventStore: createStore(),
      maxRecentRecords: 3,
      maxRecentBytes: 1_024
    });
    for (let index: any = 0; index < 8; index += 1) {
      await bus.publish("bounded", { index, value: "x".repeat(80) });
    }
    const stats: any = await bus.getStats();
    expect(stats.recentRecords).toBeLessThanOrEqual(3);
    expect(stats.recentBytes).toBeLessThanOrEqual(1_024);
    await bus.close();
  });
});
