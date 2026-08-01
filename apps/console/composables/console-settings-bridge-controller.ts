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

export function createConsoleSettingsBridgeController() : any {
  let applyingRemoteConsoleDrafts: any = false;
  let settingsDraftActions: SettingsDraftActions | null = null;
  let settingsPersistenceActions: SettingsPersistenceActions | null = null;

  function bindSettingsDraftActions(actions: SettingsDraftActions) : any {
    settingsDraftActions = actions;
    return actions;
  }

  function bindSettingsPersistenceActions(actions: SettingsPersistenceActions) : any {
    settingsPersistenceActions = actions;
    return actions;
  }

  function settingsDraftController() : any {
    if (!settingsDraftActions) {
      throw new Error("Settings draft controller has not been initialized.");
    }
    return settingsDraftActions;
  }

  function settingsPersistenceController() : any {
    if (!settingsPersistenceActions) {
      throw new Error("Settings persistence controller has not been initialized.");
    }
    return settingsPersistenceActions;
  }

  function isApplyingRemoteConsoleDrafts() : any {
    return applyingRemoteConsoleDrafts;
  }

  function applyRemoteConsoleDraftUpdate(update: () => void) : any {
    applyingRemoteConsoleDrafts = true;
    try {
      update();
    } finally {
      applyingRemoteConsoleDrafts = false;
    }
  }

  function normalizeModelLibraryAgents(settings: AgentSettings) : any {
    return settingsDraftController().normalizeModelLibraryAgents(settings);
  }

  function moduleAgentProfilesPayload() : any {
    return settingsDraftController().moduleAgentProfilesPayload();
  }

  function normalizeRemoteSettings(settings: AgentSettings) : any {
    return settingsDraftController().normalizeRemoteSettings(settings);
  }

  function settingsPayloadForSave() : any {
    return settingsDraftController().settingsPayloadForSave();
  }

  function normalizedSettingsFromServer(settings: AgentSettings) : any {
    return settingsDraftController().normalizedSettingsFromServer(settings);
  }

  function remoteDraftEquals(left: unknown, right: unknown) : any {
    return settingsDraftController().remoteDraftEquals(left, right);
  }

  function settingsDraftEquals(left: AgentSettings, right: AgentSettings) : any {
    return settingsDraftController().settingsDraftEquals(left, right);
  }

  function replaceSettingsDraftFromServer(
    settings: AgentSettings,
    options: { markClean?: boolean } = {},
  ) : any {
    settingsDraftController().replaceSettingsDraftFromServer(settings, options);
  }

  async function saveModuleSettings() : Promise<any> {
    return settingsPersistenceController().saveModuleSettings();
  }

  async function saveMountModules(busy: any = "mounts") : Promise<any> {
    return settingsPersistenceController().saveMountModules(busy);
  }

  async function reloadModules() : Promise<any> {
    return settingsPersistenceController().reloadModules();
  }

  async function enableMountModule(name: string) : Promise<any> {
    return settingsPersistenceController().enableMountModule(name);
  }

  async function disableMountModule(name: string) : Promise<any> {
    return settingsPersistenceController().disableMountModule(name);
  }

  async function saveSettings() : Promise<any> {
    return settingsPersistenceController().saveSettings();
  }

  async function saveModelLibrarySettings() : Promise<any> {
    return settingsPersistenceController().saveModelLibrarySettings();
  }

  return {
    applyRemoteConsoleDraftUpdate,
    get applyingRemoteConsoleDrafts() : any {
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
