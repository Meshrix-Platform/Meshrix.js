import { describe, expect, it } from "vitest";
import { BusinessContextStore, compileExternalSchema, partitionPayload } from "@meshrix/gateway";

describe("TASK-001 baseline reproductions", () => {
  it("[CASE-S02] uses standard schema semantics for required without sibling properties", () => {
    const compiled = compileExternalSchema({ type: "object", required: ["id"] });
    expect(compiled.validate({ id: "demo" })).toBe(true);
    expect(compiled.validate({})).toBe(false);
  });

  it("keeps business trace fields in the business object and metadata in its envelope slot", () => {
    const payload = { traceId: "business-trace", auditId: "business-audit", _meta: { "example/status": "ready" } };
    const partition = partitionPayload(payload);
    expect(partition.application).toEqual(payload);
    expect(partition.application).toHaveProperty("traceId", "business-trace");
    expect(partition.applicationMetadata).toEqual({ _meta: { "example/status": "ready" } });
    expect(partition.protocol).not.toHaveProperty("traceId");
  });

  it("records an unrecoverable stateful context instead of recreating its handle", () => {
    const store = new BusinessContextStore({ maxActive: 1, now: () => 100 });
    const created = store.create({ tenant: "t", principal: "p", grantRevision: "g", credentialGeneration: "c", routeRef: "r" });
    expect(store.markLost(created.handle, "fatal_transport").state).toBe("lost");
    expect(() => store.get(created.handle)).toThrowError(/no longer recoverable/u);
    const replacement = store.create({ tenant: "t", principal: "p", grantRevision: "g", credentialGeneration: "c", routeRef: "r" });
    expect(replacement.handle).not.toBe(created.handle);
  });

  it("[CASE-L05] [CASE-L06] budgets tombstones independently and partitions active capacity by subject and upstream", () => {
    let now = 100;
    const store = new BusinessContextStore({ maxActivePerSubjectUpstream: 1, maxTombstones: 1, tombstoneRetentionMs: 10, now: () => now });
    const make = (principal: string, routeRef: string) => ({ tenant: "t", principal, grantRevision: "g", credentialGeneration: "c", routeRef });
    const first = store.create(make("p1", "r1"));
    expect(() => store.create(make("p1", "r1"))).toThrowError(/capacity/u);
    expect(store.create(make("p2", "r2")).state).toBe("active");
    store.markLost(first.handle, "fatal");
    expect(store.retentionBudget()).toMatchObject({ maxTombstones: 1, retainedTombstones: 1, maxActivePerSubjectUpstream: 1 });
    now = 111;
    expect(store.sweep()).toBeGreaterThanOrEqual(1);
    expect(() => store.get(first.handle)).toThrowError(/unknown or expired/u);
    const replacement = store.create(make("p1", "r1"));
    expect(replacement.handle).not.toBe(first.handle);
  });
});
