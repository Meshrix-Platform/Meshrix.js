// registerPlatformService is injected by the composition root (server-runtime).
// Foundation must not import from server-runtime directly.
export function registerModuleManagementPlatformServices(registry, {
  moduleManagement = null,
  runtime = null,
  runtimeOptions = {},
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
  const runtimeState = moduleManagement?.getRuntimeState
    ? moduleManagement.getRuntimeState()
    : {
        profile: runtimeOptions?.profile || "",
        mountNames: Object.keys(runtime?.mounts || {})
      };
  const mountList = moduleManagement?.listMounts
    ? moduleManagement.listMounts()
    : Object.entries(runtime?.mounts || {}).map(([name, mount]) => ({
        name,
        id: mount?.id || "",
        kind: mount?.kind || name,
        enabled: mount?.enabled !== false,
        reason: mount?.reason || ""
      }));
  const mountNames = mountList.map((mount) => mount.name).filter(Boolean);
  const architectureComponents = moduleManagement?.getArchitectureComponentInventory
    ? moduleManagement.getArchitectureComponentInventory()
    : {
        protocolVersion: "",
        baseComponents: [],
        foundationComponents: [],
        hydratableBaseComponents: [],
        nonHydratableBaseComponents: [],
        hydratableComponents: [],
        nonHydratableComponents: [],
        componentsByCategory: {},
        allComponents: []
      };
  return [
    register(registry, {
      id: "module-management.provider",
      platform: "module-management",
      label: "Module management provider",
      kind: "provider",
      ownerFeatureId: "module-management-core",
      value: moduleManagement,
      metadata: {
        protocolVersion: moduleManagement?.protocolVersion || "",
        profile: runtimeState.profile || "",
        mountNames
      }
    }),
    register(registry, {
      id: "module-management.serverRuntime",
      platform: "module-management",
      label: "Module management runtime port",
      kind: "provider",
      ownerFeatureId: "module-management-core",
      value: moduleManagement || runtime,
      metadata: {
        protocolVersion: moduleManagement?.protocolVersion || "",
        profile: runtimeState.profile || "",
        mountNames
      }
    }),
    register(registry, {
      id: "module-management.architectureComponents",
      platform: "module-management",
      label: "Architecture component inventory",
      kind: "component-inventory",
      ownerFeatureId: "module-management-core",
      value: architectureComponents,
      metadata: {
        protocolVersion: architectureComponents.protocolVersion || "",
        baseComponentCount: architectureComponents.baseComponents?.length || 0,
        hydratableBaseComponentCount: architectureComponents.hydratableBaseComponents?.length || 0,
        nonHydratableBaseComponentCount: architectureComponents.nonHydratableBaseComponents?.length || 0,
        hydratableComponentCount: architectureComponents.hydratableComponents?.length || 0,
        componentCount: architectureComponents.allComponents?.length || 0
      }
    }),
    register(registry, {
      id: "module-management.baseComponents",
      platform: "module-management",
      label: "Base components",
      kind: "component-list",
      ownerFeatureId: "module-management-core",
      value: architectureComponents.baseComponents || [],
      metadata: {
        protocolVersion: architectureComponents.protocolVersion || "",
        componentCount: architectureComponents.baseComponents?.length || 0,
        moduleCategory: "foundation",
        hydration: "mixed"
      }
    }),
    register(registry, {
      id: "module-management.nonHydratableBaseComponents",
      platform: "module-management",
      label: "Non-hydratable base components",
      kind: "component-list",
      ownerFeatureId: "module-management-core",
      value: architectureComponents.nonHydratableBaseComponents || [],
      metadata: {
        protocolVersion: architectureComponents.protocolVersion || "",
        componentCount: architectureComponents.nonHydratableBaseComponents?.length || 0,
        moduleCategory: "foundation",
        hydratable: false
      }
    }),
    register(registry, {
      id: "module-management.hydratableBaseComponents",
      platform: "module-management",
      label: "Hydratable base components",
      kind: "component-list",
      ownerFeatureId: "module-management-core",
      value: architectureComponents.hydratableBaseComponents || [],
      metadata: {
        protocolVersion: architectureComponents.protocolVersion || "",
        componentCount: architectureComponents.hydratableBaseComponents?.length || 0,
        moduleCategory: "foundation",
        hydratable: true
      }
    }),
    register(registry, {
      id: "module-management.hydratableComponents",
      platform: "module-management",
      label: "Hydratable components",
      kind: "component-list",
      ownerFeatureId: "module-management-core",
      value: architectureComponents.hydratableComponents || [],
      metadata: {
        protocolVersion: architectureComponents.protocolVersion || "",
        componentCount: architectureComponents.hydratableComponents?.length || 0,
        hydratable: true
      }
    }),
    register(registry, {
      id: "module-management.mounts",
      platform: "module-management",
      label: "Active mounts",
      kind: "mounts",
      ownerFeatureId: "module-management-core",
      value: mountList,
      metadata: {
        protocolVersion: moduleManagement?.protocolVersion || "",
        mountNames
      }
    })
  ];
}
