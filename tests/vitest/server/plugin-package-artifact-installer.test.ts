import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  PLUGIN_BUNDLE_MANIFEST_SCHEMA
} from "../../../packages/contracts/src/plugins/plugin-bundle-manifest.ts";
import { createPluginArtifactAuthority } from "../../../packages/foundation/src/module-system/plugin-artifact-authority.ts";
import { installPluginPackageArchive } from "../../../packages/foundation/src/module-system/plugin-package-artifact-installer.ts";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";
import {
  createPluginPackageTarGz,
  sha256Digest
} from "../../../packages/foundation/src/module-system/plugin-package-tar.ts";
import { computePluginPackagePayloadDigest } from "../../../packages/foundation/src/module-system/plugin-package-validator.ts";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.ts";

const roots: any[] = [];
const coreContractDigest: any = `sha256:${"c".repeat(64)}`;

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function packageBytes({
  bundlePluginId = "fixture-plugin",
  runtimePluginId = bundlePluginId,
  entrypoint = "dist/runtime.ts",
  runtimeModule = `./${entrypoint}`,
  trust = { algorithm: "configured-digest" },
  contractDigest = coreContractDigest
}: Record<string, any> = {}) : any {
  const configurationSchema: Readonly<Record<string, any>> = Object.freeze({ type: "object", additionalProperties: false });
  const pluginManifest: Record<string, any> = {
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
  const runtime: any = `
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
  const payloadFiles: any = new Map<any, any>([
    ["plugin.json", Buffer.from(`${JSON.stringify(pluginManifest)}\n`)],
    ["configuration.schema.json", Buffer.from(`${JSON.stringify(configurationSchema)}\n`)],
    [entrypoint, Buffer.from(runtime)]
  ]);
  const manifest: Record<string, any> = {
    schemaVersion: PLUGIN_BUNDLE_MANIFEST_SCHEMA,
    pluginId: bundlePluginId,
    version: "1.0.0",
    label: "Fixture plugin",
    entrypoint,
    files: [...payloadFiles].map(([filePath, content]: any[]) : any => ({
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
    ...[...payloadFiles].map(([filePath, content]: any[]) : any => ({ path: filePath, content }))
  ]);
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

async function host() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-package-installer-"));
  roots.push(root);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId: any = "ed25519:plugin-package-installer-test";
  await fs.mkdir(path.join(root, "data"), { mode: 0o700 });
  const lifecycleStatePort: any = await createPluginLifecycleStatePort({
    userDataPath: path.join(root, "data"),
    pluginId: "fixture-plugin"
  });
  const artifactAuthority: any = await createPluginArtifactAuthority({
    artifactRoot: path.join(root, "artifacts"),
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: artifactSigner(privateKey, keyId),
    secretRef: "secret://fixture/plugin-package-installer",
    coreContractDigest
  });
  return { root, lifecycleStatePort, artifactAuthority };
}

function installInput(bytes?: any, context?: any) : any {
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

describe("canonical plugin package artifact installer", () : any => {
  it("cross-binds a closed package and loads it from the immutable artifact authority", async () : Promise<any> => {
    const context: any = await host();
    const bytes: any = packageBytes();
    const receipt: any = await installPluginPackageArchive(installInput(bytes, context));
    expect(receipt).toMatchObject({
      pluginId: "fixture-plugin",
      version: "1.0.0",
      packageDigest: sha256Digest(bytes),
      generation: 1,
      state: "active"
    });

    const registry: any = await loadPluginRegistry({ artifactAuthority: context.artifactAuthority });
    const deployment: any = registry.resolveDeployment({ enabledPluginIds: ["fixture-plugin"] });
    const runtime: any = await activatePluginDeployment({
      deployment,
      createContext: async () : Promise<any> => ({ lifecycleStatePort: context.lifecycleStatePort })
    });
    expect(runtime.plugins.loadedPlugins).toEqual([{ id: "fixture-plugin", version: "1.0.0" }]);
    await runtime.close();
  });

  it("rejects package/runtime identity, entrypoint, digest, compatibility, and unsupported trust drift", async () : Promise<any> => {
    for (const bytes of [
      packageBytes({ runtimePluginId: "other-plugin" }),
      packageBytes({ runtimeModule: "./runtime.ts" }),
      packageBytes({ contractDigest: `sha256:${"d".repeat(64)}` }),
      packageBytes({ trust: { algorithm: "ed25519", publicKeyId: "ed25519:unverified", signature: "unverified" } })
    ]) {
      const context: any = await host();
      await expect(installPluginPackageArchive(installInput(bytes, context))).rejects.toMatchObject({
        code: expect.stringMatching(/^PLUGIN_PACKAGE_/u)
      });
    }

    const context: any = await host();
    const bytes: any = packageBytes();
    await expect(installPluginPackageArchive({
      ...installInput(bytes, context),
      expectedPackageDigest: `sha256:${"e".repeat(64)}`
    })).rejects.toMatchObject({ code: "PLUGIN_PACKAGE_TRUST_REJECTED" });
  });
});
