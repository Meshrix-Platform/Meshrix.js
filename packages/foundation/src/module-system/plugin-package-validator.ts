import { createHash } from "node:crypto";

import {
  PLUGIN_BUNDLE_MANIFEST_FILENAME,
  normalizePluginBundleManifest
} from "@meshrix/contracts/plugins/plugin-bundle-manifest";
import { createVerifiedPluginPackage } from "@meshrix/contracts/plugins/verified-plugin-package";
import { extractPluginPackageTarGz, sha256Digest } from "./plugin-package-tar.ts";

function sanitize(message?: any) : any {
  return String(message || "PLUGIN_PACKAGE_FORMAT_REJECTED")
    .replace(/(?:\/Users\/|\/home\/|\/opt\/|\/var\/|\/private\/)[^\s"']+/gu, "<redacted-path>")
    .slice(0, 240);
}

/**
 * Content-addressed digest of bundle payload files (every inventory member except the
 * closed manifest). The manifest binds this digest; the archive digest is recorded
 * separately as packageDigest so the digest field never circularly hashes itself.
 */
export function computePluginPackagePayloadDigest(files?: any) : any {
  const names: any = [...files.keys()]
    .filter((name?: any) : any => name !== PLUGIN_BUNDLE_MANIFEST_FILENAME)
    .sort();
  const hash: any = createHash("sha256");
  for (const name of names) {
    const content: any = files.get(name);
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function admitPluginPackageArchive({
  bytes,
  expectedPluginId = null,
  coreContractDigest = null,
  sourceKind = "bytes",
  now = () : any => new Date().toISOString()
}: Record<string, any> = {}) : Promise<any> {
  try {
    const archiveDigest: any = sha256Digest(bytes);
    const files: any = await extractPluginPackageTarGz(bytes);
    if (!files.has(PLUGIN_BUNDLE_MANIFEST_FILENAME)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest file is missing");
    }
    let manifestJson: any;
    try {
      manifestJson = JSON.parse(files.get(PLUGIN_BUNDLE_MANIFEST_FILENAME).toString("utf8"));
    } catch {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: bundle manifest is not valid JSON");
    }
    const manifest: any = normalizePluginBundleManifest(manifestJson);
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
    const payloadFileCount: any = [...files.keys()].filter((name?: any) : any => name !== PLUGIN_BUNDLE_MANIFEST_FILENAME).length;
    if (payloadFileCount !== manifest.files.length) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive payload count does not match inventory");
    }
    for (const entry of manifest.files) {
      const content: any = files.get(entry.path);
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
      if (!manifest.files.some((entry?: any) : any => entry.path === name)) {
        throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: undeclared archive file");
      }
    }
    const payloadDigest: any = computePluginPackagePayloadDigest(files);
    if (manifest.payloadDigest !== payloadDigest) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: payloadDigest does not match payload content");
    }
    const verifiedPackage: any = createVerifiedPluginPackage({
      manifest,
      packageDigest: archiveDigest,
      archiveDigest,
      validatedAt: now(),
      sourceKind
    });
    return Object.freeze({ verifiedPackage, payloadFiles: files });
  } catch (error: any) {
    const message: any = sanitize(error?.message || error);
    const code: any = message.startsWith("PLUGIN_PACKAGE_")
      ? message.split(":")[0]
      : "PLUGIN_PACKAGE_FORMAT_REJECTED";
    const wrapped: Error & Record<string, any> = new Error(`${code}: ${message.replace(/^PLUGIN_PACKAGE_[A-Z0-9_]+:\s*/u, "")}`);
    wrapped.code = code;
    throw wrapped;
  }
}

export async function validatePluginPackageArchive(options: Record<string, any> = {}) : Promise<any> {
  return (await admitPluginPackageArchive(options)).verifiedPackage;
}
