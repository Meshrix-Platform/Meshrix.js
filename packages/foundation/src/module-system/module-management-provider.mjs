import {
  getMountConfigPath,
  getMountConfigPaths,
  loadMountConfig,
  mergeMountRouting,
  saveMountConfig
} from "./mount-config.mjs";
// Dependencies injected by composition root (server-runtime).
// Foundation must not statically import from runtime packages.
let _settingsDeps = { loadSettings: null, saveSettings: null };

export function setModuleManagementSettingsDeps(deps) {
  if (deps) {
    _settingsDeps = { ..._settingsDeps, ...deps };
  }
}

async function loadSettings(userDataPath, opts) {
  if (!_settingsDeps.loadSettings) throw new Error("module-management: loadSettings not wired");
  return _settingsDeps.loadSettings(userDataPath, opts);
}
async function saveSettings(userDataPath, settings, opts) {
  if (!_settingsDeps.saveSettings) throw new Error("module-management: saveSettings not wired");
  return _settingsDeps.saveSettings(userDataPath, settings, opts);
}
import {
  ARCHITECTURE_FACT_MANIFEST_VERSION,
  buildArchitectureComponentInventory
} from "../composition-management/architecture/manifest.mjs";

export const MODULE_MANAGEMENT_PROTOCOL_VERSION = "v0.0.1:tool:module-management-1";

function plainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function cloneObject(value = {}) {
  return { ...plainObject(value) };
}

function summarizeMount(name, mount) {
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

function runtimeState(runtime) {
  const options = runtime?.runtimeOptions || {};
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

function runtimeMountState(runtime) {
  const state = runtimeState(runtime);
  return {
    mountGeneration: state.mountGeneration,
    mountModules: state.mountModules,
    mountRouting: state.mountRouting
  };
}

function validationFailurePayload(error, value, runtime) {
  return {
    ok: false,
    statusCode: 400,
    error: error instanceof Error ? error.message : "挂载配置不可用。",
    value,
    runtime: runtimeMountState(runtime)
  };
}

function persistenceFailurePayload(error, value, runtime) {
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
} = {}) {
  if (!runtime) {
    throw new Error("module-management provider requires a server runtime.");
  }
  const architectureInventory = () => buildArchitectureComponentInventory({ activeFeatureIds });

  async function buildRuntimeConsoleSummary({
    settings = {}
  } = {}) {
    const state = runtimeState(runtime);
    const mountConfig = await loadMountConfig(userDataPath);
    const architectureComponents = architectureInventory();
    return {
      profile: state.profile,
      cwd: state.cwd,
      mountModules: state.mountModules,
      mountRouting: state.mountRouting,
      mountGeneration: state.mountGeneration,
      mountConfigPath: getMountConfigPath(userDataPath),
      mountConfigPaths: getMountConfigPaths(userDataPath),
      mountConfig,
      mounts: Object.entries(runtime.mounts || {}).map(([name, mount]) => summarizeMount(name, mount)),
      architectureComponents
    };
  }

  return Object.freeze({
    protocolVersion: MODULE_MANAGEMENT_PROTOCOL_VERSION,
    architectureProtocolVersion: ARCHITECTURE_FACT_MANIFEST_VERSION,
    getRuntimeState() {
      return runtimeState(runtime);
    },
    getArchitectureComponentInventory() {
      return architectureInventory();
    },
    listBaseComponents() {
      return architectureInventory().baseComponents;
    },
    listHydratableBaseComponents() {
      return architectureInventory().hydratableBaseComponents;
    },
    listNonHydratableBaseComponents() {
      return architectureInventory().nonHydratableBaseComponents;
    },
    listHydratableComponents() {
      return architectureInventory().hydratableComponents;
    },
    listNonHydratableComponents() {
      return architectureInventory().nonHydratableComponents;
    },
    getMountState() {
      return runtimeMountState(runtime);
    },
    getMountConfigPath() {
      return getMountConfigPath(userDataPath);
    },
    getMountConfigPaths() {
      return getMountConfigPaths(userDataPath);
    },
    async getSavedMountConfig() {
      return loadMountConfig(userDataPath);
    },
    listMounts() {
      return Object.entries(runtime.mounts || {}).map(([name, mount]) => summarizeMount(name, mount));
    },
    createExecutionView() {
      return runtime.createExecutionView();
    },
    buildRuntimeConsoleSummary,
    async getMountsSnapshot({
      features = null
    } = {}) {
      const settings = await loadSettings(userDataPath, { redactSecrets: true });
      const savedConfig = await loadMountConfig(userDataPath);
      const summary = await buildRuntimeConsoleSummary({
        settings,
        features
      });
      return {
        path: getMountConfigPath(userDataPath),
        paths: getMountConfigPaths(userDataPath),
        value: savedConfig,
        runtime: {
          ...runtimeMountState(runtime),
          mounts: summary.mounts.map(({ name, id, kind, enabled, reason }) => ({
            name,
            id,
            kind,
            enabled,
            reason
          }))
        }
      };
    },
    async setMounts(input = {}) {
      const value = input?.value || input || {};
      const currentSavedConfig = await loadMountConfig(userDataPath);
      const candidateConfig = {
        mountModules: {
          ...cloneObject(runtime.runtimeOptions?.mountModules),
          ...plainObject(value.mountModules)
        },
        mountRouting: mergeMountRouting(
          runtime.runtimeOptions?.mountRouting || {},
          plainObject(value.mountRouting)
        )
      };
      const settings = await loadSettings(userDataPath);
      try {
        await runtime.applyMountConfig(candidateConfig, { settings });
      } catch (error) {
        return validationFailurePayload(error, currentSavedConfig, runtime);
      }

      let savedConfig;
      try {
        savedConfig = await saveMountConfig(userDataPath, candidateConfig);
      } catch (error) {
        await runtime.applyMountConfig(currentSavedConfig, { settings }).catch(() => {});
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
    async reloadMounts(input = {}) {
      const settings = input?.settings
        ? await saveSettings(userDataPath, input.settings, { redactSecrets: false })
        : await loadSettings(userDataPath);
      const savedConfig = await loadMountConfig(userDataPath);
      try {
        await runtime.applyMountConfig(savedConfig, { settings });
      } catch (error) {
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
    async refreshMounts({ settings } = {}) {
      return runtime.refreshMounts({ settings });
    }
  });
}
