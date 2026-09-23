import { describe, expect, it } from "vitest";
import { context, descriptor, QueueUpstream, response, route, createTestGateway as createGateway } from "../support";

/**
 * The kernel escalates an approval-required route to the platform's pending-approval runtime
 * instead of refusing it. The escalation is the only outcome the kernel produces without
 * issuing a permit, so these tests pin the boundary that keeps it from becoming a way to run
 * an effect the policy declined to permit.
 */
describe("approval escalation boundary", () => {
  it("escalates an approval-required route without issuing a permit or reaching the upstream", async () => {
    const upstream = new QueueUpstream([response({ result: { content: [] } })]);
    const escalations: Array<{ reasonCode: string }> = [];
    const gateway = createGateway({
      descriptors: [descriptor({ route: route({ logicalRoute: "route.destructive", effectClass: "destructive" }) })],
      upstream,
      policy: { decide: () => ({ allowed: false, reasonCode: "approval_required", message: "needs approval" }) },
      approval: {
        escalate: async (input: { readonly reasonCode: string }) => {
          escalations.push({ reasonCode: input.reasonCode });
          return { value: { status: "pending_approval" }, effectOutcome: "not_started" as const, pendingOperationId: "po-1" };
        }
      }
    });
    await gateway.start();
    try {
      const outcome = await gateway.invoke(context, { routeRef: "route.destructive", method: "tools/call", params: { arguments: {} } });
      // A pending approval reports the effect as not started, never as a completed effect.
      expect(outcome).toMatchObject({ kind: "complete", effectOutcome: "not_started" });
      expect(escalations).toEqual([{ reasonCode: "approval_required" }]);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });

  it("never escalates a denial that is not an approval requirement", async () => {
    let escalations = 0;
    const gateway = createGateway({
      descriptors: [descriptor({ route: route({ logicalRoute: "route.denied", effectClass: "read" }) })],
      policy: { decide: () => ({ allowed: false, reasonCode: "route_not_granted", message: "denied" }) },
      approval: { escalate: async () => { escalations += 1; return { value: "escalated", effectOutcome: "not_started" as const }; } }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.denied", method: "tools/call", params: {} }))
        .toMatchObject({ kind: "failure", code: "route_not_granted" });
      expect(escalations).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it("keeps the kernel denial when the escalation port fails or declines", async () => {
    const failing = createGateway({
      descriptors: [descriptor({ route: route({ logicalRoute: "route.destructive", effectClass: "destructive" }) })],
      policy: { decide: () => ({ allowed: false, reasonCode: "approval_required", message: "needs approval" }) },
      approval: { escalate: async () => { throw Object.assign(new Error("unavailable"), { code: "escalation_failed", status: 503 }); } }
    });
    const declining = createGateway({
      descriptors: [descriptor({ route: route({ logicalRoute: "route.destructive", effectClass: "destructive" }) })],
      policy: { decide: () => ({ allowed: false, reasonCode: "approval_required", message: "needs approval" }) },
      approval: { escalate: async () => undefined }
    });
    const invocation = { routeRef: "route.destructive", method: "tools/call", params: {} };
    await failing.start();
    await declining.start();
    try {
      // Nothing ran, so a failure to escalate may not be reported as a completed effect.
      expect(await failing.invoke(context, invocation)).toMatchObject({ kind: "failure" });
      expect(await declining.invoke(context, invocation)).toMatchObject({ kind: "failure", code: "approval_required" });
    } finally {
      await failing.close();
      await declining.close();
    }
  });
});
