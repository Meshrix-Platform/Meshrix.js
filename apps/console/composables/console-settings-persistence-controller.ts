import type { Ref } from "vue";
import { saveSettings as saveSettingsRequest } from "../lib/agent-settings-client";
import { reloadRuntimeMounts, saveRuntimeMounts } from "../lib/runtime-mounts-client";
import type { AgentSettings } from "../lib/types";
import type { RefreshStateOptions } from "../types/app";
import { moduleNameLabels } from "./console-defaults";

type Options = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  mountDraft: Ref<Record<string, string>>;
  mountDraftDirty: Ref<boolean>;
  refreshState: (options?: RefreshStateOptions) => Promise<unknown>;
  setBusy: (key: string) => void;
  settingsDraft: Ref<AgentSettings>;
  settingsDraftDirty: Ref<boolean>;
  settingsPayloadForSave: () => AgentSettings;
};

export function createConsoleSettingsPersistenceController(options: Options) {
  async function saveMountModules(busy = "mounts"): Promise<void> {
    options.setBusy(busy);
    options.error.value = "";
    try {
      await saveRuntimeMounts({ mountModules: options.mountDraft.value });
      options.mountDraftDirty.value = false;
      await options.refreshState({ forceDrafts: false });
    } catch (error: unknown) {
      options.error.value = error instanceof Error ? error.message : "保存挂载模块失败。";
    } finally {
      options.clearBusy(busy);
    }
  }

  async function reloadModules(): Promise<void> {
    options.setBusy("module-reload");
    options.error.value = "";
    try {
      await reloadRuntimeMounts(options.settingsDraft.value);
      await options.refreshState({ forceDrafts: false });
    } catch (error: unknown) {
      options.error.value = error instanceof Error ? error.message : "重载模块失败。";
    } finally {
      options.clearBusy("module-reload");
    }
  }

  async function enableMountModule(name: string): Promise<void> {
    if (!String(options.mountDraft.value[name] ?? "").trim()) {
      options.error.value = `请先填写 ${moduleNameLabels[name] || name} 的模块路径。`;
      return;
    }
    await saveMountModules(`mount:${name}`);
  }

  async function disableMountModule(name: string): Promise<void> {
    options.mountDraft.value = { ...options.mountDraft.value, [name]: "" };
    await saveMountModules(`mount:${name}`);
  }

  async function saveSettings(): Promise<void> {
    options.setBusy("settings");
    options.error.value = "";
    try {
      await saveSettingsRequest(options.settingsPayloadForSave());
      options.settingsDraftDirty.value = false;
      await options.refreshState({ forceSettings: true, forceDrafts: false });
    } catch (error: unknown) {
      options.error.value = error instanceof Error ? error.message : "保存设置失败。";
    } finally {
      options.clearBusy("settings");
    }
  }

  async function saveModuleSettings(): Promise<void> {
    await saveSettings();
    if (!options.error.value) await saveMountModules("modules");
  }

  return { disableMountModule, enableMountModule, reloadModules, saveModuleSettings, saveMountModules, saveSettings };
}
