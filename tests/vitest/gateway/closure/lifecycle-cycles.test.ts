import { describe, expect, it } from "vitest";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { createGatewayPermitAuthority } from "@meshrix/foundation/security/gateway-permit";
import { context, createTestGateway, descriptor, route } from "../support";

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic lifecycle phase did not become ready.");
}

describe("bounded repeated gateway lifecycle measurements", () => {
  it("[GC-047 GC-048 GC-049] returns indexes, queues, controllers, deadlines and streams to stable values across six cycles", async () => {
    let clock = 1_000_000;
    const measurements: Array<{ indexes: number; buckets: number; timers: number; controllers: number; streams: number; workers: number; contexts: number; permits: number }> = [];
    let resourceAborts = 0;
    let promptAborts = 0;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const permits = createGatewayPermitAuthority({ now: () => clock });
      const blocked = (kind: "resource" | "prompt", signal?: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
        const abort = () => { if (kind === "resource") resourceAborts += 1; else promptAborts += 1; reject(new DOMException("cancelled", "AbortError")); };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      const gateway = createTestGateway({ now: () => clock, policy: createGatewayPolicy({ now: () => clock }), permits,
        descriptors: [
          descriptor({ kind: "resource", publicUri: "meshrix://fixture/slow", inputSchema: { type: "object" }, route: route({ logicalRoute: "resource", operation: "resources/read", upstreamIdentity: "same-peer", effectClass: "read" }) }),
          descriptor({ kind: "prompt", publicName: "slow-prompt", inputSchema: { type: "object" }, route: route({ logicalRoute: "prompt", operation: "prompts/get", upstreamIdentity: "same-peer", effectClass: "read" }) })
        ], contextOptions: { maxActiveTotal: 64, maxTombstones: 16, tombstoneRetentionMs: 25, activeLifetimeMs: 50 },
        admissionOptions: { maxInFlight: 1, maxQueue: 20, defaultQueueDeadlineMs: 5000 },
        resources: { read: async ({ signal }) => blocked("resource", signal) },
        prompts: { get: async ({ signal }) => blocked("prompt", signal) }
      });
      await gateway.start();
      try {
        for (let index = 0; index < 40; index += 1) {
          const business = gateway.createContext({ tenant: "synthetic", principal: `cycle-${cycle}-${index}`, grantRevision: "grant-1", credentialGeneration: "auth-1", routeRef: "resource" });
          gateway.contextStore.close(business.handle);
        }
        const subscription = gateway.subscribe(context, ["resource/updated"]);
        const next = subscription.events[Symbol.asyncIterator]().next();
        const active = cycle % 2 === 0 ? gateway.readResource(context, "meshrix://fixture/slow") : gateway.getPrompt(context, "slow-prompt");
        await until(() => gateway.stats().admission.active === 1);
        const queue = [
          ...Array.from({ length: 7 }, () => gateway.readResource(context, "meshrix://fixture/slow")),
          ...Array.from({ length: 8 }, () => gateway.getPrompt(context, "slow-prompt"))
        ];
        await until(() => gateway.stats().admission.queued === 15);
        const controlled = new AbortController();
        const cancelled = gateway.getPrompt(context, "slow-prompt", {}, controlled.signal);
        await until(() => gateway.stats().admission.queued === 16);
        expect(gateway.stats()).toMatchObject({ activeInvocations: 17, controllers: 17,
          admission: { active: 1, queued: 16, timers: 16, buckets: 1 },
          subscriptions: { streams: 1, waitingReaders: 1 }, catalogRetention: { routes: 2 } });
        controlled.abort();
        expect((await cancelled).kind).toBe("failure");
        await gateway.close({ drainDeadline: 30 });
        await Promise.allSettled([active, ...queue]);
        expect((await next).done).toBe(true);
        clock += 90_000;
        gateway.contextStore.sweep(clock);
        const stats = gateway.stats();
        measurements.push({ indexes: stats.catalogRetention!.routes as number, buckets: stats.admission.buckets as number,
          timers: stats.admission.timers as number, controllers: stats.controllers!, streams: stats.subscriptions!.streams as number,
          workers: (stats.catalogRetention!.schemaWorkers as { workers: number }).workers,
          contexts: stats.contexts!.activeContexts as number, permits: permits.stats().records });
        expect(stats).toMatchObject({ activeInvocations: 0, controllers: 0, admission: { active: 0, queued: 0, timers: 0, buckets: 0 },
          subscriptions: { streams: 0, waitingReaders: 0 }, catalogRetention: { routes: 2, schemaWorkers: { workers: 0, active: 0, queued: 0, deadlineTimers: 0 } },
          contexts: { activeContexts: 0, retainedTombstones: 0 }, permits: { records: 0 } });
      } finally { await gateway.close({ drainDeadline: 30 }); }
    }
    expect(measurements).toEqual(Array.from({ length: 6 }, () => ({ indexes: 2, buckets: 0, timers: 0, controllers: 0, streams: 0, workers: 0, contexts: 0, permits: 0 })));
    expect(resourceAborts).toBe(3);
    expect(promptAborts).toBe(3);
  }, 30_000);
});
