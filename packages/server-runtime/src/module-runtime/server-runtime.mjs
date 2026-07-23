import { createMountManager } from "../../../foundation/src/module-system/mount-manager.mjs";
import {
  getMountConfigPath,
  getMountConfigPaths,
} from "../../../foundation/src/module-system/mount-config.mjs";
import { createStorageKernel } from "../../../foundation/src/storage/storage-kernel.mjs";
import { createStorageProvider } from "../../../foundation/src/storage/storage-provider.mjs";
import { createLockManagerAsync } from "../../../foundation/src/concurrency/lock-manager.mjs";
import { createClientRegistryService } from "../state/client-registry-service.mjs";

export class ServerRuntimeCloseError extends Error {
  constructor() {
    super("Server runtime resource shutdown did not complete cleanly.");
    this.name = "ServerRuntimeCloseError";
  }
}

async function closeRuntimeResources(resources) {
  const failures = [];
  const steps = [
    () => resources.mountManager?.close?.(),
    () => resources.operationLockManager?.destroy?.(),
    () => resources.clientRegistryService?.close?.(),
    () => resources.storageKernel?.close?.()
  ];
  for (const close of steps) {
    try {
      await close();
    } catch {
      failures.push(true);
    }
  }
  if (failures.length > 0) throw new ServerRuntimeCloseError();
}

function createRuntimeResourceCloser(resources) {
  let remaining = [
    () => resources.mountManager?.close?.(),
    () => resources.operationLockManager?.destroy?.(),
    () => resources.clientRegistryService?.close?.(),
    () => resources.storageKernel?.close?.()
  ];
  let closePromise = null;
  return () => {
    if (remaining.length === 0) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const failed = [];
      for (const close of remaining) {
        try {
          await close();
        } catch {
          failed.push(close);
        }
      }
      remaining = failed;
      if (failed.length > 0) throw new ServerRuntimeCloseError();
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  };
}

export async function createServerRuntime({
  userDataPath,
  runtimeOptions = {},
  builtinMountProviders = {},
  pluginDeployment = null,
  operationLockManager: injectedOperationLockManager = null,
  registerPluginRuntimeMeasurementSource = null,
  pluginHostPorts = {},
}) {
  let storageKernel = null;
  let storageProvider = null;
  let clientRegistryService = null;
  let operationLockManager = injectedOperationLockManager;
  let mountManager = null;
  let closePromise = null;

  try {
    storageKernel = createStorageKernel({ userDataPath });
    storageProvider = createStorageProvider({ userDataPath, storageKernel });
    clientRegistryService = createClientRegistryService({ userDataPath });
    if (operationLockManager === null || operationLockManager === undefined) {
      operationLockManager = await createLockManagerAsync({
        backend: "sqlite",
        db: storageKernel.db
      });
    } else if (
      typeof operationLockManager.acquire !== "function" ||
      typeof operationLockManager.destroy !== "function"
    ) {
      throw new TypeError("Injected operationLockManager must implement acquire() and destroy().");
    }
    mountManager = await createMountManager({
      userDataPath,
      runtimeOptions,
      builtinMountProviders,
      pluginDeployment,
      registerPluginRuntimeMeasurementSource,
      pluginHostPorts,
    });
    const closeResources = createRuntimeResourceCloser({
      mountManager,
      operationLockManager,
      clientRegistryService,
      storageKernel
    });

    return {
      userDataPath,
      storageKernel,
      storageProvider,
      operationLockManager,
      clientRegistryService,
      mountConfigPath: getMountConfigPath(userDataPath),
      mountConfigPaths: getMountConfigPaths(userDataPath),
      mountManager,
      get mounts() {
        return mountManager.mounts;
      },
      get postCommitHooks() {
        return mountManager.createExecutionView().postCommitHooks;
      },
      get plugins() {
        return mountManager.plugins;
      },
      get runtimeOptions() {
        return mountManager.runtimeOptions;
      },
      get mountGeneration() {
        return mountManager.generation;
      },
      createExecutionView() {
        return {
          userDataPath,
          storageKernel,
          storageProvider,
          operationLockManager,
          clientRegistryService,
          ...mountManager.createExecutionView(),
        };
      },
      async applyMountConfig(config, options = {}) {
        return mountManager.applyMountConfig(config, options);
      },
      async reloadMounts(options = {}) {
        return mountManager.reloadMounts(options);
      },
      async refreshMounts(options = {}) {
        return mountManager.refreshMounts(options);
      },
      transitionPluginLifecycle(request = {}) {
        return mountManager.transitionPluginLifecycle(request);
      },
      onPluginLifecycleTransition(listener) {
        return mountManager.onPluginLifecycleTransition(listener);
      },
      onPluginContributionChange(listener) {
        return mountManager.onPluginContributionChange(listener);
      },
      getPluginArtifactGenerationDigest(pluginId) {
        return mountManager.getPluginArtifactGenerationDigest(pluginId);
      },
      async close() {
        closePromise ||= closeResources().catch((error) => {
          closePromise = null;
          throw error;
        });
        return closePromise;
      },
    };
  } catch (error) {
    await closeRuntimeResources({
      mountManager,
      operationLockManager,
      clientRegistryService,
      storageKernel
    }).catch(() => {});
    throw error;
  }
}
