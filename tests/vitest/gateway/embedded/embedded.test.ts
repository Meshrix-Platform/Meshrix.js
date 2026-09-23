import { describe, expect, it } from "vitest";
import { context, descriptor, QueueUpstream, response, createTestGateway as createGateway } from "../support";

describe("embedded gateway composition", () => {
  it("[CASE-A05] has no construction side effects and owns only explicitly owned lifecycle resources", async () => {
    let starts = 0;
    let closes = 0;
    let upstreamCloses = 0;
    const gateway = createGateway({
      upstream: { invoke: async () => response({ content: [] }), close: async () => { upstreamCloses += 1; } },
      lifecycleResources: [{ owned: true, start: () => { starts += 1; }, close: () => { closes += 1; } }]
    });
    expect(starts).toBe(0);
    expect(closes).toBe(0);
    expect(gateway.stats().started).toBe(false);
    await gateway.start();
    await gateway.start();
    expect(starts).toBe(1);
    await gateway.close();
    await gateway.close();
    expect(closes).toBe(1);
    expect(upstreamCloses).toBe(0);
  });

  it("uses one platform invoke boundary and fixed route snapshot", async () => {
    const upstream = new QueueUpstream([response({ resultType: "complete", value: { traceId: "business" } })]);
    const original = { ...descriptor(), route: { ...descriptor().route } };
    const gateway = createGateway({ upstream, descriptors: [original] });
    await gateway.start();
    try {
      (original.route as { revision?: string }).revision = "mutated";
      const outcome = await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { traceId: "business" } });
      expect(outcome).toMatchObject({ kind: "complete", value: { resultType: "complete", value: { traceId: "business" } } });
      expect(upstream.requests[0].route.revision).toBe("route-1");
    } finally {
      await gateway.close();
    }
  });

  it("[CASE-G04] [CASE-F01] revalidates authority after admission before the upstream call", async () => {
    let calls = 0;
    const gateway = createGateway({
      upstream: { invoke: async () => { calls += 1; return response({ content: [] }); } },
      descriptors: [descriptor()],
      policy: {
        decide: () => ({ allowed: true, authority: { decisionRef: "d", grantRevision: "grant-1", policyRevision: "p", target: "endpoint.demo", effectClass: "read", expiresAt: Date.now() + 1000 } }),
        revalidate: () => ({ allowed: false, reasonCode: "revoked_after_wait", message: "revoked" })
      }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} })).toMatchObject({ kind: "failure", code: "revoked_after_wait" });
      expect(calls).toBe(0);
    } finally {
      await gateway.close();
    }
  });
});
