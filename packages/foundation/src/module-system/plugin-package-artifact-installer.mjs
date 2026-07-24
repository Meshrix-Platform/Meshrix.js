import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import fs from "node:fs/promises";
import path from "node:path";

import { PLUGIN_BUNDLE_MANIFEST_FILENAME } from "@meshrix/contracts/plugins/plugin-bundle-manifest";
import { admitPluginPackageArchive } from "./plugin-package-validator.mjs";
import { normalizePluginManifest } from "./plugin-registry.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;


function sanitizedError(error) {
  const code = String(error?.code || "PLUGIN_PACKAGE_INSTALL_FAILED").trim();
  const message = String(error?.message || "Plugin package installation failed.")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 240);
  return Object.assign(new Error(message), {
    code: /^PLUGIN_[A-Z0-9_]+$/u.test(code) ? code : "PLUGIN_PACKAGE_INSTALL_FAILED"
  });
}

function assertDigest(value, label) {
  const digest = String(value || "").trim().toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) throw new TypeError(`${label} must be a sha256 digest.`);
  return digest;
}

function dependencyIds(value) {
  if (!Array.isArray(value)) throw new TypeError("Plugin package dependency closure must be an array.");
  return value.map((entry) => String(entry?.pluginId || "").trim()).sort();
}

function validatePackageRuntimeClosure({ verifiedPackage, files }) {
  const manifestBytes = files.get("plugin.json");
  const configurationSchemaBytes = files.get("configuration.schema.json");
  if (!manifestBytes || !configurationSchemaBytes) {
    throw Object.assign(new Error("Plugin package runtime manifest or configuration schema is missing."), {
      code: "PLUGIN_PACKAGE_FORMAT_REJECTED"
    });
  }
  let rawManifest;
  let configurationSchema;
  try {
    rawManifest = JSON.parse(manifestBytes.toString("utf8"));
    configurationSchema = JSON.parse(configurationSchemaBytes.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Plugin package runtime metadata is invalid JSON."), {
      code: "PLUGIN_PACKAGE_FORMAT_REJECTED"
    });
  }
  const manifest = normalizePluginManifest(rawManifest);
  const bundle = verifiedPackage.manifest;
  const runtimeEntrypoint = String(manifest.runtime?.module || "").replace(/^\.\//u, "");
  if (manifest.id !== bundle.pluginId || manifest.version !== bundle.version || manifest.defaultEnabled !== false ||
      runtimeEntrypoint !== bundle.entrypoint ||
      canonicalJson([...manifest.dependencies].sort()) !== canonicalJson([...bundle.dependencies].sort()) ||
      canonicalJson([...manifest.operations].sort()) !== canonicalJson([...bundle.permissions].sort()) ||
      canonicalJson(configurationSchema) !== canonicalJson(bundle.configurationSchema)) {
    throw Object.assign(new Error("Plugin package bundle metadata does not match its runtime closure."), {
      code: "PLUGIN_PACKAGE_FORMAT_REJECTED"
    });
  }
  if (!bundle.lifecycleHooks.includes("activate") || !bundle.lifecycleHooks.includes("close")) {
    throw Object.assign(new Error("Plugin package lifecycle declaration is incomplete."), {
      code: "PLUGIN_PACKAGE_FORMAT_REJECTED"
    });
  }
  return manifest;
}

async function materializeVerifiedPayload({ files, stagingRoot }) {
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(stagingRoot, "package-"));
  for (const [filePath, bytes] of files) {
    if (filePath === PLUGIN_BUNDLE_MANIFEST_FILENAME) continue;
    const target = path.join(root, filePath);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  return root;
}

export async function installPluginPackageArchive({
  bytes,
  expectedPackageDigest,
  pluginId,
  generation,
  dependencyClosure = [],
  operation = "install",
  expectedCurrent = null,
  artifactAuthority,
  lifecycleStatePort,
  stagingRoot,
  coreContractDigest,
  trustedPublicKeyIds = null
} = {}) {
  let materializedRoot = "";
  try {
    const expectedDigest = assertDigest(expectedPackageDigest, "Expected plugin package digest");
    const expectedCoreContractDigest = assertDigest(coreContractDigest, "Plugin package Core contract digest");
    if (artifactAuthority?.id !== "PluginArtifactAuthority" || typeof artifactAuthority.forPlugin !== "function") {
      throw new TypeError("Plugin package installation requires the canonical artifact authority.");
    }
    if (lifecycleStatePort?.id !== "PluginLifecycleStatePort" || lifecycleStatePort.pluginId !== pluginId) {
      throw new TypeError("Plugin package installation requires the matching lifecycle state authority.");
    }
    if (typeof stagingRoot !== "string" || !stagingRoot.trim()) {
      throw new TypeError("Plugin package installation requires an explicit private staging root.");
    }
    const admission = admitPluginPackageArchive({
      bytes,
      expectedPluginId: pluginId,
      coreContractDigest: expectedCoreContractDigest,
      trustedPublicKeyIds,
      sourceKind: "bytes"
    });
    const { verifiedPackage, payloadFiles: files } = admission;
    if (verifiedPackage.packageDigest !== expectedDigest) {
      throw Object.assign(new Error("Plugin package digest does not match the configured acquisition digest."), {
        code: "PLUGIN_PACKAGE_TRUST_REJECTED"
      });
    }
    if (verifiedPackage.manifest.coreCompatibility.contractDigest !== expectedCoreContractDigest) {
      throw Object.assign(new Error("Plugin package does not bind the active Core contract digest."), {
        code: "PLUGIN_PACKAGE_COMPAT_REJECTED"
      });
    }
    if (verifiedPackage.manifest.trust.algorithm !== "configured-digest") {
      throw Object.assign(new Error("Plugin package trust algorithm is not supported by this installation path."), {
        code: "PLUGIN_PACKAGE_TRUST_REJECTED"
      });
    }
    const runtimeManifest = validatePackageRuntimeClosure({ verifiedPackage, files });
    if (canonicalJson(dependencyIds(dependencyClosure)) !== canonicalJson([...verifiedPackage.manifest.dependencies].sort())) {
      throw Object.assign(new Error("Plugin package dependency closure does not match the bundle declaration."), {
        code: "PLUGIN_PACKAGE_COMPAT_REJECTED"
      });
    }
    materializedRoot = await materializeVerifiedPayload({ files, stagingRoot: path.resolve(stagingRoot) });
    const artifactPort = artifactAuthority.forPlugin({ pluginId, lifecycleStatePort });
    const published = await artifactPort.publish({
      sourceRoot: materializedRoot,
      version: runtimeManifest.version,
      generation,
      dependencyClosure
    });
    const installed = await artifactPort.install({
      artifactDigest: published.artifactDigest,
      generation: published.generation,
      operation,
      expectedCurrent
    });
    return Object.freeze({
      schemaVersion: "v0.0.1:meshrix:plugin-package-installation-receipt-1",
      pluginId,
      version: runtimeManifest.version,
      packageDigest: verifiedPackage.packageDigest,
      artifactDigest: installed.artifactDigest,
      generation: installed.generation,
      state: "active"
    });
  } catch (error) {
    throw sanitizedError(error);
  } finally {
    if (materializedRoot) await fs.rm(materializedRoot, { recursive: true, force: true }).catch(() => {});
  }
}
