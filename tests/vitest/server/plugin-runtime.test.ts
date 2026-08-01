import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPluginRegistry,
  loadPluginRegistry,
  normalizePluginManifest,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  resolvePluginVerifierHookSourceUrl,
  validatePluginDeployment
} from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.ts";
import { createMountManager } from "../../../packages/foundation/src/module-system/mount-manager.ts";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";
import {
  finalizePluginRuntimeReport,
  reducePluginRuntimeAcceptance
} from "../../../tools/server-scripts/verify-plugin-runtime.ts";
import {
  collectPluginRuntimeOwnershipFailures
} from "../../../tools/server-scripts/lib/plugin-runtime-capability-bindings.ts";
import { stagePluginArtifactFixture } from "./support/plugin-artifact-authority-fixture.ts";
import { createTestPluginProcessHost } from "./support/test-plugin-process-host.ts";

const roots: any[] = [];
const artifactFixtures: any[] = [];
const artifactFixturesByRoot: any = new Map<any, any>();

function manifest(id?: any, patch: Record<string, any> = {}) : any {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id,
    label: id,
    version: "0.0.1",
    defaultEnabled: false,
    dependencies: [],
    operations: [],
    routes: [],
    mcpTools: [],
    consoleEntries: [],
    stateMachines: [],
    verifierHooks: [],
    ...patch
  };
}

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-test-"));
  roots.push(root);
  return root;
}

async function writePlugin(root?: any, record?: any, source?: any) : Promise<any> {
  const directory: any = path.join(root, "plugins", record.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.json"), JSON.stringify(record), "utf8");
  if (source) await fs.writeFile(path.join(directory, "runtime.ts"), source, "utf8");
}

async function createManager(root?: any, enabledPlugins: any = []) : Promise<any> {
  const userDataPath: any = path.join(root, "data");
  await fs.mkdir(userDataPath, { recursive: true });
  let fixture: any = artifactFixturesByRoot.get(root);
  if (!fixture) {
    fixture = await stagePluginArtifactFixture({
      sourcePluginRoot: path.join(root, "plugins"),
      lifecycleDataRoot: userDataPath
    });
    artifactFixtures.push(fixture);
    artifactFixturesByRoot.set(root, fixture);
  }
  return createMountManager({
    userDataPath,
    runtimeOptions: { cwd: root, enabledPlugins },
    pluginHostPorts: {
      artifactAuthority: fixture.authority,
      pluginProcessHostForPlugin: () : any => createTestPluginProcessHost()
    }
  });
}

async function loadFixtureRegistry(root?: any) : Promise<any> {
  const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot: path.join(root, "plugins") });
  artifactFixtures.push(fixture);
  return loadPluginRegistry({ artifactAuthority: fixture.authority });
}

afterEach(async () : Promise<any> => {
  delete globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
  artifactFixturesByRoot.clear();
  await Promise.all(artifactFixtures.splice(0).map((fixture?: any) : any => fixture.close()));
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("plugin runtime", () : any => {
  it("propagates selected contribution changes from an active plugin", async () : Promise<any> => {
    const root: any = await tempRoot();
    await writePlugin(root, manifest("demo", {
      runtime: { module: "./runtime.ts" },
      contributionMode: "selected",
      operations: ["demo.run"]
    }), `
const listeners = new Set();
let contributions = { operations: { "demo.run": async () => ({ ok: true }) } };
export async function activatePlugin({ manifest }) {
  globalThis[Symbol.for("meshrix.plugin-runtime.test-events")] = async () => {
    contributions = { operations: {} };
    for (const listener of listeners) await listener(contributions);
  };
  return {
    id: manifest.id,
    mounts: {},
    get contributions() { return contributions; },
    subscribeContributionChanges(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {}
  };
}`);
    const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot: path.join(root, "plugins") });
    artifactFixtures.push(fixture);
    const registry: any = await loadPluginRegistry({ artifactAuthority: fixture.authority });
    const runtime: any = await activatePluginDeployment({
      artifactAuthority: fixture.authority,
      deployment: registry.resolveDeployment({ enabledPluginIds: ["demo"] }),
      createContext: () : any => ({ lifecycleStatePort: fixture.installed.get("demo").lifecycleStatePort })
    });
    const changes: any[] = [];
    const unsubscribe: any = runtime.onPluginContributionChange((change?: any) : any => changes.push(change));
    expect(runtime.contributions.operations["demo.run"]).toBeDefined();
    await globalThis[Symbol.for("meshrix.plugin-runtime.test-events")]();
    expect(runtime.contributions.operations["demo.run"]).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0].pluginId).toBe("demo");
    expect(changes[0].contributions.operations).toEqual({});
    unsubscribe();
    await runtime.close();
  });

  it("fails closed when production artifact activation has no lifecycle ledger", async () : Promise<any> => {
    const root: any = await tempRoot();
    await writePlugin(root, manifest("demo", { runtime: { module: "./runtime.ts" } }), `
export async function activatePlugin({ manifest }) {
  return { id: manifest.id, mounts: {}, close() {} };
}`);
    const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot: path.join(root, "plugins") });
    artifactFixtures.push(fixture);
    const registry: any = await loadPluginRegistry({ artifactAuthority: fixture.authority });
    const lifecycleStatePort: any = fixture.installed.get("demo").lifecycleStatePort;
    await fs.rm(path.join(fixture.dataRoot, "plugin-lifecycle", "demo", "ledger.json"));

    await expect(activatePluginDeployment({
      artifactAuthority: fixture.authority,
      deployment: registry.resolveDeployment({ enabledPluginIds: ["demo"] }),
      createContext: () : any => ({ productionActivation: true, lifecycleStatePort })
    })).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      stage: "context construction"
    });
  });

  it("never imports a production plugin when the isolated process host is unavailable", async () : Promise<any> => {
    const root: any = await tempRoot();
    const importMarker: any = Symbol.for("meshrix.plugin-runtime.production-import-marker");
    delete globalThis[importMarker];
    await writePlugin(root, manifest("demo", { runtime: { module: "./runtime.ts" } }), `
globalThis[Symbol.for("meshrix.plugin-runtime.production-import-marker")] = true;
export async function activatePlugin({ manifest }) {
  return { id: manifest.id, mounts: {}, close() {} };
}`);
    const fixture: any = await stagePluginArtifactFixture({
      sourcePluginRoot: path.join(root, "plugins"),
      lifecycleDataRoot: path.join(root, "production-data")
    });
    artifactFixtures.push(fixture);
    const registry: any = await loadPluginRegistry({ artifactAuthority: fixture.authority });

    await expect(activatePluginDeployment({
      artifactAuthority: fixture.authority,
      deployment: registry.resolveDeployment({ enabledPluginIds: ["demo"] }),
      createContext: () : any => ({
        productionActivation: true,
        lifecycleStatePort: fixture.installed.get("demo").lifecycleStatePort
      })
    })).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      stage: "isolated process host validation",
      reasonCode: "plugin_process_host_required"
    });
    expect(globalThis[importMarker]).toBeUndefined();
  });

  it("uses the capability-local acceptance field and makes every check authoritative", () : any => {
    expect(reducePluginRuntimeAcceptance({
      checks: [{ id: "one", status: "passed" }, { id: "two", status: "passed" }],
      runtimeContractReady: true,
      executableSelectionReady: true,
      pluginOwnershipReady: true
    })).toEqual({
      everyCheckParticipates: true,
      pluginRuntimeAcceptanceReady: true
    });
    expect(reducePluginRuntimeAcceptance({
      checks: [{ id: "one", status: "passed" }, { id: "two", status: "failed" }],
      runtimeContractReady: true,
      executableSelectionReady: true,
      pluginOwnershipReady: true
    })).toEqual({
      everyCheckParticipates: false,
      pluginRuntimeAcceptanceReady: false
    });
  });

  it("keeps an unavailable configured verifier workload source as a fixed failure", async () : Promise<any> => {
    const root: any = await tempRoot();
    await writePlugin(root, manifest("sample-plugin", {
      runtime: { module: "./runtime.ts" },
      verifierHooks: [{
        id: "sample-plugin.verify",
        workloadKind: "plugin_verifier.sample_plugin",
        source: "verifiers/missing.ts",
        report: "build/reports/sample-plugin.json"
      }]
    }), `
export async function activatePlugin({ manifest }) {
  return { id: manifest.id, mounts: {}, close() {} };
}`);
    const registry: any = await loadFixtureRegistry(root);
    await expect(collectPluginRuntimeOwnershipFailures(registry))
      .resolves.toEqual([
        expect.objectContaining({
          pluginId: "sample-plugin",
          reasonCodes: ["verifier_configured_workload_source_unavailable"]
        })
      ]);
  });

  it("resolves only declared verifier workload sources from the verified artifact snapshot", async () : Promise<any> => {
    const root: any = await tempRoot();
    const record: any = manifest("sample-plugin", {
      runtime: { module: "./runtime.ts" },
      verifierHooks: [{
        id: "sample-plugin.verify",
        workloadKind: "plugin_verifier.sample_plugin",
        source: "verifiers/runtime.ts",
        report: "build/reports/sample-plugin.json"
      }]
    });
    await writePlugin(root, record, `
export async function activatePlugin({ manifest }) {
  return { id: manifest.id, mounts: {}, close() {} };
}`);
    const verifierRoot: any = path.join(root, "plugins", "sample-plugin", "verifiers");
    await fs.mkdir(verifierRoot);
    await fs.writeFile(path.join(verifierRoot, "runtime.ts"), "export const verify = true;\n", "utf8");
    const registry: any = await loadFixtureRegistry(root);
    const plugin: any = registry.getPlugin("sample-plugin");

    await expect(resolvePluginVerifierHookSourceUrl(plugin, "sample-plugin.verify"))
      .resolves.toMatchObject({ protocol: "file:" });
    await expect(resolvePluginVerifierHookSourceUrl(plugin, "sample-plugin.undeclared"))
      .rejects.toThrow(/not declared/u);
    await expect(collectPluginRuntimeOwnershipFailures(registry)).resolves.toEqual([]);
  });

  it("publishes leak-scan proof only after the canonical scan succeeds", () : any => {
    const observedFlags: any[] = [];
    const report: Record<string, any> = { summary: { reportLeakScan: true } };

    const finalized: any = finalizePluginRuntimeReport(report, (candidate?: any) : any => {
      observedFlags.push(candidate.summary.reportLeakScan);
    });

    expect(observedFlags).toEqual([false, true]);
    expect(finalized.summary.reportLeakScan).toBe(true);
  });

  it("fails closed without leak-scan proof when the canonical scan rejects the report", () : any => {
    const linuxHomePath: any = ["", "home", "example", "private-runtime.log"].join("/");
    const report: Record<string, any> = {
      checks: [{ id: "fixture", status: "failed", error: linuxHomePath }],
      summary: { reportLeakScan: true }
    };

    expect(() : any => finalizePluginRuntimeReport(report)).toThrow(/local_path/u);
    expect(report.summary.reportLeakScan).toBe(false);
  });

  it("rejects ambiguous manifests, dependency graphs, and runtime paths", () : any => {
    expect(() : any => normalizePluginManifest(manifest("demo", {
      defaultEnabled: true
    }))).toThrow(/explicit deployment selection/u);
    expect(() : any => normalizePluginManifest(manifest("demo", {
      runtime: { module: "../outside.ts" }
    }))).toThrow(/inside the plugin directory/u);
    expect(() : any => normalizePluginManifest({
      ...manifest("demo"),
      unsupported: true
    })).toThrow(/unsupported field/u);
    const opaqueDeclaration: Record<string, any> = {
      schemaVersion: "v0.0.1:plugin:opaque-input-preprocessing-1",
      encoding: "base64",
      sourceField: "contentBase64",
      targetField: "opaqueInput",
      mediaType: "application/octet-stream",
      maxBytes: 1024,
      outputSchemaVersion: "v0.0.1:plugin:opaque-input-handle-1"
    };
    expect(() : any => normalizePluginManifest(manifest("demo", {
      operations: ["demo.run"],
      opaqueInputPreprocessing: { "demo.run": [{ ...opaqueDeclaration, unsupported: true }] }
    }))).toThrow(/unsupported field/u);
    expect(() : any => normalizePluginManifest(manifest("demo", {
      operations: ["demo.run"],
      opaqueInputPreprocessing: { "demo.other": [opaqueDeclaration] }
    }))).toThrow(/declared operation/u);
    const hostPathDeclaration: Record<string, any> = {
      schemaVersion: "v0.0.1:plugin:host-path-input-preprocessing-1",
      kind: "local-directory-selection",
      sourceField: "sourcePath",
      targetField: "mountSelectionRef"
    };
    expect(() : any => normalizePluginManifest(manifest("demo", {
      operations: ["demo.run"],
      hostPathInputPreprocessing: { "demo.run": [{ ...hostPathDeclaration, unsupported: true }] }
    }))).toThrow(/unsupported field/u);
    expect(() : any => normalizePluginManifest(manifest("demo", {
      operations: ["demo.run"],
      hostPathInputPreprocessing: { "demo.other": [hostPathDeclaration] }
    }))).toThrow(/declared operation/u);
    expect(() : any => normalizePluginManifest(manifest("demo", {
      operations: ["demo.run"],
      hostPathInputPreprocessing: { "demo.run": [{ ...hostPathDeclaration, targetField: "sourcePath" }] }
    }))).toThrow(/is invalid/u);
    expect(() : any => createPluginRegistry([
      manifest("alpha", { dependencies: ["beta"] }),
      manifest("beta", { dependencies: ["alpha"] })
    ])).toThrow(/dependency cycle/u);
    expect(() : any => createPluginRegistry([
      manifest("alpha", { operations: ["shared.operation"] }),
      manifest("beta", { operations: ["shared.operation"] })
    ])).toThrow(/Duplicate plugin operation claim/u);
    expect(() : any => createPluginRegistry([
      manifest("alpha", { features: ["shared-feature"] }),
      manifest("beta", { features: ["shared-feature"] })
    ])).toThrow(/Duplicate plugin feature claim/u);
    expect(() : any => createPluginRegistry([
      manifest("alpha", { stateMachines: ["shared.lifecycle"] }),
      manifest("beta", { stateMachines: ["shared.lifecycle"] })
    ])).toThrow(/Duplicate plugin state machine claim/u);
    expect(() : any => createPluginRegistry([
      manifest("alpha", { verifierHooks: [{ id: "shared.verify", workloadKind: "plugin_verifier.alpha", source: "verifiers/alpha.ts" }] }),
      manifest("beta", { verifierHooks: [{ id: "shared.verify", workloadKind: "plugin_verifier.beta", source: "verifiers/beta.ts" }] })
    ])).toThrow(/Duplicate plugin verifier hook claim/u);
  });

  it("keeps deployment profiles explicit and binds their exact deterministic plugin set", () : any => {
    const registry: any = createPluginRegistry([
      manifest("consumer", { dependencies: ["base"] }),
      manifest("base")
    ]);

    const absent: any = registry.resolveDeployment({ enabledPluginIds: [] });
    expect(absent.deploymentProfile).toBeNull();
    expect(absent.enabledPluginIds).toEqual([]);
    expect(absent.loadedPlugins).toEqual([]);

    const first: any = registry.resolveDeployment({
      deploymentProfileId: "private-runtime",
      enabledPluginIds: ["consumer", "base"],
      configuredPluginIds: ["consumer"]
    });
    const second: any = registry.resolveDeployment({
      deploymentProfileId: "private-runtime",
      enabledPluginIds: ["base", "consumer"],
      configuredPluginIds: ["consumer"]
    });
    expect(first.deploymentProfile).toEqual(second.deploymentProfile);
    expect(first.deploymentProfile).toMatchObject({
      id: "private-runtime",
      enabledPluginIds: ["base", "consumer"],
      configuredPluginIds: ["consumer"],
      dependencyOrder: ["base", "consumer"]
    });
    expect(first.deploymentProfile.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.deploymentProfile.pluginIdentities).toEqual([
      expect.objectContaining({ id: "base", version: "0.0.1", manifestDigest: expect.stringMatching(/^sha256:/u) }),
      expect.objectContaining({ id: "consumer", version: "0.0.1", manifestDigest: expect.stringMatching(/^sha256:/u) })
    ]);
    expect(() : any => registry.resolveDeployment({
      deploymentProfileId: "Invalid Profile",
      enabledPluginIds: []
    })).toThrow(/Invalid plugin deployment profile/u);
    expect(() : any => registry.resolveDeployment({
      deploymentProfileId: "",
      enabledPluginIds: []
    })).toThrow(/non-empty string/u);

    const tampered: Record<string, any> = {
      ...first,
      deploymentProfile: {
        ...first.deploymentProfile,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
      }
    };
    expect(() : any => validatePluginDeployment(tampered)).toThrow(/digest does not match/u);
  });

  it("rejects unknown configuration while retaining truth for inactive plugins", () : any => {
    const registry: any = createPluginRegistry([manifest("selected"), manifest("disabled")]);
    expect(() : any => registry.resolveDeployment({
      enabledPluginIds: ["selected"],
      configuredPluginIds: ["missing"]
    })).toThrow(/configured unknown plugin/u);
    const deployment: any = registry.resolveDeployment({
      enabledPluginIds: ["selected"],
      configuredPluginIds: ["disabled"]
    });
    expect(deployment.configuredPluginIds).toEqual(["disabled"]);
    expect(deployment.loadedPlugins.map((plugin?: any) : any => plugin.id)).toEqual(["selected"]);
  });

  it("publishes the exact explicit deployment profile without synthesizing one", async () : Promise<any> => {
    const root: any = await tempRoot();
    await writePlugin(root, manifest("base", { runtime: { module: "./runtime.ts" } }), `
export async function activatePlugin({ manifest }) {
  return { id: manifest.id, mounts: {}, close() {} };
}`);
    const registry: any = await loadFixtureRegistry(root);
    const absentRuntime: any = await activatePluginDeployment({
      deployment: registry.resolveDeployment({ enabledPluginIds: [] })
    });
    expect(absentRuntime.plugins.deploymentProfile).toBeNull();
    expect(absentRuntime.plugins.enabledPluginIds).toEqual([]);
    expect(absentRuntime.plugins.loadedPlugins).toEqual([]);
    await absentRuntime.close();

    const deployment: any = registry.resolveDeployment({
      deploymentProfileId: "explicit-empty-config",
      enabledPluginIds: ["base"],
      configuredPluginIds: []
    });
    const runtime: any = await activatePluginDeployment({ deployment });
    expect(runtime.plugins.deploymentProfile).toEqual(deployment.deploymentProfile);
    expect(runtime.plugins.configuredPluginIds).toEqual([]);
    expect(Object.isFrozen(runtime.plugins.deploymentProfile)).toBe(true);
    await runtime.close();
  });

  it("never imports disabled modules and closes selected modules in reverse dependency order", async () : Promise<any> => {
    const root: any = await tempRoot();
    const eventKey: any = Symbol.for("meshrix.plugin-runtime.test-events");
    globalThis[eventKey] = [];
    await writePlugin(root, manifest("base", {
      runtime: { module: "./runtime.ts" },
      mounts: { base: { id: "base.mount", kind: "document" } }
    }), `
const events = globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
events.push("base:import");
export async function activatePlugin({ manifest, onClose }) {
  events.push("base:activate");
  onClose(() => events.push("base:registered-close"));
  return {
    id: manifest.id,
    mounts: { base: { id: "base.mount", kind: "document" } },
    close() { events.push("base:close"); }
  };
}`);
    await writePlugin(root, manifest("consumer", {
      dependencies: ["base"],
      runtime: { module: "./runtime.ts" },
      mounts: { consumer: { id: "consumer.mount", kind: "document" } },
      mountRouting: {
        extensionRoutes: { txt: { mountName: "consumer", action: "extract" } }
      }
    }), `
const events = globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
events.push("consumer:import");
export async function activatePlugin({ manifest, onClose }) {
  events.push("consumer:activate");
  onClose(() => events.push("consumer:registered-close"));
  return {
    id: manifest.id,
    mounts: { consumer: { id: "consumer.mount", kind: "document" } },
    close() { events.push("consumer:close"); }
  };
}`);

    const disabled: any = await createManager(root);
    expect(globalThis[eventKey]).toEqual([]);
    await disabled.close();

    const enabled: any = await createManager(root, ["consumer", "base"]);
    expect(globalThis[eventKey].filter((event?: any) : any => event.endsWith(":activate"))).toEqual([
      "base:activate",
      "consumer:activate"
    ]);
    expect(enabled.createExecutionView().resolveDocumentRoute({ extension: ".txt" })?.mount.id)
      .toBe("consumer.mount");
    await enabled.close();
    expect(globalThis[eventKey].filter((event?: any) : any => event.includes("close"))).toEqual([
      "consumer:close",
      "consumer:registered-close",
      "base:close",
      "base:registered-close"
    ]);
  });

  it("injects Host capabilities only when both the signed manifest and real user configuration grant them", async () : Promise<any> => {
    const root: any = await tempRoot();
    const eventKey: any = Symbol.for("meshrix.plugin-runtime.test-events");
    globalThis[eventKey] = [];
    const source: any = `
const events = globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
export async function activatePlugin({ manifest, context }) {
  events.push({
    id: manifest.id,
    ownerProcessIdentityHost: context.ownerProcessIdentityHost?.id || "",
    controlledExecutionHost: context.controlledExecutionHost?.id || "",
    protectedRecoveryPort: context.protectedRecoveryPort?.id || "",
    downstreamClientAspectHost: context.downstreamClientAspectHost?.id || "",
    outboundEgressHost: context.outboundEgressHost?.id || ""
  });
  return { id: manifest.id, mounts: {}, close() {} };
}`;
    const claims: any[] = ["owner-process-identity", "controlled-execution", "protected-recovery", "downstream-client-aspect", "outbound-egress-policy"];
    await writePlugin(root, manifest("granted", { runtime: { module: "./runtime.ts" }, hostCapabilities: claims }), source);
    await writePlugin(root, manifest("unconfigured", { runtime: { module: "./runtime.ts" }, hostCapabilities: claims }), source);
    await writePlugin(root, manifest("unclaimed", { runtime: { module: "./runtime.ts" } }), source);
    const fixture: any = await stagePluginArtifactFixture({ sourcePluginRoot: path.join(root, "plugins") });
    artifactFixtures.push(fixture);
    const registry: any = await loadPluginRegistry({ artifactAuthority: fixture.authority });
    const authority: any = (id?: any, portId?: any) : any => ({ id, forOwner: () : any => ({ id: portId }) });
    await fs.mkdir(path.join(root, "data"));
    const runtime: any = await activatePluginDeployment({
      artifactAuthority: fixture.authority,
      deployment: registry.resolveDeployment({ enabledPluginIds: ["granted", "unconfigured", "unclaimed"] }),
      createContext: async (record?: any) : Promise<any> => ({
        lifecycleStatePort: await createPluginLifecycleStatePort({
          userDataPath: path.join(root, "data"), pluginId: record.id
        }),
        configuration: record.id === "unconfigured" ? {} : { hostCapabilities: claims },
        pluginOwnerProcessIdentityAuthority: authority("PluginOwnerProcessIdentityAuthority", "OwnerProcessIdentityHostPort"),
        pluginControlledExecutionAuthority: authority("PluginControlledExecutionAuthority", "ControlledExecutionHostPort"),
        pluginProtectedRecoveryAuthority: authority("PluginProtectedRecoveryAuthority", "ProtectedRecoveryPort"),
        pluginDownstreamClientAspectAuthority: authority("PluginDownstreamClientAspectAuthority", "DownstreamClientAspectHostPort"),
        pluginOutboundEgressAuthority: authority("PluginOutboundEgressAuthority", "OutboundEgressHostPort")
      })
    });
    expect(globalThis[eventKey]).toEqual([
      {
        id: "granted",
        ownerProcessIdentityHost: "OwnerProcessIdentityHostPort",
        controlledExecutionHost: "ControlledExecutionHostPort",
        protectedRecoveryPort: "ProtectedRecoveryPort",
        downstreamClientAspectHost: "DownstreamClientAspectHostPort",
        outboundEgressHost: "OutboundEgressHostPort"
      },
      { id: "unclaimed", ownerProcessIdentityHost: "", controlledExecutionHost: "", protectedRecoveryPort: "", downstreamClientAspectHost: "", outboundEgressHost: "" },
      { id: "unconfigured", ownerProcessIdentityHost: "", controlledExecutionHost: "", protectedRecoveryPort: "", downstreamClientAspectHost: "", outboundEgressHost: "" }
    ]);
    await runtime.close();
  });

  it("registers an exact executable contribution set for every manifest claim", async () : Promise<any> => {
    const root: any = await tempRoot();
    await writePlugin(root, manifest("contributor", {
      runtime: { module: "./runtime.ts" },
      operations: ["contributor.run"],
      routes: [{ id: "contributor.route", path: "/contributor", kind: "http" }],
      mcpTools: ["contributor.tool"],
      consoleEntries: ["admin.contributor"],
      stateMachines: ["contributor.lifecycle"],
      verifierHooks: [{ id: "contributor.verify", workloadKind: "plugin_verifier.contributor", source: "verifiers/contributor.ts" }]
    }), `
export async function activatePlugin({ manifest }) {
  return {
    id: manifest.id,
    mounts: {},
    contributions: {
      operations: { "contributor.run": async () => ({ ok: true }) },
      routes: { "contributor.route": { method: "POST" } },
      mcpTools: { "contributor.tool": async () => ({ content: [] }) },
      consoleEntries: { "admin.contributor": { component: "ContributorView" } },
      stateMachines: { "contributor.lifecycle": { initialState: "ready" } }
    },
    close() {}
  };
}`);

    const manager: any = await createManager(root, ["contributor"]);
    const contributions: any = manager.createExecutionView().contributions;
    expect(Object.keys(contributions.operations)).toEqual(["contributor.run"]);
    expect(contributions.operations["contributor.run"]).toMatchObject({
      id: "contributor.run",
      kind: "operations",
      pluginId: "contributor"
    });
    await expect(contributions.operations["contributor.run"].implementation()).resolves.toEqual({ ok: true });
    expect(contributions.routes["contributor.route"].implementation).toEqual({ method: "POST" });
    expect(Object.keys(contributions.mcpTools)).toEqual(["contributor.tool"]);
    expect(Object.keys(contributions.consoleEntries)).toEqual(["admin.contributor"]);
    expect(Object.keys(contributions.stateMachines)).toEqual(["contributor.lifecycle"]);
    expect(Object.keys(contributions.verifierHooks)).toEqual(["contributor.verify"]);
    await manager.close();
  });

  it("fails closed when runtime contributions omit or invent manifest claims", async () : Promise<any> => {
    const root: any = await tempRoot();
    await writePlugin(root, manifest("mismatch", {
      runtime: { module: "./runtime.ts" },
      operations: ["mismatch.required"]
    }), `
export async function activatePlugin({ manifest }) {
  return {
    id: manifest.id,
    mounts: {},
    contributions: { operations: { "mismatch.invented": () => null } },
    close() {}
  };
}`);

    await expect(createManager(root, ["mismatch"])).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      pluginId: "mismatch",
      stage: "activation contract validation"
    });
  });

  it("unwinds earlier and in-progress resources when activation fails", async () : Promise<any> => {
    const root: any = await tempRoot();
    const eventKey: any = Symbol.for("meshrix.plugin-runtime.test-events");
    globalThis[eventKey] = [];
    await writePlugin(root, manifest("alpha", {
      runtime: { module: "./runtime.ts" }
    }), `
const events = globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
export async function activatePlugin({ manifest, onClose }) {
  events.push("alpha:activate");
  onClose(() => events.push("alpha:registered-close"));
  return { id: manifest.id, mounts: {}, close() { events.push("alpha:close"); } };
}`);
    await writePlugin(root, manifest("beta", {
      runtime: { module: "./runtime.ts" }
    }), `
const events = globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
export async function activatePlugin({ onClose }) {
  events.push("beta:activate");
  onClose(() => events.push("beta:registered-close"));
  throw Object.assign(new Error("sensitive fixture detail"), { code: "fixture_activation_denied" });
}`);

    await expect(createManager(root, ["alpha", "beta"]))
      .rejects.toMatchObject({
        code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
        pluginId: "beta",
        stage: "activation",
        reasonCode: "fixture_activation_denied",
        message: "Plugin beta failed during activation."
      });
    expect(globalThis[eventKey]).toEqual([
      "alpha:activate",
      "beta:activate",
      "beta:registered-close",
      "alpha:close",
      "alpha:registered-close"
    ]);
  });

  it("surfaces close failure only after every registered cleanup has run", async () : Promise<any> => {
    const root: any = await tempRoot();
    const eventKey: any = Symbol.for("meshrix.plugin-runtime.test-events");
    globalThis[eventKey] = [];
    await writePlugin(root, manifest("demo", {
      runtime: { module: "./runtime.ts" }
    }), `
const events = globalThis[Symbol.for("meshrix.plugin-runtime.test-events")];
export async function activatePlugin({ manifest, onClose }) {
  onClose(() => events.push("registered-close"));
  return {
    id: manifest.id,
    mounts: {},
    close() { events.push("result-close"); throw new Error("sensitive close detail"); }
  };
}`);

    const manager: any = await createManager(root, ["demo"]);
    await expect(manager.close()).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_CLOSE_FAILED",
      message: "Plugin runtime resource shutdown did not complete cleanly."
    });
    expect(globalThis[eventKey]).toEqual(["result-close", "registered-close"]);
    await expect(manager.close()).rejects.toMatchObject({ code: "PLUGIN_RUNTIME_CLOSE_FAILED" });
    expect(globalThis[eventKey]).toEqual([
      "result-close", "registered-close", "result-close"
    ]);
  });

  it("rejects plugin data directory symlinks before plugin activation", async () : Promise<any> => {
    const root: any = await tempRoot();
    const outside: any = path.join(root, "outside");
    const pluginDataRoot: any = path.join(root, "data", "plugins");
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(pluginDataRoot, { recursive: true });
    await fs.symlink(outside, path.join(pluginDataRoot, "demo"));
    await writePlugin(root, manifest("demo", {
      runtime: { module: "./runtime.ts" }
    }), `
export async function activatePlugin({ manifest }) {
  throw new Error("activation must not run");
}
`);

    await expect(createManager(root, ["demo"])).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_ACTIVATION_FAILED",
      pluginId: "demo",
      stage: "context construction"
    });
  });

  it.runIf(process.platform !== "win32")("restricts existing plugin data directories before activation", async () : Promise<any> => {
    const root: any = await tempRoot();
    const pluginDataPath: any = path.join(root, "data", "plugins", "demo");
    await fs.mkdir(pluginDataPath, { recursive: true, mode: 0o755 });
    await fs.chmod(path.dirname(pluginDataPath), 0o755);
    await fs.chmod(pluginDataPath, 0o755);
    await writePlugin(root, manifest("demo", {
      runtime: { module: "./runtime.ts" }
    }), `
export async function activatePlugin({ manifest }) {
  return { id: manifest.id, mounts: {}, close() {} };
}
`);

    const manager: any = await createManager(root, ["demo"]);
    expect((await fs.stat(path.dirname(pluginDataPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(pluginDataPath)).mode & 0o777).toBe(0o700);
    await manager.close();
  });
});
