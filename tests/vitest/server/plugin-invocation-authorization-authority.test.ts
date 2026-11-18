import { describe, expect, it } from "vitest";

import { createPluginInvocationAuthorizationAuthority } from "../../../packages/server-runtime/src/composition/plugin-invocation-authorization-authority.ts";

const digestA: any = "a".repeat(64);
const digestB: any = "b".repeat(64);

function lifecycle(pluginId: any = "plugin-a", generation: any = 1) : any {
  let state: any = "active";
  let currentGeneration: any = generation;
  return {
    id: "PluginLifecycleStatePort",
    readRecord: async () : Promise<any> => ({ pluginId, generation: currentGeneration, state }),
    runExclusive: async (task?: any) : Promise<any> => task(),
    setState(value?: any) : any { state = value; },
    setGeneration(value?: any) : any { currentGeneration = value; }
  };
}

function issue(authority?: any, patch: Record<string, any> = {}) : any {
  return authority.issue({
    pluginId: "plugin-a",
    operationId: "operation.one",
    targetRef: "",
    requestRef: "request-one",
    sourceRequestDigest: "c".repeat(64),
    principal: { subjectRef: "subject", tenantRef: "tenant", workspaceRef: "workspace" },
    governance: {
      grantRef: "grant", riskDecisionRef: "risk", policyRevision: "policy",
      authorized: true, current: true, revoked: false
    },
    ...patch
  });
}

describe("Plugin invocation authorization authority", () : any => {
  it("rejects forgery, cross-operation/request/digest replay, and oversized tokens", async () : Promise<any> => {
    const authority: any = createPluginInvocationAuthorizationAuthority();
    authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 1, lifecycleStatePort: lifecycle()
    });
    const token: any = await issue(authority);
    await expect(authority.verify(`${token.slice(0, -1)}x`, { audience: "controlled-execution", ownerId: "plugin-a" }))
      .rejects.toMatchObject({ code: "plugin_invocation_token_invalid" });
    await expect(authority.verify(token, { audience: "controlled-execution", operationId: "operation.two" }))
      .rejects.toMatchObject({ code: "plugin_invocation_operation_id_mismatch" });
    await expect(authority.verify(token, { audience: "controlled-execution", requestRef: "request-two" }))
      .rejects.toMatchObject({ code: "plugin_invocation_request_ref_mismatch" });
    await expect(authority.verify(token, { audience: "controlled-execution", sourceRequestDigest: "d".repeat(64) }))
      .rejects.toMatchObject({ code: "plugin_invocation_source_request_digest_mismatch" });
    await expect(authority.verify("x".repeat(16_385), { audience: "controlled-execution" }))
      .rejects.toMatchObject({ code: "plugin_invocation_token_invalid" });
    authority.close();
  });

  it("atomically replaces the current generation and invalidates old tokens", async () : Promise<any> => {
    const authority: any = createPluginInvocationAuthorizationAuthority();
    const firstLifecycle: any = lifecycle();
    authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 1, lifecycleStatePort: firstLifecycle
    });
    const token: any = await issue(authority);
    authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestB, ownerGeneration: 2, lifecycleStatePort: lifecycle("plugin-a", 2)
    });
    expect(() : any => authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 1, lifecycleStatePort: firstLifecycle
    })).toThrow(expect.objectContaining({ code: "plugin_invocation_owner_generation_regression" }));
    expect(() : any => authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 2, lifecycleStatePort: lifecycle("plugin-a", 2)
    })).toThrow(expect.objectContaining({ code: "plugin_invocation_owner_generation_regression" }));
    await expect(authority.verify(token, { audience: "controlled-execution", ownerId: "plugin-a" }))
      .rejects.toMatchObject({ code: "plugin_invocation_token_invalid" });
    authority.close();
  });

  it("permits an empty outer target while enforcing an explicitly signed target and lifecycle expiry", async () : Promise<any> => {
    let clock: any = 1_000;
    const ownerLifecycle: any = lifecycle();
    const authority: any = createPluginInvocationAuthorizationAuthority({ ttlMs: 10, now: () : any => clock });
    authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 1, lifecycleStatePort: ownerLifecycle
    });
    const unbound: any = await issue(authority);
    await expect(authority.verify(unbound, { audience: "owner-process-identity", targetRef: "host-configured-target" })).resolves.toMatchObject({ targetRef: "" });
    await expect(authority.verify(unbound, { audience: "controlled-execution", targetRef: "host-configured-target" })).resolves.toMatchObject({ targetRef: "" });
    await expect(authority.verify(unbound, { audience: "controlled-execution", targetRef: "host-configured-target" }))
      .rejects.toMatchObject({ code: "plugin_invocation_token_replayed" });
    const bound: any = await issue(authority, { targetRef: "signed-target" });
    await expect(authority.verify(bound, { audience: "controlled-execution", targetRef: "other-target" }))
      .rejects.toMatchObject({ code: "plugin_invocation_target_ref_mismatch" });
    clock = 1_011;
    await expect(authority.verify(bound, { audience: "controlled-execution" })).rejects.toMatchObject({ code: "plugin_invocation_token_expired" });
    ownerLifecycle.setState("inactive");
    await expect(issue(authority)).rejects.toMatchObject({ code: "plugin_invocation_owner_retired" });
    authority.close();
  });

  it("bounds replay state, sweeps expiry, and rejects malformed clocks and oversized required claims", async () : Promise<any> => {
    expect(() : any => createPluginInvocationAuthorizationAuthority({ maxSpentNonces: Number.POSITIVE_INFINITY })).toThrow(/capacity/u);
    expect(() : any => createPluginInvocationAuthorizationAuthority({ maxSpentNonces: -1 })).toThrow(/capacity/u);
    expect(() : any => createPluginInvocationAuthorizationAuthority({ maxSpentNonces: 16_385 })).toThrow(/capacity/u);
    let clock: any = 10;
    const authority: any = createPluginInvocationAuthorizationAuthority({ ttlMs: 5, now: () : any => clock, maxSpentNonces: 1 });
    authority.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 1, lifecycleStatePort: lifecycle()
    });
    const first: any = await issue(authority);
    await authority.verify(first, { audience: "controlled-execution" });
    const second: any = await issue(authority, { requestRef: "request-two" });
    await expect(authority.verify(second, { audience: "controlled-execution" }))
      .rejects.toMatchObject({ code: "plugin_invocation_replay_capacity_exhausted" });
    clock = 16;
    const third: any = await issue(authority, { requestRef: "request-three" });
    await expect(authority.verify(third, { audience: "controlled-execution" })).resolves.toMatchObject({ requestRef: "request-three" });
    await expect(issue(authority, { principal: { subjectRef: "x".repeat(257), tenantRef: "tenant" } }))
      .rejects.toMatchObject({ code: "plugin_invocation_authorization_facts_invalid" });
    await expect(issue(authority, { governance: { grantRef: "x".repeat(257), authorized: true, current: true, revoked: false } }))
      .rejects.toMatchObject({ code: "plugin_invocation_authorization_facts_invalid" });
    authority.close();

    const broken: any = createPluginInvocationAuthorizationAuthority({ now: () : any => Number.NaN });
    broken.registerOwner({
      ownerId: "plugin-a", ownerGenerationDigest: digestA, ownerGeneration: 1, lifecycleStatePort: lifecycle()
    });
    await expect(issue(broken)).rejects.toMatchObject({ code: "plugin_invocation_clock_invalid" });
    broken.close();
  });
});
