import { createHash } from "node:crypto";

import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  normalizePluginBundleManifest
} from "@lico/contracts/plugins/plugin-bundle-manifest";
import { createVerifiedPluginPackage } from "@lico/contracts/plugins/verified-plugin-package";
import { extractPluginPackageTarGz, sha256Digest } from "./plugin-package-tar.mjs";

function sanitize(message) {
  return String(message || "PLUGIN_PACKAGE_FORMAT_REJECTED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 240);
}

/**
 * Content-addressed digest of bundle payload files (every inventory member except the
 * closed manifest). The manifest binds this digest; the archive digest is recorded
 * separately as packageDigest so the digest field never circularly hashes itself.
 */
export function computePluginPackagePayloadDigest(files) {
  const names = [...files.keys()]
    .filter((name) => name !== PLUGIN_BUNDLE_MANIFEST_FILENAME)
    .sort();
  const hash = createHash("sha256");
  for (const name of names) {
    const content = files.get(name);
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function admitPluginPackageArchive({
  bytes,
  expectedPluginId = null,
  coreContractDigest = null,
  trustedPublicKeyIds = null,
  sourceKind = "bytes",
  now = () => new Date().toISOString()
} = {}) {
  try {
    const archiveDigest = sha256Digest(bytes);
    const files = extractPluginPackageTarGz(bytes);
    if (!files.has(PLUGIN_BUNDLE_MANIFEST_FILENAME)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest file is missing");
    }
    let manifestJson;
    try {
      manifestJson = JSON.parse(files.get(PLUGIN_BUNDLE_MANIFEST_FILENAME).toString("utf8"));
    } catch {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest is not valid JSON");
    }
    const manifest = normalizePluginBundleManifest(manifestJson);
    if (expectedPluginId && manifest.pluginId !== expectedPluginId) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: plugin identity mismatch");
    }
    if (
      coreContractDigest &&
      manifest.coreCompatibility.contractDigest &&
      manifest.coreCompatibility.contractDigest !== coreContractDigest
    ) {
      throw new Error("PLUGIN_PACKAGE_COMPAT_REJECTED: core contract digest mismatch");
    }
    if (Array.isArray(trustedPublicKeyIds)) {
      if (trustedPublicKeyIds.length === 0) {
        throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: trust set is empty");
      }
      if (manifest.trust.algorithm === "ed25519") {
        if (!manifest.trust.publicKeyId || !trustedPublicKeyIds.includes(manifest.trust.publicKeyId)) {
          throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: public key is not trusted");
        }
        if (!manifest.trust.signature) {
          throw new Error("PLUGIN_PACKAGE_TRUST_REJECTED: signature is required");
        }
      }
    }
    const payloadFileCount = [...files.keys()].filter((name) => name !== PLUGIN_BUNDLE_MANIFEST_FILENAME).length;
    if (payloadFileCount !== manifest.files.length) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive payload count does not match inventory");
    }
    for (const entry of manifest.files) {
      const content = files.get(entry.path);
      if (!content) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: inventory file missing from archive");
      }
      if (content.length !== entry.size) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: inventory file size mismatch");
      }
      if (sha256Digest(content) !== entry.sha256) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: inventory file digest mismatch");
      }
    }
    for (const name of files.keys()) {
      if (name === PLUGIN_BUNDLE_MANIFEST_FILENAME) continue;
      if (!manifest.files.some((entry) => entry.path === name)) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: undeclared archive file");
      }
    }
    const payloadDigest = computePluginPackagePayloadDigest(files);
    if (manifest.payloadDigest !== payloadDigest) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: payloadDigest does not match payload content");
    }
    const verifiedPackage = createVerifiedPluginPackage({
      manifest,
      packageDigest: archiveDigest,
      archiveDigest,
      validatedAt: now(),
      sourceKind
    });
    return Object.freeze({ verifiedPackage, payloadFiles: files });
  } catch (error) {
    const message = sanitize(error?.message || error);
    const code = message.startsWith("PLUGIN_PACKAGE_")
      ? message.split(":")[0]
      : "PLUGIN_PACKAGE_FORMAT_REJECTED";
    const wrapped = new Error(`${code}: ${message.replace(/^PLUGIN_PACKAGE_[A-Z0-9_]+:\s*/u, "")}`);
    wrapped.code = code;
    throw wrapped;
  }
}

export function validatePluginPackageArchive(options = {}) {
  return admitPluginPackageArchive(options).verifiedPackage;
}
