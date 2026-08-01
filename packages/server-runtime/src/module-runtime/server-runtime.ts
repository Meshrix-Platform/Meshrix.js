import { createMountManager } from "#meshrix/foundation/module-system/mount-manager";
import {
  getMountConfigPath,
  getMountConfigPaths,
} from "#meshrix/foundation/module-system/mount-config";
import { createStorageKernel } from "#meshrix/foundation/storage/storage-kernel";
import { createStorageProvider } from "#meshrix/foundation/storage/storage-provider";
import { createLockManagerAsync } from "#meshrix/foundation/concurrency/lock-manager";
import { createClientRegistryService } from "../state/client-registry-service.ts";

export class ServerRuntimeCloseError extends Error {
  name: any;
  constructor() {
    super("Server runtime resource shutdown did not complete cleanly.");
    this.name = "ServerRuntimeCloseError";
  }
}

async function closeRuntimeResources(resources?: any) : Promise<any> {
  const failures: any[] = [];
  const steps: any[] = [
    () : any => resources.mountManager?.close?.(),
    () : any => resources.operationLockManager?.destroy?.(),
    () : any => resources.clientRegistryService?.close?.(),
    () : any => resources.storageKernel?.close?.()
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

function createRuntimeResourceCloser(resources?: any) : any {
  let remaining: any[] = [
    () : any => resources.mountManager?.close?.(),
    () : any => resources.operationLockManager?.destroy?.(),
    () : any => resources.clientRegistryService?.close?.(),
    () : any => resources.storageKernel?.close?.()
  ];
  let closePromise: any = null;
  return () : any => {
    if (remaining.length === 0) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () : Promise<any> => {
      const failed: any[] = [];
      for (const close of remaining) {
        try {
          await close();
        } catch {
          failed.push(close);
        }
      }
      remaining = failed;
      if (failed.length > 0) throw new ServerRuntimeCloseError();
    })().finally(() : any => {
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
}: Record<string, any>) : Promise<any> {
  let storageKernel: any = null;
  let storageProvider: any = null;
  let clientRegistryService: any = null;
  let operationLockManager: any = injectedOperationLockManager;
  let mountManager: any = null;
  let closePromise: any = null;

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
    const closeResources: any = createRuntimeResourceCloser({
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
      get mounts() : any {
        return mountManager.mounts;
      },
      get postCommitHooks() : any {
        return mountManager.createExecutionView().postCommitHooks;
      },
      get plugins() : any {
        return mountManager.plugins;
      },
      get runtimeOptions() : any {
        return mountManager.runtimeOptions;
      },
      get mountGeneration() : any {
        return mountManager.generation;
      },
      createExecutionView() : any {
        return {
          userDataPath,
          storageKernel,
          storageProvider,
          operationLockManager,
          clientRegistryService,
          ...mountManager.createExecutionView(),
        };
      },
      async applyMountConfig(config?: any, options: Record<string, any> = {}) : Promise<any> {
        return mountManager.applyMountConfig(config, options);
      },
      async reloadMounts(options: Record<string, any> = {}) : Promise<any> {
        return mountManager.reloadMounts(options);
      },
      async refreshMounts(options: Record<string, any> = {}) : Promise<any> {
        return mountManager.refreshMounts(options);
      },
      transitionPluginLifecycle(request: Record<string, any> = {}) : any {
        return mountManager.transitionPluginLifecycle(request);
      },
      onPluginLifecycleTransition(listener?: any) : any {
        return mountManager.onPluginLifecycleTransition(listener);
      },
      onPluginContributionChange(listener?: any) : any {
        return mountManager.onPluginContributionChange(listener);
      },
      getPluginArtifactGenerationDigest(pluginId?: any) : any {
        return mountManager.getPluginArtifactGenerationDigest(pluginId);
      },
      async close() : Promise<any> {
        closePromise ||= closeResources().catch((error?: any) : any => {
          closePromise = null;
          throw error;
        });
        return closePromise;
      },
    };
  } catch (error: any) {
    await closeRuntimeResources({
      mountManager,
      operationLockManager,
      clientRegistryService,
      storageKernel
    }).catch(() : any => {});
    throw error;
  }
}
