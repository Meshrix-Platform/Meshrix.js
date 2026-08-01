import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginControlledExecutionAuthority } from "../../../packages/server-runtime/src/composition/plugin-controlled-execution-authority.ts";
import { createPluginInvocationAuthorizationAuthority } from "../../../packages/server-runtime/src/composition/plugin-invocation-authorization-authority.ts";

const roots: any[] = [];
const generationA: any = "a".repeat(64);
const generationB: any = "b".repeat(64);
const invocationAuthorities: any = new WeakMap<object, any>();
const policy: Readonly<Record<string, any>> = Object.freeze({
  targets: Object.freeze([Object.freeze({
    targetRef: "allowed-target",
    workloadKind: "fixture-workload",
    invocation: Object.freeze({ args: [] }),
    outputs: Object.freeze({ maxFiles: 1 }),
    capabilities: Object.freeze({ network: [] }),
    resources: Object.freeze({ wallTimeMs: 1_000 })
  })])
});

function lifecycleAuthority(initialState: any = "active", pluginId: any = "plugin-a", generation: any = 1) : any {
  let state: any = initialState;
  let currentGeneration: any = generation;
  return {
    id: "PluginLifecycleStatePort",
    readRecord: async () : Promise<any> => ({ state, pluginId, generation: currentGeneration }),
    runExclusive: async (task?: any) : Promise<any> => task(),
    setState(next?: any) : any { state = next; },
    setGeneration(next?: any) : any { currentGeneration = next; }
  };
}

function owner(authority?: any, input: Record<string, any> = {}) : any {
  return authority.forOwner({
    ownerId: "plugin-a",
    ownerGenerationDigest: generationA,
    ownerGeneration: 1,
    executionPolicy: policy,
    lifecycleStatePort: lifecycleAuthority(),
    ...input
  });
}

async function root() : Promise<any> {
  const value: any = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-controlled-execution-"));
  roots.push(value);
  return value;
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((entry?: any) : any => fs.rm(entry, { recursive: true, force: true })));
});

function controlledAuthority(options?: any) : any {
  const invocationAuthorizationAuthority: any = createPluginInvocationAuthorizationAuthority();
  const authority: any = createPluginControlledExecutionAuthority({ ...options, invocationAuthorizationAuthority });
  invocationAuthorities.set(authority, invocationAuthorizationAuthority);
  return authority;
}

async function request(authority?: any, overrides: Record<string, any> = {}) : Promise<any> {
  const base: Record<string, any> = {
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

describe("Plugin controlled execution authority", () : any => {
  it("recovers Host-custodied task ownership after restart and rejects another owner generation", async () : Promise<any> => {
    const userDataPath: any = await root();
    const never: any = new Promise(() : any => {});
    let markRegistered: any;
    const registered: any = new Promise((resolve?: any) : any => { markRegistered = resolve; });
    const first: any = controlledAuthority({ userDataPath });
    first.bind({
      executeConfigured() : any { markRegistered(); return never; },
      cancel() : any { return true; }
    });
    const ownerA: any = owner(first);
    void ownerA.executeTarget(await request(first), async () : Promise<any> => ({ files: [] })).catch(() : any => {});
    await registered;
    first.close();

    const cancellations: any[] = [];
    const recovered: any = controlledAuthority({ userDataPath });
    recovered.bind({
      executeConfigured() : any { return never; },
      async cancel(key?: any) : Promise<any> { cancellations.push(key); return true; }
    });
    const wrongOwner: any = owner(recovered, { ownerId: "plugin-b", ownerGenerationDigest: generationB });
    await expect(wrongOwner.cancelTask(`owned-task:${"c".repeat(40)}`))
      .rejects.toMatchObject({ code: "plugin_controlled_task_owner_mismatch" });
    const recoveredOwner: any = owner(recovered);
    await expect(recoveredOwner.cancelTask(`owned-task:${"c".repeat(40)}`)).resolves.toBe(true);
    expect(cancellations).toEqual(["private-idempotency-value"]);
    await expect(recoveredOwner.verifyNoActiveTasks()).resolves.toEqual({ ok: true, remainingCount: 0 });
    recovered.close();
  });

  it("rejects a target outside the Host-bound allowlist before executing", async () : Promise<any> => {
    const authority: any = controlledAuthority({ userDataPath: await root() });
    let executions: any = 0;
    authority.bind({
      executeConfigured() : any { executions += 1; return { status: "succeeded" }; },
      cancel() : any { return true; }
    });
    const boundOwner: any = owner(authority);
    await expect(boundOwner.executeTarget(await request(authority, { targetRef: "other-target" }), async () : Promise<any> => ({ files: [] })))
      .rejects.toMatchObject({ code: "plugin_controlled_execution_target_denied" });
    expect(executions).toBe(0);
    authority.close();
  });

  it("uses only the Host-configured sandbox policy and scopes output handles to the owner port", async () : Promise<any> => {
    const authority: any = controlledAuthority({ userDataPath: await root() });
    let captured: any;
    authority.bind({
      executeConfigured(input?: any, _provider?: any, options?: any) : any {
        captured = { input, options };
        return { status: "succeeded", outputHandle: "output:owned" };
      },
      cancel() : any { return true; },
      resolveQuarantinedOutput(handle?: any, ownerScope?: any) : any { return { handle, ownerScope }; },
      disposeOutput() : any { return true; }
    });
    const boundOwner: any = owner(authority);
    await expect(boundOwner.executeTarget(await request(authority, {
      workloadKind: "attacker-workload",
      invocation: { command: "attacker" },
      outputs: { maxFiles: 999 },
      capabilities: { network: ["any"] },
      resources: { wallTimeMs: 999_999 }
    }), async () : Promise<any> => ({ files: [] }), {
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

  it("rejects new execution admission after the owner lifecycle leaves active", async () : Promise<any> => {
    const authority: any = controlledAuthority({ userDataPath: await root() });
    let executions: any = 0;
    authority.bind({
      executeConfigured() : any { executions += 1; return { status: "succeeded" }; },
      cancel() : any { return true; }
    });
    const lifecycleStatePort: any = lifecycleAuthority("active");
    const boundOwner: any = owner(authority, { lifecycleStatePort });
    const authorizedRequest: any = await request(authority);
    lifecycleStatePort.setState("removal_pending");
    await expect(boundOwner.executeTarget(authorizedRequest, async () : Promise<any> => ({ files: [] })))
      .rejects.toMatchObject({ code: "plugin_controlled_execution_owner_retired" });
    expect(executions).toBe(0);
    authority.close();
  });

  it("rejects a stale generation port after a newer active generation is installed", async () : Promise<any> => {
    const authority: any = controlledAuthority({ userDataPath: await root() });
    let executions: any = 0;
    authority.bind({ executeConfigured() : any { executions += 1; return { status: "succeeded" }; }, cancel() : any { return true; } });
    const lifecycleStatePort: any = lifecycleAuthority("active", "plugin-a", 1);
    const boundOwner: any = owner(authority, { lifecycleStatePort });
    const authorizedRequest: any = await request(authority);
    lifecycleStatePort.setGeneration(2);
    await expect(boundOwner.executeTarget(authorizedRequest, async () : Promise<any> => ({ files: [] })))
      .rejects.toMatchObject({ code: "plugin_controlled_execution_owner_retired" });
    expect(executions).toBe(0);
    authority.close();
  });
});
