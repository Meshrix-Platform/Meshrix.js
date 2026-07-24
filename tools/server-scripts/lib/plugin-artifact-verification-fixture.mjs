import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPluginArtifactAuthority } from "../../../packages/foundation/src/module-system/plugin-artifact-authority.mjs";
import { createPluginLifecycleStatePort } from "../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRuntimeDependencyPackages(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16) {
    throw new TypeError("Verification runtime dependency packages must be a bounded object.");
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([pluginId, packageNames]) => {
    if (!/^[a-z][a-z0-9-]*$/u.test(pluginId) || !Array.isArray(packageNames) || packageNames.length > 16) {
      throw new TypeError("Verification runtime dependency packages are invalid.");
    }
    const normalized = [...new Set(packageNames.map((entry) => String(entry || "").trim()))].sort();
    if (normalized.length !== packageNames.length || normalized.some((entry) =>
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(entry))) {
      throw new TypeError("Verification runtime dependency package names are invalid.");
    }
    return [pluginId, Object.freeze(normalized)];
  })));
}

export async function stagePluginArtifactVerificationFixture({
  sourcePluginRoot,
  artifactRoot: requestedArtifactRoot = "",
  userDataPath = "",
  coreContractDigest = `sha256:${"e".repeat(64)}`,
  runtimeDependencyPackages = {},
  runtimeDependencyNodeModulesRoot = ""
}) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-artifact-verification-"));
  const artifactRoot = requestedArtifactRoot ? path.resolve(requestedArtifactRoot) : path.join(fixtureRoot, "artifacts");
  const dataRoot = userDataPath ? path.resolve(userDataPath) : path.join(fixtureRoot, "data");
  const dependencyPackages = normalizeRuntimeDependencyPackages(runtimeDependencyPackages);
  const dependencyNodeModulesRoot = runtimeDependencyNodeModulesRoot
    ? path.resolve(runtimeDependencyNodeModulesRoot)
    : path.join(path.dirname(sourcePluginRoot), "node_modules");
  await Promise.all([
    fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 }),
    fs.mkdir(dataRoot, { recursive: true, mode: 0o700 })
  ]);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId = "ed25519:verification-plugin-artifact-authority";
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
  const trustedPublicKeys = Object.freeze({ [keyId]: Object.freeze(publicKey.export({ format: "jwk" })) });
  const authority = await createPluginArtifactAuthority({
    artifactRoot,
    trustedPublicKeys,
    artifactSigner: signer,
    secretRef: "secret://verification/plugin-artifact",
    coreContractDigest
  });
  const manifests = new Map();
  let sourceEntries = [];
  try {
    sourceEntries = await fs.readdir(sourcePluginRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of sourceEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const sourceRoot = path.join(sourcePluginRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, "plugin.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const packageNames = dependencyPackages[manifest.id] || [];
    let publishRoot = sourceRoot;
    if (packageNames.length > 0) {
      publishRoot = path.join(fixtureRoot, "publish-sources", manifest.id);
      await fs.cp(sourceRoot, publishRoot, { recursive: true, dereference: true, errorOnExist: true });
      for (const packageName of packageNames) {
        const dependencyRoot = path.join(dependencyNodeModulesRoot, packageName);
        const targetRoot = path.join(publishRoot, "node_modules", packageName);
        await fs.mkdir(path.dirname(targetRoot), { recursive: true, mode: 0o700 });
        await fs.cp(dependencyRoot, targetRoot, { recursive: true, dereference: true, errorOnExist: true });
      }
    }
    manifests.set(manifest.id, { manifest, sourceRoot: publishRoot });
  }
  const installed = new Map();
  async function stage(id) {
    if (installed.has(id)) return installed.get(id);
    const source = manifests.get(id);
    if (!source) throw new Error(`Verification plugin dependency ${id} is unavailable.`);
    const dependencyClosure = [];
    for (const dependencyId of [...(source.manifest.dependencies || [])].sort()) {
      const dependency = await stage(dependencyId);
      dependencyClosure.push({ pluginId: dependencyId, version: dependency.version,
        artifactDigest: dependency.artifactDigest, generation: dependency.generation });
    }
    const lifecycleStatePort = await createPluginLifecycleStatePort({ userDataPath: dataRoot, pluginId: id });
    const port = authority.forPlugin({ pluginId: id, lifecycleStatePort });
    const published = await port.publish({ sourceRoot: source.sourceRoot, version: source.manifest.version,
      generation: 1, dependencyClosure });
    await port.install(published);
    const result = Object.freeze({ ...published, version: source.manifest.version, lifecycleStatePort, port });
    installed.set(id, result);
    return result;
  }
  for (const id of [...manifests.keys()].sort()) await stage(id);
  return Object.freeze({
    authority,
    artifactRoot,
    trustedPublicKeys,
    coreContractDigest,
    dataRoot,
    installed,
    async close() { await fs.rm(fixtureRoot, { recursive: true, force: true }); }
  });
}
