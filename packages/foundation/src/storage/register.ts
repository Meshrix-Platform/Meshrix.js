// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
interface StorageCapability {
  id: string;
}

interface StorageProviderRegistrationValue {
  protocolVersion?: string;
  listCapabilities?(): { capabilities: readonly StorageCapability[] };
}

interface StorageKernelRegistrationValue {
  databasePath?: string;
  objectRootPath?: string;
}

interface PlatformRegistry {
  register(entry: PlatformServiceEntry): unknown;
}

interface PlatformServiceEntry {
  id: string;
  platform: "storage";
  label: string;
  kind: "provider" | "repository";
  ownerFeatureId: "storage-core";
  value: unknown;
  metadata: Record<string, unknown>;
}

type RegisterPlatformService = (registry: PlatformRegistry | undefined, entry: PlatformServiceEntry) => unknown;

export function registerStoragePlatformServices(registry?: PlatformRegistry, {
  storageProvider = null,
  storageKernel = null,
  userDataPath = "",
  registerPlatformService = null
}: {
  storageProvider?: StorageProviderRegistrationValue | null;
  storageKernel?: StorageKernelRegistrationValue | null;
  userDataPath?: string;
  registerPlatformService?: RegisterPlatformService | null;
} = {}): unknown[] {
  const register: RegisterPlatformService = typeof registerPlatformService === "function"
    ? registerPlatformService
    : (targetRegistry, entry) => {
        if (!targetRegistry || typeof targetRegistry.register !== "function") {
          throw new Error("A PlatformRegistry instance is required.");
        }
        return targetRegistry.register(entry);
      };
  return [
    register(registry, {
      id: "storage.provider",
      platform: "storage",
      label: "Storage provider",
      kind: "provider",
      ownerFeatureId: "storage-core",
      value: storageProvider,
      metadata: {
        protocolVersion: storageProvider?.protocolVersion || "",
        capabilityIds: storageProvider?.listCapabilities
          ? storageProvider.listCapabilities().capabilities.map((capability) => capability.id)
          : []
      }
    }),
    register(registry, {
      id: "storage.kernel",
      platform: "storage",
      label: "Storage kernel",
      kind: "repository",
      ownerFeatureId: "storage-core",
      value: storageKernel,
      metadata: {
        userDataPath,
        databasePath: storageKernel?.databasePath || "",
        objectRootPath: storageKernel?.objectRootPath || ""
      }
    })
  ];
}
