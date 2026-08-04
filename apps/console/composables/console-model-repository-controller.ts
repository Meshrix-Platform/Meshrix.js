import type { Ref } from "vue";
import { saveSettings } from "../lib/agent-settings-client";
import type {
  AgentModelConfig,
  AgentSettings,
} from "../lib/types";
import type { CloudProvider } from "../types/app";
import { modelAgentUid } from "./console-model-utils";
import { requestDestructiveConfirm } from "./console-destructive-operation-registry";
import { pushConsoleToast } from "./console-toast-controller";
import { consoleMessages, currentConsoleLocale } from "../i18n/console";

type ReadonlyRef<T> = {
  readonly value: T;
};

type ConsoleModelRepositoryControllerOptions = {
  clearBusy: (key: string) => void;
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
) : any {
  function createModelEntryUid(provider: CloudProvider | string) : any {
    const nonce: any = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    return modelAgentUid(provider, nonce);
  }

  function isModelLibraryCardExpanded(entry: AgentModelConfig) : any {
    return options.modelLibraryExpandedCards.value[options.modelEntryStatusKey(entry)] === true;
  }

  function toggleModelLibraryCard(entry: AgentModelConfig) : any {
    const key: any = options.modelEntryStatusKey(entry);
    options.modelLibraryExpandedCards.value = {
      ...options.modelLibraryExpandedCards.value,
      [key]: !options.modelLibraryExpandedCards.value[key],
    };
  }

  function addModelProvider() : any {
    const provider: any = options.selectedModelProvider.value;
    if (!provider) {
      return;
    }
    const entry: any = options.normalizeModelEntry({
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
    const key: any = options.modelEntryStatusKey(entry);
    options.settingsDraft.value.modelLibraryAgents = [
      entry,
      ...options.visibleModelEntries.value,
    ];
    options.modelLibraryExpandedCards.value = {
      ...options.modelLibraryExpandedCards.value,
      [key]: true,
    };
  }

  // Reports a rollback after a failed save: the draft snapshots were restored
  // but the user was never told. Kept info-toned — it is transient feedback;
  // the persistent failure detail stays in options.error.
  function surfaceRollback() : any {
    pushConsoleToast({
      tone: "info",
      message: consoleMessages[currentConsoleLocale.value].toast.rollbackRestored,
    });
  }

  async function removeModelProvider(provider: CloudProvider | AgentModelConfig) : Promise<any> {
    const entry: any = typeof provider === "string" ? null : provider;
    const removeKey: any = entry ? options.modelEntryStatusKey(entry) : String(provider);
    if (entry && options.modelEntryIsBound(entry)) {
      options.error.value = `智能体已绑定到 ${options.modelEntryBindingSummary(entry)}，请先解除引用后再删除。`;
      return;
    }
    const resource: any = entry ? String(entry.label || entry.alias || entry.provider || removeKey) : String(provider);
    if (!(await requestDestructiveConfirm("model-repository.provider.remove", { resource }))) {
      return;
    }
    const previousModels: any[] = [...options.visibleModelEntries.value];
    const previousEntries: any[] = [...options.visibleModelProviders.value];
    options.settingsDraft.value.modelLibraryAgents = entry
      ? options.visibleModelEntries.value.filter((item?: any) : any => options.modelEntryStatusKey(item) !== removeKey)
      : options.visibleModelEntries.value.filter((item?: any) : any => item.provider !== provider);
    const remainingExpandedCards: Record<string, any> = { ...options.modelLibraryExpandedCards.value };
    delete remainingExpandedCards[removeKey];
    options.modelLibraryExpandedCards.value = remainingExpandedCards;
    options.settingsDraft.value.modelLibraryEntries = [
      ...new Set<any>(options.settingsDraft.value.modelLibraryAgents.map((item?: any) : any => item.provider)),
    ] as CloudProvider[];
    options.setBusy(`model-remove:${removeKey}`);
    options.error.value = "";
    try {
      const saved: any = await saveSettings(options.settingsPayloadForSave());
      options.replaceSettingsDraftFromServer(saved);
    } catch (nextError: any) {
      options.settingsDraft.value.modelLibraryAgents = previousModels;
      options.settingsDraft.value.modelLibraryEntries = previousEntries;
      options.error.value =
        nextError instanceof Error ? nextError.message : "移除模型配置失败。";
      surfaceRollback();
    } finally {
      options.clearBusy(`model-remove:${removeKey}`);
    }
  }

  function duplicateModelEntry(entry: AgentModelConfig) : any {
    const copy: any = options.normalizeModelEntry({
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
    const key: any = options.modelEntryStatusKey(copy);
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
