import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";
import { loadPluginRegistry, PLUGIN_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.ts";
import { createMountManager } from "../../../packages/foundation/src/module-system/mount-manager.ts";
import { stagePluginArtifactFixture } from "./support/plugin-artifact-authority-fixture.ts";
import { createTestPluginProcessHost } from "./support/test-plugin-process-host.ts";

const roots: any[] = [];
const artifactFixtures: any[] = [];

async function root() : Promise<any> {
  const value: any = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-lifecycle-test-"));
  roots.push(value);
  await fs.mkdir(path.join(value, "data"));
  return value;
}

async function writePlugin(repoRoot?: any, id?: any, source?: any, { dependencies = [] }: Record<string, any> = {}) : Promise<any> {
  const directory: any = path.join(repoRoot, "plugins", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.json"), JSON.stringify({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    label: id,
    version: "0.0.1",
    defaultEnabled: false,
    dependencies,
    operations: [`${id}.run`],
    routes: [{ id: `${id}.run`, path: `/api/${id}`, kind: "http" }],
    mcpTools: [],
    consoleEntries: [],
    stateMachines: [],
    verifierHooks: [],
    runtime: { module: "./runtime.mjs" }
  }));
  await fs.writeFile(path.join(directory, "runtime.mjs"), source);
}

function runtimeSource(id?: any) : any {
  return `
const state = globalThis[Symbol.for("plugin-lifecycle-transition-test")];
export async function activatePlugin({ manifest }) {
  return {
    id: manifest.id,
    mounts: {},
    contributions: {
      operations: { "${id}.run": { definition: { id: "${id}.run" }, execute: async () => ({ ok: true }) } },
      routes: { "${id}.run": { operationId: "${id}.run" } }
    },
    lifecycle: {
      async prepareTransition(request) {
        state.prepared?.push({ id: manifest.id, generation: request.generation });
        const control = state.controls.get(manifest.id);
        if (control.prepareFail) throw new Error("controlled prepare failure");
        return control.prepareInvalid ? { ok: false } : { ok: true, journalDigest: "a".repeat(64) };
      },
      async abortPreparedTransition(request) {
        state.aborted?.push({ id: manifest.id, generation: request.generation });
        const control = state.controls.get(manifest.id);
        if (control.abortFail) throw new Error("controlled abort failure");
        return { ok: true };
      },
      async transition(request) {
        state.observed.push({ id: manifest.id, generation: request.generation, input: request.input });
        const control = state.controls.get(manifest.id);
        if (control.fail) { control.fail = false; throw new Error("controlled"); }
        if (control.promise) await control.promise;
        return request.operation === "disable"
          ? { ok: true, state: "inactive" }
          : { ok: true, state: "removal_ready", cleanupReceiptDigest: "b".repeat(64) };
      }
    },
    close() { state.closed.push(manifest.id); }
  };
}`;
}

async function loadFixtureRegistry(repoRoot?: any) : Promise<any> {
  const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot: path.join(repoRoot, "plugins") });
  artifactFixtures.push(fixture);
  return loadPluginRegistry({ artifactAuthority: fixture.authority });
}

async function createFixtureManager(repoRoot?: any) : Promise<any> {
  const fixture: any = await stagePluginArtifactFixture({
    sourcePluginRoot: path.join(repoRoot, "plugins"),
    lifecycleDataRoot: path.join(repoRoot, "data")
  });
  artifactFixtures.push(fixture);
  return createMountManager({
    userDataPath: path.join(repoRoot, "data"),
    runtimeOptions: { cwd: repoRoot, enabledPlugins: ["alpha"] },
    pluginHostPorts: {
      artifactAuthority: fixture.authority,
      pluginProcessHostForPlugin: () : any => createTestPluginProcessHost()
    }
  });
}

afterEach(async () : Promise<any> => {
  delete globalThis[Symbol.for("plugin-lifecycle-transition-test")];
  await Promise.all(artifactFixtures.splice(0).map((fixture?: any) : any => fixture.close()));
  await Promise.all(roots.splice(0).map((entry?: any) : any => fs.rm(entry, { recursive: true, force: true })));
});

describe("canonical plugin lifecycle transition", () : any => {
  it("requires active dependents to transition before their dependency", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    await writePlugin(repoRoot, "beta", runtimeSource("beta"), { dependencies: ["alpha"] });
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [], controls: new Map<any, any>([["alpha", {}], ["beta", {}]])
    };
    const registry: any = await loadFixtureRegistry(repoRoot);
    const runtime: any = await activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: ["alpha", "beta"] })
    });
    expect(() : any => runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "alpha-disable",
      expectedGeneration: 1, input: {}
    })).toThrow(expect.objectContaining({
      code: "PLUGIN_LIFECYCLE_DEPENDENTS_ACTIVE",
      dependentPluginIds: ["beta"]
    }));
    await runtime.transitionPluginLifecycle({
      pluginId: "beta", operation: "disable", idempotencyKey: "beta-disable",
      expectedGeneration: 1, input: {}
    });
    await expect(runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "alpha-disable",
      expectedGeneration: 2, input: {}
    })).resolves.toMatchObject({ state: "inactive" });
    await runtime.close();
  });

  it("joins the same persisted request across runtime instances under one lifecycle lease", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [], controls: new Map<any, any>([["alpha", {}]])
    };
    const registry: any = await loadFixtureRegistry(repoRoot);
    const deployment: any = registry.resolveDeployment({ enabledPluginIds: ["alpha"] });
    const port: any = await createPluginLifecycleStatePort({ userDataPath: path.join(repoRoot, "data"), pluginId: "alpha" });
    const createContext: any = () : any => ({ lifecycleStatePort: port });
    const firstRuntime: any = await activatePluginDeployment({ deployment, createContext });
    const secondRuntime: any = await activatePluginDeployment({ deployment, createContext });
    const request: Record<string, any> = {
      pluginId: "alpha", operation: "disable", idempotencyKey: "shared-disable",
      expectedGeneration: 1, input: { reason: "same" }
    };
    const [first, second] = await Promise.all([
      firstRuntime.transitionPluginLifecycle(request),
      secondRuntime.transitionPluginLifecycle(request)
    ]);
    expect(first).toMatchObject({ state: "inactive", generation: 2 });
    expect(second).toMatchObject({ state: "inactive", generation: 2, resumed: true });
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].observed).toHaveLength(1);
    await firstRuntime.close();
    await secondRuntime.close();
  });

  it("removes contributions immediately and fences concurrent plugin transitions with immutable input", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    await writePlugin(repoRoot, "beta", runtimeSource("beta"));
    let resolveAlpha: any;
    let resolveBeta: any;
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [],
      controls: new Map<any, any>([
        ["alpha", { promise: new Promise((resolve?: any) : any => { resolveAlpha = resolve; }) }],
        ["beta", { promise: new Promise((resolve?: any) : any => { resolveBeta = resolve; }) }]
      ])
    };
    const registry: any = await loadFixtureRegistry(repoRoot);
    const runtime: any = await activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: ["alpha", "beta"] })
    });
    const mutableInput: Record<string, any> = { nested: { value: "original" } };
    const alpha: any = runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "alpha-disable",
      expectedGeneration: 1, input: mutableInput
    });
    mutableInput.nested.value = "changed";
    await new Promise((resolve?: any) : any => setImmediate(resolve));
    expect(runtime.contributions.operations["alpha.run"]).toBeUndefined();
    expect(runtime.mountRouting.kindRoutes).toEqual({});
    const beta: any = runtime.transitionPluginLifecycle({
      pluginId: "beta", operation: "disable", idempotencyKey: "beta-disable",
      expectedGeneration: 2, input: { reason: "test" }
    });
    expect(() : any => runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "alpha-disable",
      input: { nested: { value: "original" } }
    })).toThrow(/transition/u);
    resolveBeta();
    resolveAlpha();
    await expect(Promise.all([alpha, beta])).resolves.toEqual([
      expect.objectContaining({ state: "inactive", generation: 2 }),
      expect.objectContaining({ state: "inactive", generation: 3 })
    ]);
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "alpha", generation: 2, input: { nested: { value: "original" } } }),
      expect.objectContaining({ id: "beta", generation: 3 })
    ]));
    await runtime.close();
  });

  it("recovers only the same canonical request and makes close wait for the active transition", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [], controls: new Map<any, any>([["alpha", { fail: true }]])
    };
    const registry: any = await loadFixtureRegistry(repoRoot);
    const lifecycleStatePort: any = await createPluginLifecycleStatePort({
      userDataPath: path.join(repoRoot, "data"), pluginId: "alpha"
    });
    const artifactAuthority: any = artifactFixtures.at(-1).authority;
    const runtime: any = await activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: ["alpha"] }),
      artifactAuthority,
      createContext: () : any => ({ lifecycleStatePort })
    });
    await expect(runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "uninstall", idempotencyKey: "remove",
      expectedGeneration: 1, input: { evidence: { digest: "one" } }
    })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_TRANSITION_FAILED", generation: 2 });
    expect(() : any => runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "uninstall", idempotencyKey: "remove",
      expectedGeneration: 2, input: { evidence: { digest: "two" } }
    })).toThrow(/transition/u);
    let resolveRetry: any;
    globalThis[Symbol.for("plugin-lifecycle-transition-test")].controls.get("alpha").promise =
      new Promise((resolve?: any) : any => { resolveRetry = resolve; });
    const retry: any = runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "uninstall", idempotencyKey: "remove",
      expectedGeneration: 2, input: { evidence: { digest: "one" } }
    });
    const closing: any = runtime.close();
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].closed).toEqual([]);
    resolveRetry();
    await expect(retry).resolves.toMatchObject({ state: "uninstalled", generation: 3 });
    await closing;
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].closed).toEqual(["alpha"]);
  });

  it("rechecks the mount generation fence after earlier queued mutations", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [], controls: new Map<any, any>([["alpha", {}]])
    };
    const manager: any = await createFixtureManager(repoRoot);
    const reload: any = manager.reloadMounts();
    const transition: any = manager.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "disable",
      expectedGeneration: 1, input: {}
    });
    await reload;
    await expect(transition).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_FENCE_MISMATCH", generation: 2 });
    await manager.close();
  });

  it("does not start a lifecycle hook when the admission authority update fails", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [], controls: new Map<any, any>([["alpha", {}]])
    };
    const manager: any = await createFixtureManager(repoRoot);
    const unregister: any = manager.onPluginLifecycleTransition({
      prepare() : any { throw new Error("listener detail"); }
    });
    await expect(manager.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "disable",
      expectedGeneration: 1, input: {}
    })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_ADMISSION_UPDATE_FAILED", generation: 1 });
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].observed).toEqual([]);
    expect(manager.createExecutionView().contributions.operations["alpha.run"]).toBeDefined();
    unregister();
    await manager.close();
  });

  it("keeps admission closed when an irreversible Host cleanup fails and resumes it", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], closed: [], controls: new Map<any, any>([["alpha", {}]])
    };
    const manager: any = await createFixtureManager(repoRoot);
    let irreversibleAttempts: any = 0;
    let rollbacks: any = 0;
    const unregister: any = manager.onPluginLifecycleTransition({
      prepare(context?: any) : any {
        expect(context.artifactGenerationDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(context.artifactGenerationDigest).toBe(manager.getPluginArtifactGenerationDigest("alpha"));
        return {
          commit() : any {},
          rollback() : any { rollbacks += 1; },
          commitIrreversible() : any {
            irreversibleAttempts += 1;
            if (irreversibleAttempts === 1) throw new Error("controlled irreversible failure");
          }
        };
      }
    });
    await expect(manager.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "irreversible-retry",
      expectedGeneration: 1, input: {}
    })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_TRANSITION_FAILED", generation: 2 });
    expect(manager.createExecutionView().contributions.operations["alpha.run"]).toBeUndefined();
    expect(rollbacks).toBe(0);
    await expect(manager.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "irreversible-retry",
      expectedGeneration: 2, input: {}
    })).resolves.toMatchObject({ state: "inactive", generation: 3 });
    expect(irreversibleAttempts).toBe(2);
    unregister();
    await manager.close();
  });

  it("aborts a prepared transaction when the prepare receipt is invalid", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], prepared: [], aborted: [], closed: [],
      controls: new Map<any, any>([["alpha", { prepareInvalid: true }]])
    };
    const registry: any = await loadFixtureRegistry(repoRoot);
    const port: any = await createPluginLifecycleStatePort({ userDataPath: path.join(repoRoot, "data"), pluginId: "alpha" });
    const runtime: any = await activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: ["alpha"] }),
      createContext: () : any => ({ lifecycleStatePort: port })
    });
    await expect(runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "invalid-prepare",
      expectedGeneration: 1, input: {}
    })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_TRANSITION_FAILED", generation: 2 });
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].prepared).toHaveLength(1);
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].aborted).toHaveLength(1);
    expect(await port.readRecord("ledger")).toBeNull();
    expect(runtime.contributions.operations["alpha.run"]).toBeDefined();
    await runtime.close();
  });

  it("aborts preparation and restores visibility when the pending ledger write fails", async () : Promise<any> => {
    const repoRoot: any = await root();
    await writePlugin(repoRoot, "alpha", runtimeSource("alpha"));
    globalThis[Symbol.for("plugin-lifecycle-transition-test")] = {
      observed: [], prepared: [], aborted: [], closed: [], controls: new Map<any, any>([["alpha", {}]])
    };
    const registry: any = await loadFixtureRegistry(repoRoot);
    const durablePort: any = await createPluginLifecycleStatePort({ userDataPath: path.join(repoRoot, "data"), pluginId: "alpha" });
    let rejectedPendingWrite: any = false;
    const failingPort: Readonly<Record<string, any>> = Object.freeze({
      readRecord: (...args: any[]) : any => durablePort.readRecord(...args),
      runExclusive: (...args: any[]) : any => durablePort.runExclusive(...args),
      async writeRecord(name?: any, value?: any) : Promise<any> {
        if (name === "ledger" && value?.state === "removal_pending" && !rejectedPendingWrite) {
          rejectedPendingWrite = true;
          throw Object.assign(new Error("controlled ledger write failure"), { code: "PLUGIN_LIFECYCLE_STATE_WRITE_FAILED" });
        }
        return durablePort.writeRecord(name, value);
      }
    });
    const runtime: any = await activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: ["alpha"] }),
      createContext: () : any => ({ lifecycleStatePort: failingPort })
    });
    await expect(runtime.transitionPluginLifecycle({
      pluginId: "alpha", operation: "disable", idempotencyKey: "ledger-failure",
      expectedGeneration: 1, input: {}
    })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_TRANSITION_FAILED", generation: 2 });
    expect(globalThis[Symbol.for("plugin-lifecycle-transition-test")].aborted).toHaveLength(1);
    expect(await durablePort.readRecord("ledger")).toMatchObject({ state: "active", generation: 1 });
    expect(runtime.contributions.operations["alpha.run"]).toBeDefined();
    await runtime.close();
  });

  it("keeps lifecycle records bounded, immutable, and protected from symlink tampering", async () : Promise<any> => {
    const repoRoot: any = await root();
    await expect(createPluginLifecycleStatePort({ pluginId: "alpha" })).rejects.toThrow(/explicit data root/u);
    const port: any = await createPluginLifecycleStatePort({ userDataPath: path.join(repoRoot, "data"), pluginId: "alpha" });
    await port.writeRecord("journal", { state: "in_progress", nested: { step: 1 } });
    const record: any = await port.readRecord("journal");
    expect(Object.isFrozen(record.nested)).toBe(true);
    expect(() : any => { record.nested.step = 2; }).toThrow();
    await expect(port.writeRecord("journal", { payload: "x".repeat(70_000) })).rejects.toThrow(/bounded size/u);
    const stateRoot: any = path.join(repoRoot, "data", "plugin-lifecycle", "alpha");
    await fs.rm(path.join(stateRoot, "ledger.json"), { force: true });
    await fs.symlink(path.join(stateRoot, "journal.json"), path.join(stateRoot, "ledger.json"));
    await expect(port.readRecord("ledger")).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_STATE_READ_FAILED" });
    await expect(port.writeRecord("ledger", { state: "inactive" })).rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_STATE_WRITE_FAILED" });
  });
});
