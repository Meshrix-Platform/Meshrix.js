import { describe, expect, it } from "vitest";
import { context, createTestGateway, descriptor, route } from "../support";

describe("combined bounded state under concurrent neutral traffic", () => {
  it("[GC-047 GC-048 GC-049 GC-050 partial] drains isolated queues, contexts and validators without cross-peer starvation", async () => {
    const targets = Array.from({ length: 8 }, (_, index) => descriptor({ publicName: `peer-${index}`, inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      route: route({ logicalRoute: `peer-${index}`, upstreamIdentity: `upstream-${index}`, effectClass: "read" }) }));
    let sends = 0;
    const gateway = createTestGateway({ descriptors: targets, admissionOptions: { maxInFlight: 2, maxQueue: 32 }, contextOptions: { maxTombstones: 32 },
      upstream: { async invoke() { sends += 1; return { status: 200, body: { resultType: "complete", content: [{ type: "text", text: "synthetic" }] } }; } } });
    await gateway.start();
    try {
      for (let index = 0; index < 1000; index += 1) {
        const created = gateway.createContext({ tenant: "synthetic", principal: `subject-${index}`, grantRevision: "grant-1", credentialGeneration: "auth-1", routeRef: "peer-0" });
        gateway.contextStore.close(created.handle);
      }
      for (let wave = 0; wave < 10; wave += 1) {
        const outcome = await Promise.all(Array.from({ length: 24 }, (_, index) => gateway.invoke(context, { routeRef: `peer-${index % 8}`, method: "tools/call", params: { value: wave * 24 + index } })));
        expect(outcome.every((result) => result.kind === "complete")).toBe(true);
      }
      expect(sends).toBe(240);
      const overloaded = await Promise.all(Array.from({ length: 100 }, (_, index) => gateway.invoke(context, { routeRef: `peer-${index % 8}`, method: "tools/call", params: { value: 300 + index } })));
      expect(overloaded.some((result) => result.kind === "failure" && result.effectOutcome === "not_started")).toBe(true);
      expect(sends).toBe(240 + overloaded.filter((result) => result.kind === "complete").length);
      const cancelled = new AbortController();
      cancelled.abort();
      expect((await gateway.invoke(context, { routeRef: "peer-0", method: "tools/call", params: { value: 999 }, signal: cancelled.signal })).kind).toBe("failure");
      expect(gateway.stats().admission).toMatchObject({ active: 0, queued: 0 });
      expect(gateway.contextStore.retentionBudget()).toMatchObject({ activeContexts: 0 });
      expect(gateway.contextStore.retentionBudget().retainedTombstones).toBeLessThanOrEqual(32);
    } finally { await gateway.close({ drainDeadline: 1000 }); }
    expect(gateway.stats().activeInvocations).toBe(0);
  }, 20_000);
});
