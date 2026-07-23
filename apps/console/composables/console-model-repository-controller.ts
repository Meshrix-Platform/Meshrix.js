import type { Ref } from "vue";
import { saveSettings } from "../lib/agent-settings-client";
import type {
  AgentModelConfig,
  AgentSettings,
} from "../lib/types";
import type { CloudProvider } from "../types/app";
import { modelAgentUid } from "./console-model-utils";

type ReadonlyRef<T> = {
  readonly value: T;
};

type ConsoleModelRepositoryControllerOptions = {
  clearAllBusy: () => void;
  error: Ref<string>;
  modelEntryBindingSummary: (entry: AgentModelConfig) => string;
  modelEntryIsBound: (entry: AgentModelConfig) => boolean;
  modelEntryStatusKey: (entry: AgentModelConfig) => string;
  modelLibraryExpandedCards: Ref<Record<string, boolean>>;
  normalizeModelEntry: (entry: Partial<AgentModelConfig>, index?: number) => AgentModelConfig;
  providerLabel: (provider: CloudProvider | string) => string;
  replaceSettingsDraftFromServer: (settings: AgentSettings, options?: { markClean?: boolean }) => void;
  selectedModelProvider: Ref<CloudProvider>;
  setBusy: (key: string) => void;
  settingsDraft: Ref<AgentSettings>;
  settingsPayloadForSave: () => AgentSettings;
  visibleModelEntries: ReadonlyRef<AgentModelConfig[]>;
  visibleModelProviders: ReadonlyRef<CloudProvider[]>;
};

export function createConsoleModelRepositoryController(
  options: ConsoleModelRepositoryControllerOptions,
) {
  function createModelEntryUid(provider: CloudProvider | string) {
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    return modelAgentUid(provider, nonce);
  }

  function isModelLibraryCardExpanded(entry: AgentModelConfig) {
    return options.modelLibraryExpandedCards.value[options.modelEntryStatusKey(entry)] === true;
  }

  function toggleModelLibraryCard(entry: AgentModelConfig) {
    const key = options.modelEntryStatusKey(entry);
    options.modelLibraryExpandedCards.value = {
      ...options.modelLibraryExpandedCards.value,
      [key]: !options.modelLibraryExpandedCards.value[key],
    };
  }

  function addModelProvider() {
    const provider = options.selectedModelProvider.value;
    if (!provider) {
      return;
    }
    const entry = options.normalizeModelEntry({
      uid: createModelEntryUid(provider),
      provider,
      model: "",
      label: `${options.providerLabel(provider)} 智能体`,
      baseUrl: "",
      apiKeyConfigured: false,
      tokenConfigured: false,
      tokenHeader: provider === "local-model" ? "" : "Authorization",
      tokenPrefix: provider === "local-model" ? "" : "Bearer ",
      timeoutMs: 120000,
    }, Date.now());
    const key = options.modelEntryStatusKey(entry);
    options.settingsDraft.value.modelLibraryAgents = [
      entry,
      ...options.visibleModelEntries.value,
    ];
    options.modelLibraryExpandedCards.value = {
      ...options.modelLibraryExpandedCards.value,
      [key]: true,
    };
  }

  async function removeModelProvider(provider: CloudProvider | AgentModelConfig) {
    const entry = typeof provider === "string" ? null : provider;
    const removeKey = entry ? options.modelEntryStatusKey(entry) : String(provider);
    if (entry && options.modelEntryIsBound(entry)) {
      options.error.value = `智能体已绑定到 ${options.modelEntryBindingSummary(entry)}，请先解除引用后再删除。`;
      return;
    }
    const previousModels = [...options.visibleModelEntries.value];
    const previousEntries = [...options.visibleModelProviders.value];
    options.settingsDraft.value.modelLibraryAgents = entry
      ? options.visibleModelEntries.value.filter((item) => options.modelEntryStatusKey(item) !== removeKey)
      : options.visibleModelEntries.value.filter((item) => item.provider !== provider);
    const remainingExpandedCards = { ...options.modelLibraryExpandedCards.value };
    delete remainingExpandedCards[removeKey];
    options.modelLibraryExpandedCards.value = remainingExpandedCards;
    options.settingsDraft.value.modelLibraryEntries = [
      ...new Set(options.settingsDraft.value.modelLibraryAgents.map((item) => item.provider)),
    ] as CloudProvider[];
    options.setBusy(`model-remove:${removeKey}`);
    options.error.value = "";
    try {
      const saved = await saveSettings(options.settingsPayloadForSave());
      options.replaceSettingsDraftFromServer(saved);
    } catch (nextError) {
      options.settingsDraft.value.modelLibraryAgents = previousModels;
      options.settingsDraft.value.modelLibraryEntries = previousEntries;
      options.error.value =
        nextError instanceof Error ? nextError.message : "移除模型配置失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  function duplicateModelEntry(entry: AgentModelConfig) {
    const copy = options.normalizeModelEntry({
      ...entry,
      uid: createModelEntryUid(entry.provider),
      instanceId: "",
      alias: "",
      label: `${entry.label || entry.alias} 副本`,
      apiKey: "",
      apiKeyConfigured: false,
      token: "",
      tokenConfigured: false,
    }, Date.now());
    const key = options.modelEntryStatusKey(copy);
    options.settingsDraft.value.modelLibraryAgents = [copy, ...options.visibleModelEntries.value];
    options.modelLibraryExpandedCards.value = {
      ...options.modelLibraryExpandedCards.value,
      [key]: true,
    };
  }

  return {
    addModelProvider,
    duplicateModelEntry,
    isModelLibraryCardExpanded,
    removeModelProvider,
    toggleModelLibraryCard,
  };
}
