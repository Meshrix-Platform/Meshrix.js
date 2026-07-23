import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginArtifactAuthority } from "../../../packages/foundation/src/module-system/plugin-artifact-authority.mjs";
import { createPluginDataCapability } from "../../../packages/foundation/src/module-system/plugin-data-capability.mjs";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";
import { installPluginPackageArchive } from "../../../packages/foundation/src/module-system/plugin-package-artifact-installer.mjs";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.mjs";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.mjs";
import { pluginArtifactCoreContractDigest } from "../../../packages/server-runtime/src/composition/plugin-artifact-core-contract.mjs";
import { createPluginContributionRegistry } from "../../../packages/server-runtime/src/composition/plugin-contribution-registry.mjs";

const resources = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function artifactSigner(privateKey, keyId) {
  return Object.freeze({
    id: "ArtifactSignerPort",
    async sign({ purpose, payloadDigest, context }) {
      const contextDigest = `sha256:${crypto.createHash("sha256").update(canonicalJson(context)).digest("hex")}`;
      const signedEnvelope = Object.freeze({ purpose, payloadDigest, contextDigest });
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

async function installAndActivatePackage({ packagePath, pluginId, configuration }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "external-plugin-package-"));
  resources.push(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = await fs.readFile(packagePath);
  const packageDigest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = "ed25519:test-external-plugin-package";
  const coreContractDigest = pluginArtifactCoreContractDigest();
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const authority = await createPluginArtifactAuthority({
    artifactRoot: path.join(root, "artifacts"),
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: artifactSigner(privateKey, keyId),
    secretRef: "secret://fixture/external-plugin-package",
    coreContractDigest
  });
  const lifecycleStatePort = await createPluginLifecycleStatePort({
    userDataPath: dataRoot,
    pluginId
  });
  const receipt = await installPluginPackageArchive({
    bytes,
    expectedPackageDigest: packageDigest,
    pluginId,
    generation: 1,
    artifactAuthority: authority,
    lifecycleStatePort,
    stagingRoot: path.join(root, "staging"),
    coreContractDigest
  });
  const registry = await loadPluginRegistry({ artifactAuthority: authority });
  const deployment = registry.resolveDeployment({ enabledPluginIds: [pluginId] });
  const pluginDataRoot = path.join(root, "plugin-data", pluginId);
  await fs.mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
  const runtime = await activatePluginDeployment({
    deployment,
    artifactAuthority: authority,
    createContext: async () => ({
      lifecycleStatePort,
      pluginData: await createPluginDataCapability(pluginDataRoot),
      configuration: Object.freeze(configuration)
    })
  });
  resources.push(() => runtime.close());
  return Object.freeze({ deployment, packageDigest, receipt, registry, runtime });
}

async function installAndActivatePackages(packages) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "external-plugin-package-set-"));
  resources.push(() => fs.rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = "ed25519:test-external-plugin-package-set";
  const coreContractDigest = pluginArtifactCoreContractDigest();
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const authority = await createPluginArtifactAuthority({
    artifactRoot: path.join(root, "artifacts"),
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: artifactSigner(privateKey, keyId),
    secretRef: "secret://fixture/external-plugin-package-set",
    coreContractDigest
  });
  const lifecycleStates = new Map();
  const configurations = new Map();
  const receipts = [];
  for (const plugin of packages) {
    const bytes = await fs.readFile(plugin.packagePath);
    const packageDigest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const lifecycleStatePort = await createPluginLifecycleStatePort({
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
  const registry = await loadPluginRegistry({ artifactAuthority: authority });
  const pluginIds = packages.map((plugin) => plugin.pluginId);
  const deployment = registry.resolveDeployment({ enabledPluginIds: pluginIds });
  const runtime = await activatePluginDeployment({
    deployment,
    artifactAuthority: authority,
    createContext: async (manifest) => {
      const pluginDataRoot = path.join(root, "plugin-data", manifest.id);
      await fs.mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
      return {
        lifecycleStatePort: lifecycleStates.get(manifest.id),
        pluginData: await createPluginDataCapability(pluginDataRoot),
        configuration: configurations.get(manifest.id)
      };
    }
  });
  resources.push(() => runtime.close());
  return Object.freeze({ deployment, receipts: Object.freeze(receipts), registry, runtime });
}

async function expectVerifiedConsoleAsset({ deployment, registry, runtime, receipt, entryId, componentId }) {
  const contributions = createPluginContributionRegistry({
    manifests: registry.listPlugins(),
    loadedPlugins: deployment.loadedPlugins,
    contributions: runtime.contributions,
    coreOperations: [],
    activeFeatureIds: []
  });
  const consoleEntry = contributions.publicRuntime().consoleEntries.find((entry) => entry.id === entryId);
  expect(consoleEntry).toMatchObject({
    pluginId: receipt.pluginId,
    componentId,
    artifactDigest: receipt.artifactDigest,
    artifactGeneration: 1
  });
  const consoleAsset = await contributions.readConsoleAsset(consoleEntry.assetUrl);
  expect(consoleAsset.bytes.toString("utf8")).toContain("mountPluginConsole");
}

describe("external plugin package installation", () => {
  const clientLinkPackagePath = String(process.env.LICO_TEST_CLIENT_LINK_PACKAGE || "").trim();
  const sharedSpacePackagePath = String(process.env.LICO_TEST_SHARED_SPACE_PACKAGE || "").trim();
  const skillHubPackagePath = String(process.env.LICO_TEST_SKILL_HUB_PACKAGE || "").trim();
  const codingGithubPackagePath = String(process.env.LICO_TEST_CODING_GITHUB_PACKAGE || "").trim();

  (clientLinkPackagePath ? it : it.skip)("installs and activates Client Link from an explicitly supplied closed package", async () => {
    const { deployment, packageDigest, receipt, registry, runtime } = await installAndActivatePackage({
      packagePath: clientLinkPackagePath,
      pluginId: "client-link",
      configuration: { enabledSubmodules: ["client-runtime"], submodules: {} }
    });
    expect(receipt).toMatchObject({
      schemaVersion: "licomesh.plugin-package-installation-receipt.v1",
      pluginId: "client-link",
      packageDigest,
      generation: 1,
      state: "active"
    });
    expect(runtime.plugins.loadedPlugins).toEqual([{ id: "client-link", version: "0.0.1" }]);
    expect(Object.keys(runtime.contributions.operations)).toHaveLength(9);
    expect(Object.keys(runtime.contributions.routes)).toHaveLength(9);
    expect(Object.keys(runtime.contributions.mcpTools)).toHaveLength(9);
    expect(runtime.contributions.consoleEntries["admin.clients"]).toMatchObject({
      pluginId: "client-link",
      implementation: {
        componentId: "client-link/ClientsView",
        assetPath: "console/index.mjs",
        assetExport: "mountPluginConsole"
      }
    });
    await expectVerifiedConsoleAsset({
      deployment,
      registry,
      runtime,
      receipt,
      entryId: "admin.clients",
      componentId: "client-link/ClientsView"
    });
  });

  (sharedSpacePackagePath ? it : it.skip)("installs and activates Shared Space from an explicitly supplied closed package", async () => {
    const { deployment, packageDigest, receipt, registry, runtime } = await installAndActivatePackage({
      packagePath: sharedSpacePackagePath,
      pluginId: "shared-space",
      configuration: {
        enabled: true,
        modules: { localDirectory: true, controlledSandbox: true }
      }
    });
    expect(receipt).toMatchObject({
      schemaVersion: "licomesh.plugin-package-installation-receipt.v1",
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
        assetPath: "console/index.mjs",
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

  (skillHubPackagePath ? it : it.skip)("installs and activates Skill Hub from an explicitly supplied closed package", async () => {
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
      schemaVersion: "licomesh.plugin-package-installation-receipt.v1",
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
        assetPath: "console/index.mjs",
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

  (codingGithubPackagePath ? it : it.skip)("installs and activates coding-github from an explicitly supplied closed package", async () => {
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
      schemaVersion: "licomesh.plugin-package-installation-receipt.v1",
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
        assetPath: "console/index.mjs",
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

  ([clientLinkPackagePath, sharedSpacePackagePath, skillHubPackagePath, codingGithubPackagePath].every(Boolean) ? it : it.skip)(
    "loads all four verified external plugin packages into one Core deployment without contribution conflicts",
    async () => {
      const { deployment, receipts, runtime } = await installAndActivatePackages([
        {
          packagePath: clientLinkPackagePath,
          pluginId: "client-link",
          configuration: { enabledSubmodules: ["client-runtime"], submodules: {} }
        },
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
      expect(receipts).toHaveLength(4);
      expect(deployment.loadedPlugins.map(({ id, version }) => ({ id, version }))).toEqual(expect.arrayContaining([
        { id: "client-link", version: "0.0.1" },
        { id: "shared-space", version: "0.0.1" },
        { id: "skill-hub", version: "0.0.1" },
        { id: "coding-github", version: "0.0.1" }
      ]));
      expect(Object.keys(runtime.contributions.operations)).toHaveLength(74);
      expect(Object.keys(runtime.contributions.routes)).toHaveLength(74);
      expect(Object.keys(runtime.contributions.mcpTools)).toHaveLength(74);
      expect(Object.keys(runtime.contributions.consoleEntries)).toHaveLength(4);
    }
  );
});
