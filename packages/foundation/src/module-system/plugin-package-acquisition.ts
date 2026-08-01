import { createPluginPackageAcquisitionPort } from "./plugin-package-acquisition-port.ts";
import { createGitHubReleasePluginPackageAcquisition } from "./github-release-plugin-package-source.ts";
import { createLocalPluginPackageAcquisition } from "./local-plugin-package-source.ts";

/**
 * Source-neutral acquisition facade.
 * Registers production adapters that stop at the shared acquired-byte boundary.
 */
export function createPluginPackageAcquisition({
  github = {},
  local = null,
  adapters = {}
}: Record<string, any> = {}) : any {
  const port: any = createPluginPackageAcquisitionPort({ adapters });
  const githubAcquisition: any = createGitHubReleasePluginPackageAcquisition(github);
  port.registerAdapter("github_release", (source?: any, policy?: any, signal?: any) : any =>
    githubAcquisition.acquire(source, policy, signal)
  );
  if (local && typeof local.resolveImportRoot === "function") {
    const localAcquisition: any = createLocalPluginPackageAcquisition(local);
    port.registerAdapter("local_package", (source?: any, policy?: any, signal?: any) : any =>
      localAcquisition.acquire(source, policy, signal)
    );
  }
  return Object.freeze({
    id: "PluginPackageAcquisition",
    port,
    acquire: (source?: any, policy?: any, signal?: any) : any => port.acquire(source, policy, signal),
    registerAdapter: (kind?: any, adapter?: any) : any => port.registerAdapter(kind, adapter)
  });
}

export { createGitHubReleasePluginPackageAcquisition, acquireGitHubReleasePluginPackage } from "./github-release-plugin-package-source.ts";
export { createLocalPluginPackageAcquisition, acquireLocalPluginPackage } from "./local-plugin-package-source.ts";
