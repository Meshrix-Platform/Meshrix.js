import { normalizePluginBundleManifest } from "./plugin-bundle-manifest.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function requireDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`PLUGIN_PACKAGE_FORMAT_REJECTED: ${label} must be a sha256 digest`);
  }
  return value;
}

export function createVerifiedPluginPackage({
  manifest,
  packageDigest,
  archiveDigest,
  validatedAt,
  sourceKind = "bytes",
  generation = null
} = {}) {
  const normalized = normalizePluginBundleManifest(manifest);
  const packageDigestValue = requireDigest(packageDigest, "packageDigest");
  const archiveDigestValue = requireDigest(archiveDigest, "archiveDigest");
  // Content-addressed package identity is the archive digest; payloadDigest binds inner files.
  if (packageDigestValue !== archiveDigestValue) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: packageDigest must equal archiveDigest");
  }
  if (typeof validatedAt !== "string" || !Number.isFinite(Date.parse(validatedAt))) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: validatedAt must be an ISO timestamp");
  }
  if (typeof sourceKind !== "string" || sourceKind.trim().length === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: sourceKind is required");
  }
  return Object.freeze({
    pluginId: normalized.pluginId,
    version: normalized.version,
    manifest: normalized,
    packageDigest: packageDigestValue,
    archiveDigest: archiveDigestValue,
    validatedAt,
    sourceKind: sourceKind.trim(),
    generation: generation === null || generation === undefined ? null : String(generation)
  });
}
