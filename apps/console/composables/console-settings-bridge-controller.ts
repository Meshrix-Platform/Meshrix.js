import type { AgentSettings } from "../lib/types";

type DraftActions = ReturnType<typeof import("./console-settings-draft-controller").createConsoleSettingsDraftController>;
type PersistenceActions = ReturnType<typeof import("./console-settings-persistence-controller").createConsoleSettingsPersistenceController>;

export function createConsoleSettingsBridgeController() {
  let applyingRemoteConsoleDrafts = false;
  let draft: DraftActions | null = null;
  let persistence: PersistenceActions | null = null;
  const requireDraft = () => {
    if (!draft) throw new Error("Settings draft controller has not been initialized.");
    return draft;
  };
  const requirePersistence = () => {
    if (!persistence) throw new Error("Settings persistence controller has not been initialized.");
    return persistence;
  };
  return {
    applyRemoteConsoleDraftUpdate(update: () => void) {
      applyingRemoteConsoleDrafts = true;
      try { update(); } finally { applyingRemoteConsoleDrafts = false; }
    },
    get applyingRemoteConsoleDrafts() { return applyingRemoteConsoleDrafts; },
    bindSettingsDraftActions(actions: DraftActions) { draft = actions; return actions; },
    bindSettingsPersistenceActions(actions: PersistenceActions) { persistence = actions; return actions; },
    disableMountModule: (name: string) => requirePersistence().disableMountModule(name),
    enableMountModule: (name: string) => requirePersistence().enableMountModule(name),
    isApplyingRemoteConsoleDrafts: () => applyingRemoteConsoleDrafts,
    normalizeRemoteSettings: (settings: AgentSettings) => requireDraft().normalizeRemoteSettings(settings),
    normalizedSettingsFromServer: (settings: AgentSettings) => requireDraft().normalizedSettingsFromServer(settings),
    reloadModules: () => requirePersistence().reloadModules(),
    remoteDraftEquals: (left: unknown, right: unknown) => requireDraft().remoteDraftEquals(left, right),
    replaceSettingsDraftFromServer: (settings: AgentSettings, options?: { markClean?: boolean }) =>
      requireDraft().replaceSettingsDraftFromServer(settings, options),
    saveModuleSettings: () => requirePersistence().saveModuleSettings(),
    saveMountModules: (busy?: string) => requirePersistence().saveMountModules(busy),
    saveSettings: () => requirePersistence().saveSettings(),
    settingsDraftEquals: (left: AgentSettings, right: AgentSettings) => requireDraft().settingsDraftEquals(left, right),
    settingsPayloadForSave: () => requireDraft().settingsPayloadForSave()
  };
}
