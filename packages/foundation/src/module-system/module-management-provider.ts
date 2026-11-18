import {
  getMountConfigPath,
  getMountConfigPaths,
  loadMountConfig,
  mergeMountRouting,
  saveMountConfig
} from "./mount-config.ts";
// Dependencies injected by composition root (server-runtime).
// Foundation must not statically import from runtime packages.
let _settingsDeps: Record<string, any> = { loadSettings: null, saveSettings: null };

export function setModuleManagementSettingsDeps(deps?: any) : any {
  if (deps) {
    _settingsDeps = { ..._settingsDeps, ...deps };
  }
}

async function loadSettings(userDataPath?: any, opts?: any) : Promise<any> {
  if (!_settingsDeps.loadSettings) throw new Error("module-management: loadSettings not wired");
  return _settingsDeps.loadSettings(userDataPath, opts);
}
async function saveSettings(userDataPath?: any, settings?: any, opts?: any) : Promise<any> {
  if (!_settingsDeps.saveSettings) throw new Error("module-management: saveSettings not wired");
  return _settingsDeps.saveSettings(userDataPath, settings, opts);
}
import {
  ARCHITECTURE_FACT_MANIFEST_VERSION,
  buildArchitectureComponentInventory
} from "../composition-management/architecture/manifest.ts";

export const MODULE_MANAGEMENT_PROTOCOL_VERSION: any = "v0.0.1:tool:module-management-1";

function plainObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function cloneObject(value: Record<string, any> = {}) : any {
  return { ...plainObject(value) };
}

function summarizeMount(name?: any, mount?: any) : any {
  return {
    name,
    id: mount?.id || "",
    kind: mount?.kind || name,
    enabled: mount?.enabled !== false,
    reason: mount?.reason || "",
    supportsStructuredDocument: typeof mount?.extractDocument === "function",
    supportsTextExtraction: typeof mount?.extractText === "function",
    supportsBatchHook: typeof mount?.onBatchCompleted === "function"
  };
}

function runtimeState(runtime?: any) : any {
  const options: any = runtime?.runtimeOptions || {};
  return {
    profile: options.profile || "",
    cwd: options.cwd || "",
    mountGeneration: runtime?.mountGeneration || 0,
    mountModules: cloneObject(options.mountModules),
    mountRouting: {
      kindRoutes: cloneObject(options.mountRouting?.kindRoutes),
      extensionRoutes: cloneObject(options.mountRouting?.extensionRoutes),
      mediaTypeRoutes: cloneObject(options.mountRouting?.mediaTypeRoutes)
    }
  };
}

function runtimeMountState(runtime?: any) : any {
  const state: any = runtimeState(runtime);
  return {
    mountGeneration: state.mountGeneration,
    mountModules: state.mountModules,
    mountRouting: state.mountRouting
  };
}

function validationFailurePayload(error?: any, value?: any, runtime?: any) : any {
  return {
    ok: false,
    statusCode: 400,
    error: error instanceof Error ? error.message : "挂载配置不可用。",
    value,
    runtime: runtimeMountState(runtime)
  };
}

function persistenceFailurePayload(error?: any, value?: any, runtime?: any) : any {
  return {
    ok: false,
    statusCode: 500,
    error: error instanceof Error ? error.message : "挂载配置持久化失败，运行态已回滚。",
    value,
    runtime: runtimeMountState(runtime)
  };
}

export function createModuleManagementProvider({
  runtime,
  userDataPath,
  activeFeatureIds = null
}: Record<string, any> = {}) : any {
  if (!runtime) {
    throw new Error("module-management provider requires a server runtime.");
  }
  const architectureInventory: any = () : any => buildArchitectureComponentInventory({ activeFeatureIds });

  async function buildRuntimeConsoleSummary({
    settings = {}
  }: Record<string, any> = {}) : Promise<any> {
    const state: any = runtimeState(runtime);
    const mountConfig: any = await loadMountConfig(userDataPath);
    const architectureComponents: any = architectureInventory();
    return {
      profile: state.profile,
      cwd: state.cwd,
      mountModules: state.mountModules,
      mountRouting: state.mountRouting,
      mountGeneration: state.mountGeneration,
      mountConfigPath: getMountConfigPath(userDataPath),
      mountConfigPaths: getMountConfigPaths(userDataPath),
      mountConfig,
      mounts: (Object.entries(runtime.mounts || {}) as [string, any][]).map(([name, mount]: any[]) : any => summarizeMount(name, mount)),
      architectureComponents
    };
  }

  return Object.freeze({
    protocolVersion: MODULE_MANAGEMENT_PROTOCOL_VERSION,
    architectureProtocolVersion: ARCHITECTURE_FACT_MANIFEST_VERSION,
    getRuntimeState() : any {
      return runtimeState(runtime);
    },
    getArchitectureComponentInventory() : any {
      return architectureInventory();
    },
    listBaseComponents() : any {
      return architectureInventory().baseComponents;
    },
    listHydratableBaseComponents() : any {
      return architectureInventory().hydratableBaseComponents;
    },
    listNonHydratableBaseComponents() : any {
      return architectureInventory().nonHydratableBaseComponents;
    },
    listHydratableComponents() : any {
      return architectureInventory().hydratableComponents;
    },
    listNonHydratableComponents() : any {
      return architectureInventory().nonHydratableComponents;
    },
    getMountState() : any {
      return runtimeMountState(runtime);
    },
    getMountConfigPath() : any {
      return getMountConfigPath(userDataPath);
    },
    getMountConfigPaths() : any {
      return getMountConfigPaths(userDataPath);
    },
    async getSavedMountConfig() : Promise<any> {
      return loadMountConfig(userDataPath);
    },
    listMounts() : any {
      return (Object.entries(runtime.mounts || {}) as [string, any][]).map(([name, mount]: any[]) : any => summarizeMount(name, mount));
    },
    createExecutionView() : any {
      return runtime.createExecutionView();
    },
    buildRuntimeConsoleSummary,
    async getMountsSnapshot({
      features = null
    }: Record<string, any> = {}) : Promise<any> {
      const settings: any = await loadSettings(userDataPath, { redactSecrets: true });
      const savedConfig: any = await loadMountConfig(userDataPath);
      const summary: any = await buildRuntimeConsoleSummary({
        settings,
        features
      });
      return {
        path: getMountConfigPath(userDataPath),
        paths: getMountConfigPaths(userDataPath),
        value: savedConfig,
        runtime: {
          ...runtimeMountState(runtime),
          mounts: summary.mounts.map(({ name, id, kind, enabled, reason }: Record<string, any>) : any => ({
            name,
            id,
            kind,
            enabled,
            reason
          }))
        }
      };
    },
    async setMounts(input: Record<string, any> = {}) : Promise<any> {
      const value: any = input?.value || input || {};
      const currentSavedConfig: any = await loadMountConfig(userDataPath);
      const candidateConfig: Record<string, any> = {
        mountModules: {
          ...cloneObject(runtime.runtimeOptions?.mountModules),
          ...plainObject(value.mountModules)
        },
        mountRouting: mergeMountRouting(
          runtime.runtimeOptions?.mountRouting || {},
          plainObject(value.mountRouting)
        )
      };
      const settings: any = await loadSettings(userDataPath);
      try {
        await runtime.applyMountConfig(candidateConfig, { settings });
      } catch (error: any) {
        return validationFailurePayload(error, currentSavedConfig, runtime);
      }

      let savedConfig: any;
      try {
        savedConfig = await saveMountConfig(userDataPath, candidateConfig);
      } catch (error: any) {
        await runtime.applyMountConfig(currentSavedConfig, { settings }).catch(() : any => {});
        return persistenceFailurePayload(error, currentSavedConfig, runtime);
      }

      return {
        ok: true,
        path: getMountConfigPath(userDataPath),
        paths: getMountConfigPaths(userDataPath),
        value: savedConfig,
        runtime: runtimeMountState(runtime)
      };
    },
    async reloadMounts(input: Record<string, any> = {}) : Promise<any> {
      const settings: any = input?.settings
        ? await saveSettings(userDataPath, input.settings, { redactSecrets: false })
        : await loadSettings(userDataPath);
      const savedConfig: any = await loadMountConfig(userDataPath);
      try {
        await runtime.applyMountConfig(savedConfig, { settings });
      } catch (error: any) {
        return {
          ...validationFailurePayload(error, savedConfig, runtime),
          ...runtimeMountState(runtime)
        };
      }

      return {
        ok: true,
        path: getMountConfigPath(userDataPath),
        paths: getMountConfigPaths(userDataPath),
        value: savedConfig,
        ...runtimeMountState(runtime),
        runtime: runtimeMountState(runtime)
      };
    },
    async refreshMounts({ settings }: Record<string, any> = {}) : Promise<any> {
      return runtime.refreshMounts({ settings });
    }
  });
}
