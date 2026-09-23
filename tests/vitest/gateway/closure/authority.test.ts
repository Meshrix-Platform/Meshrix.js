import { describe, expect, it } from "vitest";
import { createGatewayPolicy } from "@meshrix/capabilities/gateway-policy";
import { context, descriptor, route, createTestGateway } from "../support";
import { createHash } from "node:crypto";
import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";

const policy = createGatewayPolicy({ now: () => 1000 });
const invocation = { routeRef: "A", method: "tools/call", params: { amount: 1 } };
const target = route({ logicalRoute: "B" });

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic gateway did not reach the expected execution phase.");
}

describe("PR82 explicit grant and verified approval", () => {
  it("[GC-009 GC-010 GC-011] every supplied restriction intersects; empty never grants", () => {
    for (const grant of [{ routes: ["A"] }, { routeRefs: ["A"] }, { routes: [], routeRefs: ["A"] }, {}]) {
      expect(policy.decide({ context: { ...context, grant }, invocation, route: target })).toMatchObject({ allowed: false, reasonCode: "route_not_granted" });
    }
    expect(policy.decide({ context: { ...context, grant: { routes: "all" } }, invocation, route: target }).allowed).toBe(true);
    expect(policy.decide({ context: { ...context, grant: { routes: "all", methods: [] } }, invocation, route: target })).toMatchObject({ allowed: false, reasonCode: "method_not_granted" });
    expect(policy.decide({ context: { ...context, grant: { routes: "all" } }, invocation: { ...invocation, method: "resources/read" }, route: target })).toMatchObject({ allowed: false, reasonCode: "method_not_granted" });
    expect(policy.decide({ context: { ...context, grant: { routes: "all" } }, invocation, route: route({ logicalRoute: "A", operation: undefined }) })).toMatchObject({ allowed: false, reasonCode: "method_not_granted" });
  });

  it("[GC-012 GC-013] refuses fabricated approval flags and mismatched evidence before effect", () => {
    const destructive = route({ logicalRoute: "A", effectClass: "destructive" });
    for (const arbitrary of [false, [], {}, "yes"]) {
      expect(policy.decide({ context: { ...context, grant: { routes: ["A"], approved: arbitrary, approvals: arbitrary } }, invocation, route: destructive })).toMatchObject({ allowed: false, reasonCode: "approval_required" });
    }
    const approval = { status: "approved", ref: "reference", revision: "1", tenant: context.tenant, principal: context.principal, target: destructive.endpointIdentity, routeRef: "A", routeRevision: destructive.revision, grantRevision: "grant-1", method: invocation.method, inputDigest: createHash("sha256").update(canonicalJson({ method: invocation.method, routeRef: "A", params: invocation.params })).digest("hex"), expiresAt: 2000 };
    const authorized = { ...context, grant: { revision: "grant-1", routes: ["A"] }, metadata: { approval } };
    expect(policy.decide({ context: authorized, invocation, route: destructive }).allowed).toBe(true);
    for (const changed of [{ principal: "other" }, { target: "other" }, { routeRef: "other" }, { routeRevision: "stale" }, { grantRevision: "stale" }, { expiresAt: 1000 }, { inputDigest: "forged" }]) {
      expect(policy.decide({ context: { ...authorized, metadata: { approval: { ...approval, ...changed } } }, invocation, route: destructive }).allowed).toBe(false);
    }
  });

  it("[GC-014 GC-015] rechecks the fresh grant and target before resolving a credential or sending", async () => {
    let unlock!: () => void;
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    let calls = 0;
    let secrets = 0;
    let revoked = false;
    const gateway = createTestGateway({
      admissionOptions: { maxInFlight: 1 },
      descriptors: [descriptor({ route: route({ metadata: { credentialBinding: "synthetic" }, effectClass: "safe_write" }) })],
      currentAuthority: { read: async ({ context: original }) => ({ ...original, grant: { ...original.grant, revoked } }) },
      credentialProvider: { resolve: async () => { secrets += 1; return { Authorization: "synthetic" }; } },
      upstream: { invoke: async () => { calls += 1; await hold; return { status: 200, body: { resultType: "complete", content: [{ type: "text", text: "ok" }] } }; } }
    });
    await gateway.start();
    try {
      const first = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      await until(() => calls === 1);
      const queued = gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: {} });
      await until(() => gateway.stats().admission.queued === 1);
      revoked = true;
      unlock();
      expect((await first).kind).toBe("complete");
      expect(await queued).toMatchObject({ kind: "failure", code: "grant_revoked", effectOutcome: "not_started" });
      expect({ calls, secrets }).toEqual({ calls: 1, secrets: 1 });
    } finally { unlock(); await gateway.close(); }
  });

  it("[GC-015] rejects a target revision changed during credential resolution but tolerates unrelated catalog updates", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let sends = 0;
    const original = descriptor({ route: route({ logicalRoute: "bound", revision: "r1", metadata: { credentialBinding: "synthetic" }, effectClass: "read" }) });
    const gateway = createTestGateway({ descriptors: [original], credentialProvider: { async resolve() { reads += 1; if (reads === 1) await hold; return { Authorization: "synthetic" }; } },
      upstream: { async invoke() { sends += 1; return { status: 200, body: { resultType: "complete", content: [] } }; } } });
    await gateway.start();
    try {
      const pending = gateway.invoke(context, { routeRef: "bound", method: "tools/call", params: {} });
      await until(() => reads === 1);
      gateway.catalogStore.publish([{ ...original, route: { ...original.route, revision: "r2", endpointIdentity: "different" } }]);
      release();
      expect(await pending).toMatchObject({ kind: "failure", code: "authority_changed", effectOutcome: "not_started" });
      expect(sends).toBe(0);
      gateway.catalogStore.publish([original, descriptor({ route: route({ logicalRoute: "unrelated" }), publicName: "unrelated" })]);
      expect((await gateway.invoke(context, { routeRef: "bound", method: "tools/call", params: {} })).kind).toBe("complete");
      expect(sends).toBe(1);
    } finally { release(); await gateway.close(); }
  });
});
