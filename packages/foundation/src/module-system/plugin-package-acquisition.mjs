import { createPluginPackageAcquisitionPort } from "./plugin-package-acquisition-port.mjs";
import { createGitHubReleasePluginPackageAcquisition } from "./github-release-plugin-package-source.mjs";
import { createLocalPluginPackageAcquisition } from "./local-plugin-package-source.mjs";

/**
 * Source-neutral acquisition facade.
 * Registers production adapters that stop at the shared acquired-byte boundary.
 */
export function createPluginPackageAcquisition({
  github = {},
  local = null,
  adapters = {}
} = {}) {
  const port = createPluginPackageAcquisitionPort({ adapters });
  const githubAcquisition = createGitHubReleasePluginPackageAcquisition(github);
  port.registerAdapter("github_release", (source, policy, signal) =>
    githubAcquisition.acquire(source, policy, signal)
  );
  if (local && typeof local.resolveImportRoot === "function") {
    const localAcquisition = createLocalPluginPackageAcquisition(local);
    port.registerAdapter("local_package", (source, policy, signal) =>
      localAcquisition.acquire(source, policy, signal)
    );
  }
  return Object.freeze({
    id: "PluginPackageAcquisition",
    port,
    acquire: (source, policy, signal) => port.acquire(source, policy, signal),
    registerAdapter: (kind, adapter) => port.registerAdapter(kind, adapter)
  });
}

export { createGitHubReleasePluginPackageAcquisition, acquireGitHubReleasePluginPackage } from "./github-release-plugin-package-source.mjs";
export { createLocalPluginPackageAcquisition, acquireLocalPluginPackage } from "./local-plugin-package-source.mjs";
