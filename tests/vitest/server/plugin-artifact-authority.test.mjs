import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPluginArtifactAuthority,
  pluginOwnerGenerationDigest
} from "../../../packages/foundation/src/module-system/plugin-artifact-authority.mjs";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";
import { loadPluginRegistry } from "../../../packages/foundation/src/module-system/plugin-registry.mjs";
import { activatePluginDeployment } from "../../../packages/foundation/src/module-system/plugin-runtime.mjs";

const roots = [];
const coreContractDigest = `sha256:${"c".repeat(64)}`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fixture({
  pluginId = "sample-plugin",
  version = "1.0.0",
  runtimeModule = "./runtime.mjs",
  faultInjector = null
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-artifact-authority-"));
  roots.push(root);
  const artifactRoot = path.join(root, "artifacts");
  const dataRoot = path.join(root, "data");
  const sourceRoot = path.join(root, "source");
  await Promise.all([
    fs.mkdir(artifactRoot, { mode: 0o700 }),
    fs.mkdir(dataRoot, { mode: 0o700 }),
    fs.mkdir(sourceRoot)
  ]);
  await fs.writeFile(path.join(sourceRoot, "plugin.json"), JSON.stringify({
    schemaVersion: "v0.0.1:plugin:manifest-1",
    id: pluginId,
    label: "Fixture plugin",
    version,
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
  }));
  const runtimeRelativePath = runtimeModule.replace(/^\.\//u, "");
  await fs.mkdir(path.dirname(path.join(sourceRoot, runtimeRelativePath)), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, runtimeRelativePath), `
    export async function activatePlugin({ manifest }) {
      return Object.freeze({ id: manifest.id, mounts: Object.freeze({}), contributions: Object.freeze({}), close: async () => ({ ok: true }) });
    }
    export async function recoverPluginLifecycle() {
      return Object.freeze({ transition: async () => ({ ok: true }), close: async () => ({ ok: true }) });
    }
  `);
  await fs.mkdir(path.join(sourceRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "nested", "fixture.txt"), "nested artifact content");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  const keyId = "ed25519:fixture-authority";
  const signer = Object.freeze({
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
  const lifecycleStatePort = await createPluginLifecycleStatePort({ userDataPath: dataRoot, pluginId });
  const authority = await createPluginArtifactAuthority({
    artifactRoot,
    trustedPublicKeys: { [keyId]: publicKeyJwk },
    artifactSigner: signer,
    secretRef: "secret://fixture/plugin-artifact",
    coreContractDigest,
    faultInjector
  });
  return {
    root,
    artifactRoot,
    dataRoot,
    sourceRoot,
    pluginId,
    signer,
    trustedPublicKeys: { [keyId]: publicKeyJwk },
    lifecycleStatePort,
    authority,
    port: authority.forPlugin({ pluginId, lifecycleStatePort })
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("canonical PluginArtifactAuthority", () => {
  it("projects one deterministic owner generation from the verified artifact identity", () => {
    const input = {
      pluginId: "sample-plugin",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      generation: 7
    };
    expect(pluginOwnerGenerationDigest(input)).toMatch(/^[a-f0-9]{64}$/u);
    expect(pluginOwnerGenerationDigest(input)).toBe(pluginOwnerGenerationDigest({ ...input }));
    expect(pluginOwnerGenerationDigest({ ...input, generation: 8 })).not.toBe(pluginOwnerGenerationDigest(input));
    expect(() => pluginOwnerGenerationDigest({ ...input, artifactDigest: "a".repeat(64) })).toThrow();
  });

  it("binds publish, install, discovery and load to one signed immutable root, then retains data across uninstall", async () => {
    const context = await fixture();
    const published = await context.port.publish({
      sourceRoot: context.sourceRoot,
      version: "1.0.0",
      generation: 1,
      dependencyClosure: []
    });
    await context.port.install(published);

    const registry = await loadPluginRegistry({ artifactAuthority: context.authority });
    const deployment = registry.resolveDeployment({ enabledPluginIds: ["sample-plugin"], configuredPluginIds: [] });
    const runtime = await activatePluginDeployment({
      deployment,
      createContext: async () => ({ lifecycleStatePort: context.lifecycleStatePort })
    });
    expect(runtime.plugins.loadedPlugins.map((plugin) => plugin.id)).toEqual(["sample-plugin"]);
    await runtime.close();

    await context.lifecycleStatePort.runExclusive(() => context.lifecycleStatePort.writeRecord("ledger", {
      schemaVersion: "licomesh.plugin-lifecycle-ledger/1",
      pluginId: "sample-plugin",
      state: "inactive",
      operation: "disable",
      idempotencyKey: "disable-fixture",
      requestDigest: "a".repeat(64),
      generation: 1
    }));
    const restarted = await activatePluginDeployment({
      deployment: (await loadPluginRegistry({ artifactAuthority: context.authority }))
        .resolveDeployment({ enabledPluginIds: ["sample-plugin"], configuredPluginIds: [] }),
      createContext: async () => ({ lifecycleStatePort: context.lifecycleStatePort })
    });
    expect(restarted.plugins.loadedPlugins).toEqual([]);
    await restarted.close();

    const retainedNamespace = path.join(context.dataRoot, "plugin-data", "sample-plugin");
    await fs.mkdir(retainedNamespace, { recursive: true });
    await fs.writeFile(path.join(retainedNamespace, "retained.json"), "{}");
    expect(await context.port.remove({
      expectedArtifactDigest: published.artifactDigest,
      expectedGeneration: published.generation
    })).toMatchObject({ ok: true, removed: true, replayed: false });
    expect((await loadPluginRegistry({ artifactAuthority: context.authority })).listPlugins()).toEqual([]);
    await expect(fs.readFile(path.join(retainedNamespace, "retained.json"), "utf8")).resolves.toBe("{}");
    expect(await context.port.remove({
      expectedArtifactDigest: published.artifactDigest,
      expectedGeneration: published.generation
    })).toMatchObject({ removed: true, replayed: true });
  });

  it("loads the runtime path declared by the manifest and exposes only verified contained files", async () => {
    const context = await fixture({
      pluginId: "nested-runtime",
      runtimeModule: "./dist/runtime.mjs"
    });
    const published = await context.port.publish({
      sourceRoot: context.sourceRoot,
      version: "1.0.0",
      generation: 1,
      dependencyClosure: []
    });
    await context.port.install(published);

    const snapshot = await context.port.loadSnapshot();
    await expect(snapshot.readFile("nested/fixture.txt")).resolves.toEqual(Buffer.from("nested artifact content"));
    await expect(snapshot.readFile("../plugin.json")).rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_PATH_INVALID" });
    await expect(snapshot.readFile("missing.mjs")).rejects.toMatchObject({ code: "ENOENT" });

    const deployment = (await loadPluginRegistry({ artifactAuthority: context.authority }))
      .resolveDeployment({ enabledPluginIds: ["nested-runtime"], configuredPluginIds: [] });
    const runtime = await activatePluginDeployment({
      deployment,
      createContext: async () => ({ lifecycleStatePort: context.lifecycleStatePort })
    });
    expect(runtime.plugins.loadedPlugins.map((plugin) => plugin.id)).toEqual(["nested-runtime"]);
    await runtime.close();
  });

  it("denies cross-plugin scope, generation confusion, tampering and symbolic links", async () => {
    const context = await fixture();
    expect(() => context.authority.forPlugin({ pluginId: "other-plugin", lifecycleStatePort: context.lifecycleStatePort }))
      .toThrow(/matching Host lifecycle state authority/u);
    const first = await context.port.publish({ sourceRoot: context.sourceRoot, version: "1.0.0", generation: 1, dependencyClosure: [] });
    await context.port.install(first);
    await expect(context.port.remove({ expectedArtifactDigest: first.artifactDigest, expectedGeneration: 2 }))
      .rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_REMOVAL_MISMATCH" });
    const snapshot = await context.port.loadSnapshot();
    const runtimePath = path.join(context.artifactRoot, "installed", "sample-plugin", String(snapshot.generation), "content", "runtime.mjs");
    await fs.chmod(runtimePath, 0o600);
    await fs.appendFile(runtimePath, "\n// tampered");
    await expect(context.port.loadSnapshot()).rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_TAMPERED" });

    const symlinkFixture = await fixture({ pluginId: "symlink-plugin" });
    await fs.symlink(path.join(symlinkFixture.sourceRoot, "runtime.mjs"), path.join(symlinkFixture.sourceRoot, "linked.mjs"));
    await expect(symlinkFixture.port.publish({ sourceRoot: symlinkFixture.sourceRoot, version: "1.0.0", generation: 1, dependencyClosure: [] }))
      .rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_SYMLINK_DENIED" });
  });

  it("recovers separately journaled install and removal mutations under the lifecycle fence", async () => {
    let failAt = "install:content-published";
    const context = await fixture({ faultInjector(phase) {
      if (phase === failAt) {
        failAt = "";
        throw new Error("simulated interruption");
      }
    } });
    const published = await context.port.publish({ sourceRoot: context.sourceRoot, version: "1.0.0", generation: 1, dependencyClosure: [] });
    await expect(context.port.install(published)).rejects.toThrow(/simulated interruption/u);
    expect(await context.port.recoverInstall()).toMatchObject({ ok: true, recovered: true });
    failAt = "remove:content-removed";
    await expect(context.port.remove({ expectedArtifactDigest: published.artifactDigest, expectedGeneration: 1 }))
      .rejects.toThrow(/simulated interruption/u);
    expect(await context.port.recoverRemoval()).toMatchObject({ ok: true, recovered: true, removed: true });
    expect(await context.port.remove({ expectedArtifactDigest: published.artifactDigest, expectedGeneration: 1 }))
      .toMatchObject({ removed: true, replayed: true });

    const absent = await fixture({ pluginId: "never-installed" });
    await expect(absent.port.remove({ expectedArtifactDigest: `sha256:${"d".repeat(64)}`, expectedGeneration: 1 }))
      .rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_ABSENT_UNPROVEN" });
  });

  it("recovers a sealed staged install through a fresh Host authority", async () => {
    const context = await fixture({ faultInjector(phase) {
      if (phase === "install:staged") throw new Error("simulated staged interruption");
    } });
    const published = await context.port.publish({
      sourceRoot: context.sourceRoot,
      version: "1.0.0",
      generation: 1,
      dependencyClosure: []
    });
    await expect(context.port.install(published)).rejects.toThrow(/simulated staged interruption/u);

    const lifecycleStatePort = await createPluginLifecycleStatePort({
      userDataPath: context.dataRoot,
      pluginId: context.pluginId
    });
    const authority = await createPluginArtifactAuthority({
      artifactRoot: context.artifactRoot,
      trustedPublicKeys: context.trustedPublicKeys,
      artifactSigner: context.signer,
      secretRef: "secret://fixture/plugin-artifact",
      coreContractDigest
    });
    const port = authority.forPlugin({ pluginId: context.pluginId, lifecycleStatePort });

    await expect(port.recoverInstall()).resolves.toMatchObject({ ok: true, recovered: true, generation: 1 });
    await expect(port.loadSnapshot()).resolves.toMatchObject({ generation: 1, artifactDigest: published.artifactDigest });
  });

  it("enforces monotonic reinstall and update CAS while removing every code namespace", async () => {
    const context = await fixture();
    const first = await context.port.publish({ sourceRoot: context.sourceRoot, version: "1.0.0", generation: 1, dependencyClosure: [] });
    await context.port.install(first);
    await context.port.remove({ expectedArtifactDigest: first.artifactDigest, expectedGeneration: 1 });
    await context.lifecycleStatePort.runExclusive(() => context.lifecycleStatePort.writeRecord("ledger", {
      schemaVersion: "licomesh.plugin-lifecycle-ledger/1", pluginId: "sample-plugin", state: "uninstalled",
      operation: "uninstall", idempotencyKey: "removed", requestDigest: "b".repeat(64), generation: 1
    }));
    const second = await context.port.publish({ sourceRoot: context.sourceRoot, version: "1.0.0", generation: 2, dependencyClosure: [] });
    await expect(context.port.install({ ...second, operation: "install" }))
      .rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_INSTALL_STATE_INVALID" });
    await expect(context.port.install({ ...first, operation: "reinstall", expectedCurrent: first }))
      .rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_INSTALL_CAS_FAILED" });
    await context.port.install({ ...second, operation: "reinstall", expectedCurrent: first });
    await expect(context.port.remove({ expectedArtifactDigest: first.artifactDigest, expectedGeneration: 1 }))
      .rejects.toMatchObject({ code: "PLUGIN_ARTIFACT_REMOVAL_MISMATCH" });

    await context.lifecycleStatePort.runExclusive(() => context.lifecycleStatePort.writeRecord("ledger", {
      schemaVersion: "licomesh.plugin-lifecycle-ledger/1", pluginId: "sample-plugin", state: "inactive",
      operation: "disable", idempotencyKey: "stopped", requestDigest: "c".repeat(64), generation: 2
    }));
    const third = await context.port.publish({ sourceRoot: context.sourceRoot, version: "1.0.0", generation: 3, dependencyClosure: [] });
    await context.port.install({ ...third, operation: "update", expectedCurrent: second });
    await context.port.remove({ expectedArtifactDigest: third.artifactDigest, expectedGeneration: 3 });
    await expect(fs.lstat(path.join(context.artifactRoot, "installed", "sample-plugin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(context.artifactRoot, "bundles", "sample-plugin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when artifact trust is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-artifact-empty-trust-"));
    roots.push(root);
    const authority = await createPluginArtifactAuthority({
      artifactRoot: root,
      trustedPublicKeys: {},
      coreContractDigest
    });
    await expect(authority.discover()).resolves.toEqual([]);
  });
});
