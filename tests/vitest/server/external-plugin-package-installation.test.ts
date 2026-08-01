import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginArtifactAuthority } from "../../../packages/foundation/src/module-system/plugin-artifact-authority.ts";
import { createPluginDataCapability } from "../../../packages/foundation/src/module-system/plugin-data-capability.ts";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";
import { installPluginPackageArchive } from "../../../packages/foundation/src/module-system/plugin-package-artifact-installer.ts";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.ts";
import { pluginArtifactCoreContractDigest } from "../../../packages/server-runtime/src/composition/plugin-artifact-core-contract.ts";
import { createPluginContributionRegistry } from "../../../packages/server-runtime/src/composition/plugin-contribution-registry.ts";

const resources: any[] = [];

afterEach(async () : Promise<any> => {
  for (const close of resources.splice(0).reverse()) await close();
});

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function artifactSigner(privateKey?: any, keyId?: any) : any {
  return Object.freeze({
    id: "ArtifactSignerPort",
    async sign({ purpose, payloadDigest, context }: Record<string, any>) : Promise<any> {
      const contextDigest: any = `sha256:${crypto.createHash("sha256").update(canonicalJson(context)).digest("hex")}`;
      const signedEnvelope: Readonly<Record<string, any>> = Object.freeze({ purpose, payloadDigest, contextDigest });
      return Object.freeze({
        ok: true,
        algorithm: "ed25519",
        payloadEncoding: "sha256-digest-utf8",
        keyId,
        payloadDigest,
        contextDigest,
        signedEnvelope,
        signature: crypto.sign(null, Buffer.from(canonicalJson(signedEnvelope)), privateKey).toString("base64url")
      });
    }
  });
}

async function installAndActivatePackage({ packagePath, pluginId, configuration }: Record<string, any>) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "external-plugin-package-"));
  resources.push(() : any => fs.rm(root, { recursive: true, force: true }));
  const bytes: any = await fs.readFile(packagePath);
  const packageDigest: any = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId: any = "ed25519:test-external-plugin-package";
  const coreContractDigest: any = pluginArtifactCoreContractDigest();
  const dataRoot: any = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const authority: any = await createPluginArtifactAuthority({
    artifactRoot: path.join(root, "artifacts"),
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: artifactSigner(privateKey, keyId),
    secretRef: "secret://fixture/external-plugin-package",
    coreContractDigest
  });
  const lifecycleStatePort: any = await createPluginLifecycleStatePort({
    userDataPath: dataRoot,
    pluginId
  });
  const receipt: any = await installPluginPackageArchive({
    bytes,
    expectedPackageDigest: packageDigest,
    pluginId,
    generation: 1,
    artifactAuthority: authority,
    lifecycleStatePort,
    stagingRoot: path.join(root, "staging"),
    coreContractDigest
  });
  const registry: any = await loadPluginRegistry({ artifactAuthority: authority });
  const deployment: any = registry.resolveDeployment({ enabledPluginIds: [pluginId] });
  const pluginDataRoot: any = path.join(root, "plugin-data", pluginId);
  await fs.mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
  const runtime: any = await activatePluginDeployment({
    deployment,
    artifactAuthority: authority,
    createContext: async () : Promise<any> => ({
      lifecycleStatePort,
      pluginData: await createPluginDataCapability(pluginDataRoot),
      configuration: Object.freeze(configuration)
    })
  });
  resources.push(() : any => runtime.close());
  return Object.freeze({ deployment, packageDigest, receipt, registry, runtime });
}

async function installAndActivatePackages(packages?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "external-plugin-package-set-"));
  resources.push(() : any => fs.rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId: any = "ed25519:test-external-plugin-package-set";
  const coreContractDigest: any = pluginArtifactCoreContractDigest();
  const dataRoot: any = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const authority: any = await createPluginArtifactAuthority({
    artifactRoot: path.join(root, "artifacts"),
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: artifactSigner(privateKey, keyId),
    secretRef: "secret://fixture/external-plugin-package-set",
    coreContractDigest
  });
  const lifecycleStates: any = new Map<any, any>();
  const configurations: any = new Map<any, any>();
  const receipts: any[] = [];
  for (const plugin of packages) {
    const bytes: any = await fs.readFile(plugin.packagePath);
    const packageDigest: any = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const lifecycleStatePort: any = await createPluginLifecycleStatePort({
      userDataPath: dataRoot,
      pluginId: plugin.pluginId
    });
    lifecycleStates.set(plugin.pluginId, lifecycleStatePort);
    configurations.set(plugin.pluginId, Object.freeze(plugin.configuration));
    receipts.push(await installPluginPackageArchive({
      bytes,
      expectedPackageDigest: packageDigest,
      pluginId: plugin.pluginId,
      generation: 1,
      artifactAuthority: authority,
      lifecycleStatePort,
      stagingRoot: path.join(root, "staging"),
      coreContractDigest
    }));
  }
  const registry: any = await loadPluginRegistry({ artifactAuthority: authority });
  const pluginIds: any = packages.map((plugin?: any) : any => plugin.pluginId);
  const deployment: any = registry.resolveDeployment({ enabledPluginIds: pluginIds });
  const runtime: any = await activatePluginDeployment({
    deployment,
    artifactAuthority: authority,
    createContext: async (manifest?: any) : Promise<any> => {
      const pluginDataRoot: any = path.join(root, "plugin-data", manifest.id);
      await fs.mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
      return {
        lifecycleStatePort: lifecycleStates.get(manifest.id),
        pluginData: await createPluginDataCapability(pluginDataRoot),
        configuration: configurations.get(manifest.id)
      };
    }
  });
  resources.push(() : any => runtime.close());
  return Object.freeze({ deployment, receipts: Object.freeze(receipts), registry, runtime });
}

async function expectVerifiedConsoleAsset({ deployment, registry, runtime, receipt, entryId, componentId }: Record<string, any>) : Promise<any> {
  const contributions: any = createPluginContributionRegistry({
    manifests: registry.listPlugins(),
    loadedPlugins: deployment.loadedPlugins,
    contributions: runtime.contributions,
    coreOperations: [],
    activeFeatureIds: []
  });
  const consoleEntry: any = contributions.publicRuntime().consoleEntries.find((entry?: any) : any => entry.id === entryId);
  expect(consoleEntry).toMatchObject({
    pluginId: receipt.pluginId,
    componentId,
    artifactDigest: receipt.artifactDigest,
    artifactGeneration: 1
  });
  const consoleAsset: any = await contributions.readConsoleAsset(consoleEntry.assetUrl);
  expect(consoleAsset.bytes.toString("utf8")).toContain("mountPluginConsole");
}

describe("external plugin package installation", () : any => {
  const sharedSpacePackagePath: any = String(process.env.MESHRIX_TEST_SHARED_SPACE_PACKAGE || "").trim();
  const skillHubPackagePath: any = String(process.env.MESHRIX_TEST_SKILL_HUB_PACKAGE || "").trim();
  const codingGithubPackagePath: any = String(process.env.MESHRIX_TEST_CODING_GITHUB_PACKAGE || "").trim();

  (sharedSpacePackagePath ? it : it.skip)("installs and activates Shared Space from an explicitly supplied closed package", async () : Promise<any> => {
    const { deployment, packageDigest, receipt, registry, runtime } = await installAndActivatePackage({
      packagePath: sharedSpacePackagePath,
      pluginId: "shared-space",
      configuration: {
        enabled: true,
        modules: { localDirectory: true, controlledSandbox: true }
      }
    });
    expect(receipt).toMatchObject({
      schemaVersion: "v0.0.1:meshrix:plugin-package-installation-receipt-1",
      pluginId: "shared-space",
      packageDigest,
      generation: 1,
      state: "active"
    });
    expect(runtime.plugins.loadedPlugins).toEqual([{ id: "shared-space", version: "0.0.1" }]);
    expect(Object.keys(runtime.contributions.operations)).toHaveLength(21);
    expect(Object.keys(runtime.contributions.routes)).toHaveLength(21);
    expect(Object.keys(runtime.contributions.mcpTools)).toHaveLength(21);
    expect(runtime.contributions.consoleEntries["workspaces.local-directory"]).toMatchObject({
      pluginId: "shared-space",
      implementation: {
        componentId: "shared-space/WorkspaceLocalDirectoryPanel",
        assetPath: "console/index.ts",
        assetExport: "mountPluginConsole"
      }
    });
    await expectVerifiedConsoleAsset({
      deployment,
      registry,
      runtime,
      receipt,
      entryId: "workspaces.local-directory",
      componentId: "shared-space/WorkspaceLocalDirectoryPanel"
    });
  });

  (skillHubPackagePath ? it : it.skip)("installs and activates Skill Hub from an explicitly supplied closed package", async () : Promise<any> => {
    const { deployment, packageDigest, receipt, registry, runtime } = await installAndActivatePackage({
      packagePath: skillHubPackagePath,
      pluginId: "skill-hub",
      configuration: {
        enabled: true,
        modules: {
          registry: true,
          opaqueCustody: true,
          controlledSandbox: true,
          operationPermission: true
        }
      }
    });
    expect(receipt).toMatchObject({
      schemaVersion: "v0.0.1:meshrix:plugin-package-installation-receipt-1",
      pluginId: "skill-hub",
      packageDigest,
      generation: 1,
      state: "active"
    });
    expect(runtime.plugins.loadedPlugins).toEqual([{ id: "skill-hub", version: "0.0.1" }]);
    expect(Object.keys(runtime.contributions.operations)).toHaveLength(20);
    expect(Object.keys(runtime.contributions.routes)).toHaveLength(20);
    expect(Object.keys(runtime.contributions.mcpTools)).toHaveLength(20);
    expect(runtime.contributions.consoleEntries["admin.skill-hub"]).toMatchObject({
      pluginId: "skill-hub",
      implementation: {
        componentId: "skill-hub/SkillHubView",
        assetPath: "console/index.ts",
        assetExport: "mountPluginConsole"
      }
    });
    await expectVerifiedConsoleAsset({
      deployment,
      registry,
      runtime,
      receipt,
      entryId: "admin.skill-hub",
      componentId: "skill-hub/SkillHubView"
    });
  });

  (codingGithubPackagePath ? it : it.skip)("installs and activates coding-github from an explicitly supplied closed package", async () : Promise<any> => {
    const { deployment, packageDigest, receipt, registry, runtime } = await installAndActivatePackage({
      packagePath: codingGithubPackagePath,
      pluginId: "coding-github",
      configuration: {
        enabled: true,
        modules: { rest: true, mcp: true, codespaces: true, skillInstaller: true },
        services: {
          rest: { serviceRef: "service.fixture.github.rest", timeoutMs: 1_000 },
          mcp: { serviceRef: "service.fixture.github.mcp", timeoutMs: 1_000 }
        }
      }
    });
    expect(receipt).toMatchObject({
      schemaVersion: "v0.0.1:meshrix:plugin-package-installation-receipt-1",
      pluginId: "coding-github",
      packageDigest,
      generation: 1,
      state: "active"
    });
    expect(runtime.plugins.loadedPlugins).toEqual([{ id: "coding-github", version: "0.0.1" }]);
    expect(Object.keys(runtime.contributions.operations)).toHaveLength(24);
    expect(Object.keys(runtime.contributions.routes)).toHaveLength(24);
    expect(Object.keys(runtime.contributions.mcpTools)).toHaveLength(24);
    expect(runtime.contributions.consoleEntries["admin.coding-github"]).toMatchObject({
      pluginId: "coding-github",
      implementation: {
        componentId: "coding-github/GitHubConnectorPanel",
        assetPath: "console/index.ts",
        assetExport: "mountPluginConsole"
      }
    });
    await expectVerifiedConsoleAsset({
      deployment,
      registry,
      runtime,
      receipt,
      entryId: "admin.coding-github",
      componentId: "coding-github/GitHubConnectorPanel"
    });
  });

  ([sharedSpacePackagePath, skillHubPackagePath, codingGithubPackagePath].every(Boolean) ? it : it.skip)(
    "loads all verified external plugin packages into one Core deployment without contribution conflicts",
    async () : Promise<any> => {
      const { deployment, receipts, runtime } = await installAndActivatePackages([
        {
          packagePath: sharedSpacePackagePath,
          pluginId: "shared-space",
          configuration: { enabled: true, modules: { localDirectory: true, controlledSandbox: true } }
        },
        {
          packagePath: skillHubPackagePath,
          pluginId: "skill-hub",
          configuration: {
            enabled: true,
            modules: { registry: true, opaqueCustody: true, controlledSandbox: true, operationPermission: true }
          }
        },
        {
          packagePath: codingGithubPackagePath,
          pluginId: "coding-github",
          configuration: {
            enabled: true,
            modules: { rest: true, mcp: true, codespaces: true, skillInstaller: true },
            services: {
              rest: { serviceRef: "service.fixture.github.rest", timeoutMs: 1_000 },
              mcp: { serviceRef: "service.fixture.github.mcp", timeoutMs: 1_000 }
            }
          }
        }
      ]);
      expect(receipts).toHaveLength(3);
      expect(deployment.loadedPlugins.map(({ id, version }: Record<string, any>) : any => ({ id, version }))).toEqual(expect.arrayContaining([
        { id: "shared-space", version: "0.0.1" },
        { id: "skill-hub", version: "0.0.1" },
        { id: "coding-github", version: "0.0.1" }
      ]));
      expect(Object.keys(runtime.contributions.operations)).toHaveLength(65);
      expect(Object.keys(runtime.contributions.routes)).toHaveLength(65);
      expect(Object.keys(runtime.contributions.mcpTools)).toHaveLength(65);
      expect(Object.keys(runtime.contributions.consoleEntries)).toHaveLength(3);
    }
  );
});
