// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
export function registerStoragePlatformServices(registry, {
  storageProvider = null,
  storageKernel = null,
  userDataPath = "",
  registerPlatformService = null
} = {}) {
  const register = typeof registerPlatformService === "function"
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
