export const PLUGIN_PACKAGE_SOURCE_KINDS = Object.freeze(["github_release", "local_package", "bytes"]);

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`PLUGIN_PACKAGE_SOURCE_DENIED: ${label} is required`);
  }
  return value.trim();
}

export function createGitHubReleasePluginPackageSource({
  repository,
  release,
  asset,
  credentialRef = null,
  expectedDigest = null
}: Record<string, unknown> = {}) {
  const repositoryValue = requireNonEmptyString(repository, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryValue)) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: repository must be owner/name");
  }
  return Object.freeze({
    kind: "github_release",
    repository: repositoryValue,
    release: requireNonEmptyString(release, "release"),
    asset: requireNonEmptyString(asset, "asset"),
    credentialRef: credentialRef === null || credentialRef === undefined || credentialRef === ""
      ? null
      : requireNonEmptyString(credentialRef, "credentialRef"),
    // Remote plugin packages are admitted only against an operator-fixed
    // digest. A release source without an expected digest is refused — a
    // network-acquired package must never become installable code without a
    // content binding.
    expectedDigest: requireNonEmptyString(expectedDigest, "expectedDigest")
  });
}

export function createLocalPluginPackageSource({
  importRootId,
  relativePath,
  expectedDigest = null
}: Record<string, unknown> = {}) {
  return Object.freeze({
    kind: "local_package",
    importRootId: requireNonEmptyString(importRootId, "importRootId"),
    relativePath: requireNonEmptyString(relativePath, "relativePath"),
    expectedDigest: expectedDigest === null || expectedDigest === undefined
      ? null
      : requireNonEmptyString(expectedDigest, "expectedDigest")
  });
}

/** Test/seam source that supplies already-acquired immutable bytes. Not a production adapter. */
export function createBytesPluginPackageSource({
  bytes,
  expectedDigest = null,
  label = "bytes"
}: Record<string, unknown> = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: bytes source requires a byte buffer");
  }
  return Object.freeze({
    kind: "bytes",
    label: requireNonEmptyString(label, "label"),
    bytes: Buffer.from(bytes),
    expectedDigest: expectedDigest === null || expectedDigest === undefined
      ? null
      : requireNonEmptyString(expectedDigest, "expectedDigest")
  });
}

export function assertPluginPackageSource(source?: unknown) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: source descriptor is required");
  }
  const descriptor = source as Record<string, unknown>;
  if (typeof descriptor.kind !== "string" || !PLUGIN_PACKAGE_SOURCE_KINDS.includes(descriptor.kind)) {
    throw new Error("PLUGIN_PACKAGE_SOURCE_DENIED: unsupported source kind");
  }
  if (descriptor.kind === "github_release") {
    return createGitHubReleasePluginPackageSource(descriptor);
  }
  if (descriptor.kind === "local_package") {
    return createLocalPluginPackageSource(descriptor);
  }
  return createBytesPluginPackageSource(descriptor);
}
