import type { AgentModelConfig, AgentSettings } from "../lib/types";

type SettingsDraftActions = {
  moduleAgentProfilesPayload: () => AgentSettings["moduleAgentProfiles"];
  normalizeModelLibraryAgents: (settings: AgentSettings) => AgentModelConfig[];
  normalizeRemoteSettings: (settings: AgentSettings) => AgentSettings;
  normalizedSettingsFromServer: (settings: AgentSettings) => AgentSettings;
  remoteDraftEquals: (left: unknown, right: unknown) => boolean;
  replaceSettingsDraftFromServer: (
    settings: AgentSettings,
    options?: { markClean?: boolean },
  ) => void;
  settingsDraftEquals: (left: AgentSettings, right: AgentSettings) => boolean;
  settingsPayloadForSave: () => AgentSettings;
};

type SettingsPersistenceActions = {
  disableMountModule: (name: string) => Promise<unknown>;
  enableMountModule: (name: string) => Promise<unknown>;
  reloadModules: () => Promise<unknown>;
  saveModelLibrarySettings: () => Promise<unknown>;
  saveModuleSettings: () => Promise<unknown>;
  saveMountModules: (busy?: string) => Promise<unknown>;
  saveSettings: () => Promise<unknown>;
};

export function createConsoleSettingsBridgeController() {
  let applyingRemoteConsoleDrafts = false;
  let settingsDraftActions: SettingsDraftActions | null = null;
  let settingsPersistenceActions: SettingsPersistenceActions | null = null;

  function bindSettingsDraftActions(actions: SettingsDraftActions) {
    settingsDraftActions = actions;
    return actions;
  }

  function bindSettingsPersistenceActions(actions: SettingsPersistenceActions) {
    settingsPersistenceActions = actions;
    return actions;
  }

  function settingsDraftController() {
    if (!settingsDraftActions) {
      throw new Error("Settings draft controller has not been initialized.");
    }
    return settingsDraftActions;
  }

  function settingsPersistenceController() {
    if (!settingsPersistenceActions) {
      throw new Error("Settings persistence controller has not been initialized.");
    }
    return settingsPersistenceActions;
  }

  function isApplyingRemoteConsoleDrafts() {
    return applyingRemoteConsoleDrafts;
  }

  function applyRemoteConsoleDraftUpdate(update: () => void) {
    applyingRemoteConsoleDrafts = true;
    try {
      update();
    } finally {
      applyingRemoteConsoleDrafts = false;
    }
  }

  function normalizeModelLibraryAgents(settings: AgentSettings) {
    return settingsDraftController().normalizeModelLibraryAgents(settings);
  }

  function moduleAgentProfilesPayload() {
    return settingsDraftController().moduleAgentProfilesPayload();
  }

  function normalizeRemoteSettings(settings: AgentSettings) {
    return settingsDraftController().normalizeRemoteSettings(settings);
  }

  function settingsPayloadForSave() {
    return settingsDraftController().settingsPayloadForSave();
  }

  function normalizedSettingsFromServer(settings: AgentSettings) {
    return settingsDraftController().normalizedSettingsFromServer(settings);
  }

  function remoteDraftEquals(left: unknown, right: unknown) {
    return settingsDraftController().remoteDraftEquals(left, right);
  }

  function settingsDraftEquals(left: AgentSettings, right: AgentSettings) {
    return settingsDraftController().settingsDraftEquals(left, right);
  }

  function replaceSettingsDraftFromServer(
    settings: AgentSettings,
    options: { markClean?: boolean } = {},
  ) {
    settingsDraftController().replaceSettingsDraftFromServer(settings, options);
  }

  async function saveModuleSettings() {
    return settingsPersistenceController().saveModuleSettings();
  }

  async function saveMountModules(busy = "mounts") {
    return settingsPersistenceController().saveMountModules(busy);
  }

  async function reloadModules() {
    return settingsPersistenceController().reloadModules();
  }

  async function enableMountModule(name: string) {
    return settingsPersistenceController().enableMountModule(name);
  }

  async function disableMountModule(name: string) {
    return settingsPersistenceController().disableMountModule(name);
  }

  async function saveSettings() {
    return settingsPersistenceController().saveSettings();
  }

  async function saveModelLibrarySettings() {
    return settingsPersistenceController().saveModelLibrarySettings();
  }

  return {
    applyRemoteConsoleDraftUpdate,
    get applyingRemoteConsoleDrafts() {
      return applyingRemoteConsoleDrafts;
    },
    bindSettingsDraftActions,
    bindSettingsPersistenceActions,
    disableMountModule,
    enableMountModule,
    isApplyingRemoteConsoleDrafts,
    moduleAgentProfilesPayload,
    normalizeModelLibraryAgents,
    normalizeRemoteSettings,
    normalizedSettingsFromServer,
    reloadModules,
    remoteDraftEquals,
    replaceSettingsDraftFromServer,
    saveModelLibrarySettings,
    saveModuleSettings,
    saveMountModules,
    saveSettings,
    settingsDraftEquals,
    settingsPayloadForSave,
  };
}
