import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.ts";
import { createPluginDataCapability } from "../../../packages/foundation/src/module-system/plugin-data-capability.ts";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";
import { createPluginContributionRegistry } from "../../../packages/server-runtime/src/composition/plugin-contribution-registry.ts";
import {
  applyPluginDeploymentFeatures,
  resolveFeatureRuntime,
} from "../../../packages/server-runtime/src/composition/features/feature-manifest.ts";
import { stagePluginArtifactVerificationFixture } from "./plugin-artifact-verification-fixture.ts";

export async function createPluginDeploymentAuditCatalog({
  repoRoot,
  edition = "core",
  now = new Date("2026-07-01T00:00:00.000Z"),
  pluginConfigurations = {},
}: Record<string, any> = {}) : Promise<any> {
  if (!String(repoRoot || "").trim()) {
    throw new TypeError("Plugin deployment audit requires an explicit repository root.");
  }
  const resolvedRepoRoot: any = path.resolve(String(repoRoot));
  const artifactFixture: any = await stagePluginArtifactVerificationFixture({
    sourcePluginRoot: path.join(resolvedRepoRoot, "plugins")
  });
  const pluginCatalog: any = await loadPluginRegistry({ artifactAuthority: artifactFixture.authority });
  const enabledPluginIds: any = pluginCatalog.listPlugins().map((plugin?: any) : any => plugin.id).sort();
  const deployment: any = pluginCatalog.resolveDeployment({ enabledPluginIds });
  const dataRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-audit-"));
  let pluginRuntime: any = null;

  try {
    pluginRuntime = await activatePluginDeployment({
      deployment,
      artifactAuthority: artifactFixture.authority,
      createContext: async (manifest?: any) : Promise<any> => {
        const pluginDataRoot: any = path.join(dataRoot, "plugins", manifest.id);
        await fs.mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
        return {
          pluginData: await createPluginDataCapability(pluginDataRoot),
          lifecycleStatePort: await createPluginLifecycleStatePort({ userDataPath: dataRoot, pluginId: manifest.id }),
          configuration: pluginConfigurations[manifest.id] || {}
        };
      },
    });
    const featureRuntime: any = applyPluginDeploymentFeatures(
      resolveFeatureRuntime({ edition, now }),
      deployment,
    );
    const contributions: any = createPluginContributionRegistry({
      manifests: pluginCatalog.listPlugins(),
      loadedPlugins: deployment.loadedPlugins,
      contributions: pluginRuntime.contributions,
      coreOperations: SERVER_API_OPERATIONS,
      activeFeatureIds: featureRuntime.activeFeatureIds,
    });
    const operationCatalog: any = createToolCatalog({ operations: contributions.activeOperations });
    let closed: any = false;
    return Object.freeze({
      deployment,
      featureRuntime,
      contributions,
      operations: contributions.activeOperations,
      tools: operationCatalog.tools,
      publicRuntime: contributions.publicRuntime(),
      async close() : Promise<any> {
        if (closed) return;
        await pluginRuntime.close();
        await artifactFixture.close();
        await fs.rm(dataRoot, { recursive: true, force: true });
        closed = true;
      },
    });
  } catch (error: any) {
    try {
      await pluginRuntime?.close?.();
      await artifactFixture.close();
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
