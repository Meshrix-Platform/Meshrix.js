import { watch, type Ref } from "vue";
import type { AgentSettings } from "../lib/types";
import { emptySettings } from "./console-defaults";

type Options = {
  settingsDraft: Ref<AgentSettings>;
  settingsDraftDirty: Ref<boolean>;
};

export function remoteDraftEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeSettingsDraft(settings: Partial<AgentSettings>): AgentSettings {
  return {
    executionSandbox: settings.executionSandbox ?? null,
    agentToolExecution: {
      functionCallSchema: settings.agentToolExecution?.functionCallSchema ?? {},
      http: {
        ...emptySettings.agentToolExecution.http,
        ...settings.agentToolExecution?.http
      },
      local: {
        ...emptySettings.agentToolExecution.local,
        ...settings.agentToolExecution?.local,
        commands: settings.agentToolExecution?.local?.commands ?? []
      }
    }
  };
}

export function createConsoleSettingsDraftController(options: Options) {
  let applyingRemoteSettings = false;

  watch(options.settingsDraft, () => {
    if (!applyingRemoteSettings) options.settingsDraftDirty.value = true;
  }, { deep: true, flush: "sync" });

  function replaceSettingsDraftFromServer(
    settings: AgentSettings,
    replaceOptions: { markClean?: boolean } = {}
  ): void {
    const normalized = normalizeSettingsDraft(settings);
    if (!remoteDraftEquals(options.settingsDraft.value, normalized)) {
      applyingRemoteSettings = true;
      options.settingsDraft.value = normalized;
      queueMicrotask(() => { applyingRemoteSettings = false; });
    }
    if (replaceOptions.markClean !== false) options.settingsDraftDirty.value = false;
  }

  return {
    isApplyingRemoteSettings: () => applyingRemoteSettings,
    normalizeRemoteSettings: normalizeSettingsDraft,
    normalizedSettingsFromServer: normalizeSettingsDraft,
    remoteDraftEquals,
    replaceSettingsDraftFromServer,
    settingsDraftEquals: remoteDraftEquals,
    settingsPayloadForSave: () => normalizeSettingsDraft(options.settingsDraft.value)
  };
}
