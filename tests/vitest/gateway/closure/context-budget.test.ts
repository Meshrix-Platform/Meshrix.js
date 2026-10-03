import { describe, expect, it } from "vitest";
import { createBusinessContextStore } from "@meshrix/gateway";

describe("global business-context retention", () => {
  it("[GC-047 partial] bounds unique partitions, expires active contexts, and retains terminal reason briefly", () => {
    let now = 1000;
    const store = createBusinessContextStore({ now: () => now, maxActiveTotal: 2, activeLifetimeMs: 100, maxTombstones: 2, tombstoneRetentionMs: 100 });
    const input = { tenant: "synthetic", principal: "a", grantRevision: "g", credentialGeneration: "c", routeRef: "r" };
    const first = store.create(input);
    store.create({ ...input, principal: "b" });
    expect(() => store.create({ ...input, principal: "c" })).toThrowError(expect.objectContaining({ code: "context_capacity_exceeded" }));
    now += 100;
    expect(() => store.get(first.handle)).toThrowError(expect.objectContaining({ code: "context_expired" }));
    expect(store.retentionBudget()).toMatchObject({ activeContexts: 0, activePartitions: 0 });
    store.create({ ...input, principal: "c" });
    now += 200;
    store.sweep();
    expect(store.retentionBudget()).toMatchObject({ activeContexts: 0, retainedTombstones: 1 });
  });
});
