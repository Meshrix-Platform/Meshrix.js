import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginControlledExecutionAuthority } from "../../../packages/server-runtime/src/composition/plugin-controlled-execution-authority.mjs";
import { createPluginInvocationAuthorizationAuthority } from "../../../packages/server-runtime/src/composition/plugin-invocation-authorization-authority.mjs";

const roots = [];
const generationA = "a".repeat(64);
const generationB = "b".repeat(64);
const invocationAuthorities = new WeakMap();
const policy = Object.freeze({
  targets: Object.freeze([Object.freeze({
    targetRef: "allowed-target",
    workloadKind: "fixture-workload",
    invocation: Object.freeze({ args: [] }),
    outputs: Object.freeze({ maxFiles: 1 }),
    capabilities: Object.freeze({ network: [] }),
    resources: Object.freeze({ wallTimeMs: 1_000 })
  })])
});

function lifecycleAuthority(initialState = "active", pluginId = "plugin-a", generation = 1) {
  let state = initialState;
  let currentGeneration = generation;
  return {
    id: "PluginLifecycleStatePort",
    readRecord: async () => ({ state, pluginId, generation: currentGeneration }),
    runExclusive: async (task) => task(),
    setState(next) { state = next; },
    setGeneration(next) { currentGeneration = next; }
  };
}

function owner(authority, input = {}) {
  return authority.forOwner({
    ownerId: "plugin-a",
    ownerGenerationDigest: generationA,
    ownerGeneration: 1,
    executionPolicy: policy,
    lifecycleStatePort: lifecycleAuthority(),
    ...input
  });
}

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-controlled-execution-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

function controlledAuthority(options) {
  const invocationAuthorizationAuthority = createPluginInvocationAuthorizationAuthority();
  const authority = createPluginControlledExecutionAuthority({ ...options, invocationAuthorizationAuthority });
  invocationAuthorities.set(authority, invocationAuthorizationAuthority);
  return authority;
}

async function request(authority, overrides = {}) {
  const base = {
    schemaVersion: "fixture-request/1",
    targetRef: "allowed-target",
    ownerTaskRef: `owned-task:${"c".repeat(40)}`,
    principal: { subjectRef: "subject" },
    inputDigest: "d".repeat(64),
    governance: { authorized: false },
    idempotencyKey: "private-idempotency-value",
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    ...overrides
  };
  return {
    ...base,
    invocationOperationId: "fixture.operation",
    invocationAuthorization: await invocationAuthorities.get(authority).issue({
      pluginId: "plugin-a",
      operationId: "fixture.operation",
      targetRef: base.targetRef,
      requestRef: "fixture-request-ref",
      sourceRequestDigest: "e".repeat(64),
      principal: { subjectRef: "host-subject", tenantRef: "host-tenant", workspaceRef: "host-workspace" },
      governance: {
        grantRef: "host-grant", riskDecisionRef: "host-risk", policyRevision: "host-policy",
        authorized: true, current: true, revoked: false
      }
    })
  };
}

describe("Plugin controlled execution authority", () => {
  it("recovers Host-custodied task ownership after restart and rejects another owner generation", async () => {
    const userDataPath = await root();
    const never = new Promise(() => {});
    let markRegistered;
    const registered = new Promise((resolve) => { markRegistered = resolve; });
    const first = controlledAuthority({ userDataPath });
    first.bind({
      executeConfigured() { markRegistered(); return never; },
      cancel() { return true; }
    });
    const ownerA = owner(first);
    void ownerA.executeTarget(await request(first), async () => ({ files: [] })).catch(() => {});
    await registered;
    first.close();

    const cancellations = [];
    const recovered = controlledAuthority({ userDataPath });
    recovered.bind({
      executeConfigured() { return never; },
      async cancel(key) { cancellations.push(key); return true; }
    });
    const wrongOwner = owner(recovered, { ownerId: "plugin-b", ownerGenerationDigest: generationB });
    await expect(wrongOwner.cancelTask(`owned-task:${"c".repeat(40)}`))
      .rejects.toMatchObject({ code: "plugin_controlled_task_owner_mismatch" });
    const recoveredOwner = owner(recovered);
    await expect(recoveredOwner.cancelTask(`owned-task:${"c".repeat(40)}`)).resolves.toBe(true);
    expect(cancellations).toEqual(["private-idempotency-value"]);
    await expect(recoveredOwner.verifyNoActiveTasks()).resolves.toEqual({ ok: true, remainingCount: 0 });
    recovered.close();
  });

  it("rejects a target outside the Host-bound allowlist before executing", async () => {
    const authority = controlledAuthority({ userDataPath: await root() });
    let executions = 0;
    authority.bind({
      executeConfigured() { executions += 1; return { status: "succeeded" }; },
      cancel() { return true; }
    });
    const boundOwner = owner(authority);
    await expect(boundOwner.executeTarget(await request(authority, { targetRef: "other-target" }), async () => ({ files: [] })))
      .rejects.toMatchObject({ code: "plugin_controlled_execution_target_denied" });
    expect(executions).toBe(0);
    authority.close();
  });

  it("uses only the Host-configured sandbox policy and scopes output handles to the owner port", async () => {
    const authority = controlledAuthority({ userDataPath: await root() });
    let captured;
    authority.bind({
      executeConfigured(input, _provider, options) {
        captured = { input, options };
        return { status: "succeeded", outputHandle: "output:owned" };
      },
      cancel() { return true; },
      resolveQuarantinedOutput(handle, ownerScope) { return { handle, ownerScope }; },
      disposeOutput() { return true; }
    });
    const boundOwner = owner(authority);
    await expect(boundOwner.executeTarget(await request(authority, {
      workloadKind: "attacker-workload",
      invocation: { command: "attacker" },
      outputs: { maxFiles: 999 },
      capabilities: { network: ["any"] },
      resources: { wallTimeMs: 999_999 }
    }), async () => ({ files: [] }), {
      currentGovernance: { authorized: true, grantRef: "attacker-grant" }
    })).resolves.toMatchObject({ status: "succeeded", outputHandle: "output:owned" });
    expect(captured.input).toMatchObject({
      workloadKind: "fixture-workload",
      invocation: { args: [] },
      outputs: { maxFiles: 1 },
      capabilities: { network: [] },
      resources: { wallTimeMs: 1_000 }
    });
    expect(captured.options.currentGovernance).toMatchObject({ grantRef: "host-grant", authorized: true, current: true });
    expect(captured.input.principal).toMatchObject({ subjectRef: "host-subject", tenantRef: "host-tenant" });
    expect(boundOwner.resolveQuarantinedOutput("output:other")).toBeNull();
    expect(boundOwner.resolveQuarantinedOutput("output:owned")).toEqual({
      handle: "output:owned", ownerScope: { pluginId: "plugin-a" }
    });
    await expect(boundOwner.disposeOutput("output:owned", "committed")).resolves.toBe(true);
    expect(boundOwner.resolveQuarantinedOutput("output:owned")).toBeNull();
    authority.close();
  });

  it("rejects new execution admission after the owner lifecycle leaves active", async () => {
    const authority = controlledAuthority({ userDataPath: await root() });
    let executions = 0;
    authority.bind({
      executeConfigured() { executions += 1; return { status: "succeeded" }; },
      cancel() { return true; }
    });
    const lifecycleStatePort = lifecycleAuthority("active");
    const boundOwner = owner(authority, { lifecycleStatePort });
    const authorizedRequest = await request(authority);
    lifecycleStatePort.setState("removal_pending");
    await expect(boundOwner.executeTarget(authorizedRequest, async () => ({ files: [] })))
      .rejects.toMatchObject({ code: "plugin_controlled_execution_owner_retired" });
    expect(executions).toBe(0);
    authority.close();
  });

  it("rejects a stale generation port after a newer active generation is installed", async () => {
    const authority = controlledAuthority({ userDataPath: await root() });
    let executions = 0;
    authority.bind({ executeConfigured() { executions += 1; return { status: "succeeded" }; }, cancel() { return true; } });
    const lifecycleStatePort = lifecycleAuthority("active", "plugin-a", 1);
    const boundOwner = owner(authority, { lifecycleStatePort });
    const authorizedRequest = await request(authority);
    lifecycleStatePort.setGeneration(2);
    await expect(boundOwner.executeTarget(authorizedRequest, async () => ({ files: [] })))
      .rejects.toMatchObject({ code: "plugin_controlled_execution_owner_retired" });
    expect(executions).toBe(0);
    authority.close();
  });
});
