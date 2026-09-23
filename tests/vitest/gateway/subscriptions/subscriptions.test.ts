import { describe, expect, it } from "vitest";
import { createSubscriptionHub } from "@meshrix/gateway";
import { context } from "../support";

describe("partitioned subscription lifecycle", () => {
  it("[CASE-C05 CASE-C06] delivers only to the authorized partition and closes a slow state subscriber", async () => {
    const hub = createSubscriptionHub({ maxEvents: 1, maxBytes: 256 });
    const subscription = hub.subscribe(context, ["gateway/state_changed"]);
    const other = hub.subscribe({ ...context, principal: "other" }, ["gateway/state_changed"]);
    hub.publish(context, { type: "gateway/state_changed", revision: "r1", payload: { state: "active" } });
    await expect(subscription.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: { revision: "r1" } });
    hub.publish(context, { type: "gateway/state_changed", revision: "r2" });
    hub.publish(context, { type: "gateway/state_changed", revision: "r3" });
    await expect(subscription.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    const otherNext = other.events[Symbol.asyncIterator]().next();
    let settled = false;
    void otherNext.then(() => { settled = true; });
    hub.publish(context, { type: "gateway/state_changed", revision: "r4" });
    await Promise.resolve();
    expect(settled).toBe(false);
    other.close();
  });

  it("[CASE-C06] closes a subscriber when one event exceeds its byte budget", async () => {
    const hub = createSubscriptionHub({ maxBytes: 64 });
    const subscription = hub.subscribe(context, ["gateway/state_changed"]);
    hub.publish(context, { type: "gateway/state_changed", revision: "large", payload: { value: "x".repeat(200) } });
    await expect(subscription.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
  });
});
