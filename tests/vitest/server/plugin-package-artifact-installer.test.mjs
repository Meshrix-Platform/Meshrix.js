import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  PLUGIN_BUNDLE_MANIFEST_SCHEMA
} from "../../../packages/contracts/src/plugins/plugin-bundle-manifest.mjs";
import { createPluginArtifactAuthority } from "../../../packages/foundation/src/module-system/plugin-artifact-authority.mjs";
import { installPluginPackageArchive } from "../../../packages/foundation/src/module-system/plugin-package-artifact-installer.mjs";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";
import {
  createPluginPackageTarGz,
  sha256Digest
} from "../../../packages/foundation/src/module-system/plugin-package-tar.mjs";
import { computePluginPackagePayloadDigest } from "../../../packages/foundation/src/module-system/plugin-package-validator.mjs";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.mjs";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.mjs";

const roots = [];
const coreContractDigest = `sha256:${"c".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function packageBytes({
  bundlePluginId = "fixture-plugin",
  runtimePluginId = bundlePluginId,
  entrypoint = "dist/runtime.mjs",
  runtimeModule = `./${entrypoint}`,
  trust = { algorithm: "configured-digest" },
  contractDigest = coreContractDigest
} = {}) {
  const configurationSchema = Object.freeze({ type: "object", additionalProperties: false });
  const pluginManifest = {
    schemaVersion: "v0.0.1:plugin:manifest-1",
    id: runtimePluginId,
    label: "Fixture plugin",
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
    runtime: { module: runtimeModule },
    mounts: {},
    mountRouting: {}
  };
  const runtime = `
    export async function activatePlugin({ manifest }) {
      return Object.freeze({
        id: manifest.id,
        mounts: Object.freeze({}),
        contributions: Object.freeze({
          operations: Object.freeze({}), routes: Object.freeze({}), mcpTools: Object.freeze({}),
          consoleEntries: Object.freeze({}), stateMachines: Object.freeze({}), verifierHooks: Object.freeze({})
        }),
        close: async () => Object.freeze({ ok: true })
      });
    }
  `;
  const payloadFiles = new Map([
    ["plugin.json", Buffer.from(`${JSON.stringify(pluginManifest)}\n`)],
    ["configuration.schema.json", Buffer.from(`${JSON.stringify(configurationSchema)}\n`)],
    [entrypoint, Buffer.from(runtime)]
  ]);
  const manifest = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId: bundlePluginId,
    version: "1.0.0",
    label: "Fixture plugin",
    entrypoint,
    files: [...payloadFiles].map(([filePath, content]) => ({
      path: filePath,
      sha256: sha256Digest(content),
      size: content.length
    })),
    coreCompatibility: { contractDigest },
    dependencies: [],
    configurationSchema,
    permissions: [],
    lifecycleHooks: ["activate", "close"],
    payloadDigest: computePluginPackagePayloadDigest(payloadFiles),
    trust
  };
  return createPluginPackageTarGz([
    { path: PLUGIN_BUNDLE_MANIFEST_FILENAME, content: Buffer.from(`${JSON.stringify(manifest)}\n`) },
    ...[...payloadFiles].map(([filePath, content]) => ({ path: filePath, content }))
  ]);
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

async function host() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-package-installer-"));
  roots.push(root);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = "ed25519:plugin-package-installer-test";
  await fs.mkdir(path.join(root, "data"), { mode: 0o700 });
  const lifecycleStatePort = await createPluginLifecycleStatePort({
    userDataPath: path.join(root, "data"),
    pluginId: "fixture-plugin"
  });
  const artifactAuthority = await createPluginArtifactAuthority({
    artifactRoot: path.join(root, "artifacts"),
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: artifactSigner(privateKey, keyId),
    secretRef: "secret://fixture/plugin-package-installer",
    coreContractDigest
  });
  return { root, lifecycleStatePort, artifactAuthority };
}

function installInput(bytes, context) {
  return {
    bytes,
    expectedPackageDigest: sha256Digest(bytes),
    pluginId: "fixture-plugin",
    generation: 1,
    artifactAuthority: context.artifactAuthority,
    lifecycleStatePort: context.lifecycleStatePort,
    stagingRoot: path.join(context.root, "staging"),
    coreContractDigest
  };
}

describe("canonical plugin package artifact installer", () => {
  it("cross-binds a closed package and loads it from the immutable artifact authority", async () => {
    const context = await host();
    const bytes = packageBytes();
    const receipt = await installPluginPackageArchive(installInput(bytes, context));
    expect(receipt).toMatchObject({
      pluginId: "fixture-plugin",
      version: "1.0.0",
      packageDigest: sha256Digest(bytes),
      generation: 1,
      state: "active"
    });

    const registry = await loadPluginRegistry({ artifactAuthority: context.artifactAuthority });
    const deployment = registry.resolveDeployment({ enabledPluginIds: ["fixture-plugin"] });
    const runtime = await activatePluginDeployment({
      deployment,
      createContext: async () => ({ lifecycleStatePort: context.lifecycleStatePort })
    });
    expect(runtime.plugins.loadedPlugins).toEqual([{ id: "fixture-plugin", version: "1.0.0" }]);
    await runtime.close();
  });

  it("rejects package/runtime identity, entrypoint, digest, compatibility, and unsupported trust drift", async () => {
    for (const bytes of [
      packageBytes({ runtimePluginId: "other-plugin" }),
      packageBytes({ runtimeModule: "./runtime.mjs" }),
      packageBytes({ contractDigest: `sha256:${"d".repeat(64)}` }),
      packageBytes({ trust: { algorithm: "ed25519", publicKeyId: "ed25519:unverified", signature: "unverified" } })
    ]) {
      const context = await host();
      await expect(installPluginPackageArchive(installInput(bytes, context))).rejects.toMatchObject({
        code: expect.stringMatching(/^PLUGIN_PACKAGE_/u)
      });
    }

    const context = await host();
    const bytes = packageBytes();
    await expect(installPluginPackageArchive({
      ...installInput(bytes, context),
      expectedPackageDigest: `sha256:${"e".repeat(64)}`
    })).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_TRUST_REJECTED" });
  });
});
