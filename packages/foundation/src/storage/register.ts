// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
export function registerStoragePlatformServices(registry?: any, {
  storageProvider = null,
  storageKernel = null,
  userDataPath = "",
  registerPlatformService = null
}: Record<string, any> = {}) : any {
  const register: any = typeof registerPlatformService === "function"
    ? registerPlatformService
    : (targetRegistry?: any, entry?: any) : any => {
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
          ? storageProvider.listCapabilities().capabilities.map((capability?: any) : any => capability.id)
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
