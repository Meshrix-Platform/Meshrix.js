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
  override name = "ServerRuntimeCloseError";
  constructor() {
    super("Server runtime resource shutdown did not complete cleanly.");
  }
}

interface RuntimeResources {
  mountManager?: { close?: () => void | Promise<void> } | null;
  operationLockManager?: { destroy?: () => void | Promise<void> } | null;
  clientRegistryService?: { close?: () => void | Promise<void> } | null;
  storageKernel?: { close?: () => void | Promise<void> } | null;
}

type CloseStep = () => void | Promise<void>;
type StorageKernel = ReturnType<typeof createStorageKernel>;
type StorageProvider = ReturnType<typeof createStorageProvider>;
type ClientRegistryService = ReturnType<typeof createClientRegistryService>;
type OperationLockManager = Awaited<ReturnType<typeof createLockManagerAsync>>;
type MountManager = Awaited<ReturnType<typeof createMountManager>>;

export interface CreateServerRuntimeOptions {
  userDataPath: string;
  runtimeOptions?: Record<string, unknown>;
  builtinMountProviders?: Record<string, unknown>;
  pluginDeployment?: unknown;
  operationLockManager?: OperationLockManager | null;
  registerPluginRuntimeMeasurementSource?: unknown;
  pluginHostPorts?: Record<string, unknown>;
}

export interface ServerRuntime {
  userDataPath: string;
  storageKernel: StorageKernel;
  storageProvider: StorageProvider;
  operationLockManager: OperationLockManager;
  clientRegistryService: ClientRegistryService;
  mountConfigPath: ReturnType<typeof getMountConfigPath>;
  mountConfigPaths: ReturnType<typeof getMountConfigPaths>;
  mountManager: MountManager;
  readonly mounts: MountManager["mounts"];
  readonly postCommitHooks: ReturnType<MountManager["createExecutionView"]>["postCommitHooks"];
  readonly plugins: MountManager["plugins"];
  readonly runtimeOptions: MountManager["runtimeOptions"];
  readonly mountGeneration: MountManager["generation"];
  createExecutionView(): ReturnType<MountManager["createExecutionView"]> & {
    userDataPath: string;
    storageKernel: StorageKernel;
    storageProvider: StorageProvider;
    operationLockManager: OperationLockManager;
    clientRegistryService: ClientRegistryService;
  };
  applyMountConfig(...args: Parameters<MountManager["applyMountConfig"]>): ReturnType<MountManager["applyMountConfig"]>;
  reloadMounts(...args: Parameters<MountManager["reloadMounts"]>): ReturnType<MountManager["reloadMounts"]>;
  refreshMounts(...args: Parameters<MountManager["refreshMounts"]>): ReturnType<MountManager["refreshMounts"]>;
  transitionPluginLifecycle(...args: Parameters<MountManager["transitionPluginLifecycle"]>): ReturnType<MountManager["transitionPluginLifecycle"]>;
  onPluginLifecycleTransition(...args: Parameters<MountManager["onPluginLifecycleTransition"]>): ReturnType<MountManager["onPluginLifecycleTransition"]>;
  onPluginContributionChange(...args: Parameters<MountManager["onPluginContributionChange"]>): ReturnType<MountManager["onPluginContributionChange"]>;
  getPluginArtifactGenerationDigest(...args: Parameters<MountManager["getPluginArtifactGenerationDigest"]>): ReturnType<MountManager["getPluginArtifactGenerationDigest"]>;
  close(): Promise<void>;
}

async function closeRuntimeResources(resources: RuntimeResources = {}): Promise<void> {
  const failures: boolean[] = [];
  const steps: CloseStep[] = [
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

function createRuntimeResourceCloser(resources: RuntimeResources = {}): () => Promise<void> {
  let remaining: CloseStep[] = [
    () => resources.mountManager?.close?.(),
    () => resources.operationLockManager?.destroy?.(),
    () => resources.clientRegistryService?.close?.(),
    () => resources.storageKernel?.close?.()
  ];
  let closePromise: Promise<void> | null = null;
  return () => {
    if (remaining.length === 0) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async (): Promise<void> => {
      const failed: CloseStep[] = [];
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
}: CreateServerRuntimeOptions): Promise<ServerRuntime> {
  let storageKernel: StorageKernel | null = null;
  let storageProvider: StorageProvider | null = null;
  let clientRegistryService: ClientRegistryService | null = null;
  let operationLockManager: OperationLockManager | null = injectedOperationLockManager;
  let mountManager: MountManager | null = null;
  let closePromise: Promise<void> | null = null;

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
      applyMountConfig(...args: Parameters<MountManager["applyMountConfig"]>) {
        return mountManager.applyMountConfig(...args);
      },
      reloadMounts(...args: Parameters<MountManager["reloadMounts"]>) {
        return mountManager.reloadMounts(...args);
      },
      refreshMounts(...args: Parameters<MountManager["refreshMounts"]>) {
        return mountManager.refreshMounts(...args);
      },
      transitionPluginLifecycle(...args: Parameters<MountManager["transitionPluginLifecycle"]>) {
        return mountManager.transitionPluginLifecycle(...args);
      },
      onPluginLifecycleTransition(...args: Parameters<MountManager["onPluginLifecycleTransition"]>) {
        return mountManager.onPluginLifecycleTransition(...args);
      },
      onPluginContributionChange(...args: Parameters<MountManager["onPluginContributionChange"]>) {
        return mountManager.onPluginContributionChange(...args);
      },
      getPluginArtifactGenerationDigest(...args: Parameters<MountManager["getPluginArtifactGenerationDigest"]>) {
        return mountManager.getPluginArtifactGenerationDigest(...args);
      },
      async close(): Promise<void> {
        closePromise ||= closeResources().catch((error: unknown) => {
          closePromise = null;
          throw error;
        });
        return closePromise;
      },
    };
  } catch (error: unknown) {
    await closeRuntimeResources({
      mountManager,
      operationLockManager,
      clientRegistryService,
      storageKernel
    }).catch(() => {});
    throw error;
  }
}
