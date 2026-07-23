import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.mjs";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.mjs";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.mjs";
import { createPluginDataCapability } from "../../../packages/foundation/src/module-system/plugin-data-capability.mjs";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";
import { createPluginContributionRegistry } from "../../../packages/server-runtime/src/composition/plugin-contribution-registry.mjs";
import {
  applyPluginDeploymentFeatures,
  resolveFeatureRuntime,
} from "../../../packages/server-runtime/src/composition/features/feature-manifest.mjs";
import { stagePluginArtifactVerificationFixture } from "./plugin-artifact-verification-fixture.mjs";

export async function createPluginDeploymentAuditCatalog({
  repoRoot,
  edition = "core",
  now = new Date("2026-07-01T00:00:00.000Z"),
  pluginConfigurations = {},
} = {}) {
  if (!String(repoRoot || "").trim()) {
    throw new TypeError("Plugin deployment audit requires an explicit repository root.");
  }
  const resolvedRepoRoot = path.resolve(String(repoRoot));
  const artifactFixture = await stagePluginArtifactVerificationFixture({
    sourcePluginRoot: path.join(resolvedRepoRoot, "plugins")
  });
  const pluginCatalog = await loadPluginRegistry({ artifactAuthority: artifactFixture.authority });
  const enabledPluginIds = pluginCatalog.listPlugins().map((plugin) => plugin.id).sort();
  const deployment = pluginCatalog.resolveDeployment({ enabledPluginIds });
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-plugin-audit-"));
  let pluginRuntime = null;

  try {
    pluginRuntime = await activatePluginDeployment({
      deployment,
      artifactAuthority: artifactFixture.authority,
      createContext: async (manifest) => {
        const pluginDataRoot = path.join(dataRoot, "plugins", manifest.id);
        await fs.mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
        return {
          pluginData: await createPluginDataCapability(pluginDataRoot),
          lifecycleStatePort: await createPluginLifecycleStatePort({ userDataPath: dataRoot, pluginId: manifest.id }),
          configuration: pluginConfigurations[manifest.id] || {}
        };
      },
    });
    const featureRuntime = applyPluginDeploymentFeatures(
      resolveFeatureRuntime({ edition, now }),
      deployment,
    );
    const contributions = createPluginContributionRegistry({
      manifests: pluginCatalog.listPlugins(),
      loadedPlugins: deployment.loadedPlugins,
      contributions: pluginRuntime.contributions,
      coreOperations: SERVER_API_OPERATIONS,
      activeFeatureIds: featureRuntime.activeFeatureIds,
    });
    const operationCatalog = createToolCatalog({ operations: contributions.activeOperations });
    let closed = false;
    return Object.freeze({
      deployment,
      featureRuntime,
      contributions,
      operations: contributions.activeOperations,
      tools: operationCatalog.tools,
      publicRuntime: contributions.publicRuntime(),
      async close() {
        if (closed) return;
        await pluginRuntime.close();
        await artifactFixture.close();
        await fs.rm(dataRoot, { recursive: true, force: true });
        closed = true;
      },
    });
  } catch (error) {
    try {
      await pluginRuntime?.close?.();
      await artifactFixture.close();
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
