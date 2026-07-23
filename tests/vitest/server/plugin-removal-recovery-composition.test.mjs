import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverPluginLifecycleStateIds } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";
import { createServerCompositionRoot } from "../../../packages/server-runtime/src/composition/composition-root.mjs";
import { pluginArtifactCoreContractDigest } from "../../../packages/server-runtime/src/composition/plugin-artifact-core-contract.mjs";
import { stagePluginArtifactVerificationFixture } from "../../../tools/server-scripts/lib/plugin-artifact-verification-fixture.mjs";

const resources = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

async function stageSamplePluginFixture() {
  const sourcePluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-removal-source-"));
  resources.push(() => fs.rm(sourcePluginRoot, { recursive: true, force: true }));
  const pluginRoot = path.join(sourcePluginRoot, "sample-plugin");
  await fs.mkdir(pluginRoot);
  await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
    schemaVersion: "v0.0.1:plugin:manifest-1",
    id: "sample-plugin",
    label: "Sample plugin",
    version: "1.0.0",
    defaultEnabled: false,
    dependencies: [],
    features: [],
    operations: [],
    routes: [],
    mcpTools: [],
    consoleEntries: [],
    stateMachines: [],
    verifierHooks: [],
    runtime: { module: "./runtime.mjs" },
    mounts: {},
    mountRouting: {}
  }));
  await fs.writeFile(path.join(pluginRoot, "runtime.mjs"), `
    export async function activatePlugin({ manifest }) {
      return Object.freeze({
        id: manifest.id,
        mounts: Object.freeze({}),
        contributions: Object.freeze({}),
        close: async () => ({ ok: true })
      });
    }
    export async function recoverPluginLifecycle() {
      return Object.freeze({
        transition: async () => ({ ok: true }),
        close: async () => ({ ok: true })
      });
    }
  `);
  return stagePluginArtifactVerificationFixture({
    sourcePluginRoot,
    coreContractDigest: pluginArtifactCoreContractDigest()
  });
}

describe("plugin removal recovery composition", () => {
  it("publishes loaded inactive plugins separately from effective plugins", async () => {
    const fixture = await stageSamplePluginFixture();
    resources.push(() => fixture.close());
    const installed = fixture.installed.get("sample-plugin");
    await installed.lifecycleStatePort.runExclusive(() => installed.lifecycleStatePort.writeRecord("ledger", {
      schemaVersion: "licomesh.plugin-lifecycle-ledger/1",
      pluginId: "sample-plugin",
      state: "inactive",
      operation: "disable",
      idempotencyKey: "inactive-fixture",
      requestDigest: "c".repeat(64),
      generation: installed.generation
    }));

    const composition = await createServerCompositionRoot({
      userDataPath: fixture.dataRoot,
      runtimeOptions: { enabledPlugins: ["sample-plugin"], pluginConfigurations: {} },
      pluginHostPorts: { artifactAuthority: fixture.authority }
    });
    resources.push(() => composition.close());

    expect(composition.publicFeatures().plugins).toMatchObject({
      loadedPlugins: [{ id: "sample-plugin", version: "1.0.0", features: [] }],
      effectivePlugins: []
    });
    expect(composition.publicFeatures().plugins).not.toHaveProperty("enabledPlugins");
  });

  it("finalizes content-removed uninstall state after configuration is removed", async () => {
    const fixture = await stageSamplePluginFixture();
    resources.push(() => fixture.close());
    const installed = fixture.installed.get("sample-plugin");
    await installed.port.remove({
      expectedArtifactDigest: installed.artifactDigest,
      expectedGeneration: installed.generation
    });
    await installed.lifecycleStatePort.runExclusive(async () => {
      await installed.lifecycleStatePort.writeRecord("artifact-removal-journal", {
        schemaVersion: "licomesh.plugin-artifact-removal-journal/1",
        recordType: "artifact_removal",
        pluginId: "sample-plugin",
        artifactDigest: installed.artifactDigest,
        generation: installed.generation,
        phase: "content_removed"
      });
      await installed.lifecycleStatePort.writeRecord("ledger", {
        schemaVersion: "licomesh.plugin-lifecycle-ledger/1",
        pluginId: "sample-plugin",
        state: "removal_pending",
        operation: "uninstall",
        idempotencyKey: "restart-recovery",
        requestDigest: "a".repeat(64),
        generation: installed.generation
      });
    });

    const composition = await createServerCompositionRoot({
      userDataPath: fixture.dataRoot,
      runtimeOptions: { enabledPlugins: [], pluginConfigurations: {} },
      pluginHostPorts: { artifactAuthority: fixture.authority }
    });
    resources.push(() => composition.close());

    expect(await installed.lifecycleStatePort.readRecord("artifact-removal-journal"))
      .toMatchObject({ phase: "completed" });
    expect(await installed.lifecycleStatePort.readRecord("ledger"))
      .toMatchObject({ state: "uninstalled", operation: "uninstall" });
    expect(composition.runtime.plugins.loadedPlugins).toEqual([]);
  });

  it("rejects symbolic links in the persisted lifecycle catalog", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-lifecycle-discovery-"));
    resources.push(() => fs.rm(userDataPath, { recursive: true, force: true }));
    const lifecycleRoot = path.join(userDataPath, "plugin-lifecycle");
    const target = path.join(userDataPath, "target");
    await fs.mkdir(lifecycleRoot);
    await fs.mkdir(target);
    await fs.symlink(target, path.join(lifecycleRoot, "sample-plugin"));

    await expect(discoverPluginLifecycleStateIds({ userDataPath }))
      .rejects.toMatchObject({ code: "PLUGIN_LIFECYCLE_ENTRY_INVALID" });
  });

  it.each([
    ["missing", null],
    ["wrong plugin id", { pluginId: "other-plugin", generation: 1 }],
    ["wrong generation", { pluginId: "sample-plugin", generation: 2 }]
  ])("rejects %s production lifecycle authority", async (_label, override) => {
    const fixture = await stageSamplePluginFixture();
    resources.push(() => fixture.close());
    const installed = fixture.installed.get("sample-plugin");
    const ledgerPath = path.join(fixture.dataRoot, "plugin-lifecycle", "sample-plugin", "ledger.json");
    if (override === null) {
      await fs.rm(ledgerPath);
    } else {
      await installed.lifecycleStatePort.runExclusive(() => installed.lifecycleStatePort.writeRecord("ledger", {
        schemaVersion: "licomesh.plugin-lifecycle-ledger/1",
        pluginId: override.pluginId,
        state: "active",
        operation: "",
        idempotencyKey: "",
        requestDigest: "",
        generation: override.generation
      }));
    }

    await expect(createServerCompositionRoot({
      userDataPath: fixture.dataRoot,
      runtimeOptions: { enabledPlugins: ["sample-plugin"], pluginConfigurations: {} },
      pluginHostPorts: { artifactAuthority: fixture.authority }
    })).rejects.toThrow(/lifecycle authority/u);
  });
});
