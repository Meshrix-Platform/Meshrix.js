import { computed, type Ref } from "vue";
import type {
  AgentModelConfig,
  AgentSettings,
  ModelProbeResponse,
} from "../lib/types";
import type { CloudProvider } from "../types/app";
import { downloadTextFile } from "./console-browser-effects";
import { modelLibraryProviderDefinitions } from "./console-defaults";
import { formatMachineDate, safeDownloadName } from "./console-format-utils";
import { createConsoleModelEntryBindingController } from "./console-model-entry-binding-controller";
import { createConsoleModelModuleAssignmentController } from "./console-model-module-assignment-controller";
import { createConsoleModelProbeController } from "./console-model-probe-controller";
import { createConsoleModelRepositoryController } from "./console-model-repository-controller";
import {
  modelEntryParameters,
  modelProviderLabel,
  normalizeModelLibraryEntries,
  redactAgentModelEntryForExport,
  redactedProviderSettingsForAgentExport,
} from "./console-model-utils";

type ConsoleModelLibraryControllerOptions = {
  gatewayAssistantModelAlias: () => string;
  clearAllBusy: () => void;
  currentAgentModelOptionLabel: (value?: string) => string;
  error: Ref<string>;
  modelLibraryExpandedCards: Ref<Record<string, boolean>>;
  modelProbeResults: Ref<Record<string, ModelProbeResponse>>;
  moduleAgentCandidateDrafts: Ref<Record<string, string>>;
  normalizeModelEntry: (entry: Partial<AgentModelConfig>, index?: number) => AgentModelConfig;
  replaceSettingsDraftFromServer: (settings: AgentSettings, options?: { markClean?: boolean }) => void;
  ruleAuthoringModelAlias: () => string;
  selectedModelProvider: Ref<CloudProvider>;
  setBusy: (key: string) => void;
  settingsDraft: Ref<AgentSettings>;
  settingsPayloadForSave: () => AgentSettings;
};

export function createConsoleModelLibraryController(options: ConsoleModelLibraryControllerOptions) {
  const providerLabel = modelProviderLabel;

  function modelRef(provider: string, model: string) {
    return `${provider}:${model || ""}`;
  }

  function parseModelRef(refValue: string) {
    const [provider, ...modelParts] = String(refValue || "").split(":");
    return {
      provider: (provider || "") as CloudProvider,
      model: modelParts.join(":") || "",
    };
  }

  function modelProviderDefinition(provider: CloudProvider | string) {
    return modelLibraryProviderDefinitions.find((item) => item.id === provider);
  }

  const visibleModelProviders = computed(() =>
    normalizeModelLibraryEntries(options.settingsDraft.value.modelLibraryEntries),
  );

  const visibleModelEntries = computed(() => options.settingsDraft.value.modelLibraryAgents || []);
  const addableModelProviders = computed(() => modelLibraryProviderDefinitions);

  function modelEntryConfigured(entry: AgentModelConfig) {
    const hasModel = Boolean(String(entry.model ?? entry.engine ?? "").trim());
    const hasIdentity = Boolean(String(entry.uid || entry.instanceId || entry.alias || "").trim());
    const hasEndpoint = Boolean(String(entry.baseUrl || entry.url || "").trim());
    const hasTimeout = Number.isFinite(Number(entry.timeoutMs)) && Number(entry.timeoutMs) > 0;
    const credentialConfigured = Boolean(
      entry.apiKey || entry.token || entry.apiKeyConfigured || entry.tokenConfigured,
    );
    const credentialReady = entry.provider === "local-model" || credentialConfigured;
    const credentialHeaderReady = !credentialConfigured || Boolean(String(entry.tokenHeader || "").trim());
    return (
      modelLibraryProviderDefinitions.some((definition) => definition.id === entry.provider) &&
      hasIdentity &&
      hasModel &&
      hasEndpoint &&
      hasTimeout &&
      credentialReady &&
      credentialHeaderReady
    );
  }

  function modelEntryStatusKey(entry: AgentModelConfig) {
    return entry.uid || entry.instanceId || entry.alias;
  }

  function gatewayAssistantModelOptionLabel(entry: AgentModelConfig) {
    const modelName = String(
      entry.label || entry.agentName || entry.alias || modelEntryStatusKey(entry),
    ).trim();
    const modelId = String(entry.model || entry.engine || modelEntryStatusKey(entry)).trim();
    return modelId && modelId !== modelName ? `${modelName} · ${modelId}` : modelName;
  }

  function modelEntryUidSet(entry: AgentModelConfig) {
    return new Set(
      [
        entry.uid,
        entry.instanceId,
        entry.alias,
      ]
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    );
  }

  function modelEntryMatchesUid(entry: AgentModelConfig, value?: string) {
    const normalized = String(value || "").trim();
    return Boolean(normalized && modelEntryUidSet(entry).has(normalized));
  }

  function modelEntryMatchesAssignment(
    entry: AgentModelConfig,
    provider?: string,
    modelUid?: string,
  ) {
    const normalizedProvider = String(provider || "").trim();
    const normalizedModelUid = String(modelUid || "").trim();
    if (!normalizedProvider || !normalizedModelUid || normalizedProvider !== entry.provider) {
      return false;
    }
    return modelEntryUidSet(entry).has(normalizedModelUid);
  }

  const {
    addModuleAgentProfileFromDraft,
    agentModelAssignmentOptions,
    ensureModuleAgentGroup,
    ensureModuleAgentProfile,
    modelEntryAllowsModule,
    modelEntryModuleAccess,
    modelProviderFromRef,
    moduleAgentProfileRows,
    moduleModelAssignmentOptions,
    moduleModelAssignmentStats,
    moduleModelRef,
    moduleNeedsIntelligence,
    removeModuleAgentProfile,
    setModelEntryModuleAccessMode,
    setModuleAgentProfileEnabled,
    setModuleModelRef,
    setModuleNeedsIntelligence,
    toggleModelEntryModuleAccess,
  } = createConsoleModelModuleAssignmentController({
    gatewayAssistantModelOptionLabel,
    currentAgentModelOptionLabel: options.currentAgentModelOptionLabel,
    modelEntryConfigured,
    modelEntryStatusKey,
    modelRef,
    moduleAgentCandidateDrafts: options.moduleAgentCandidateDrafts,
    parseModelRef,
    settingsDraft: options.settingsDraft,
    visibleModelEntries,
  });

  const {
    addModelEntryBinding,
    collectModelEntryBindings,
    modelEntryBindingSummary,
    modelEntryBindings,
    modelEntryBindingsByKey,
    modelEntryIsBound,
  } = createConsoleModelEntryBindingController({
    gatewayAssistantModelAlias: options.gatewayAssistantModelAlias,
    modelEntryMatchesAssignment,
    modelEntryMatchesUid,
    modelEntryStatusKey,
    moduleNeedsIntelligence,
    ruleAuthoringModelAlias: options.ruleAuthoringModelAlias,
    settingsDraft: options.settingsDraft,
    visibleModelEntries,
  });

  function exportAgentModelEntryConfig(entry: AgentModelConfig) {
    const entryIndex = visibleModelEntries.value.findIndex(
      (item) => modelEntryStatusKey(item) === modelEntryStatusKey(entry),
    );
    const normalizedEntry = {
      ...options.normalizeModelEntry(entry, entryIndex >= 0 ? entryIndex : 0),
      parameters: modelEntryParameters(entry),
    };
    const timestamp = formatMachineDate(new Date().toISOString(), "full").replace(/[: ]/g, "-");
    const exportPayload = {
      schemaVersion: "v0.0.1:schema:definition-1",
      exportedAt: new Date().toISOString(),
      type: "v0.0.1:agent:model-config-1",
      source: "server-console-model-library",
      note: "导出的是当前大模型配置；密钥和 Token 字段已脱敏，未包含其它大模型配置。",
      model: redactAgentModelEntryForExport(normalizedEntry),
      providerSettings: redactedProviderSettingsForAgentExport(normalizedEntry),
    };
    downloadTextFile(
      `lico-agent-${safeDownloadName(normalizedEntry.label || modelEntryStatusKey(normalizedEntry), "model")}-${timestamp}.json`,
      `${JSON.stringify(exportPayload, null, 2)}\n`,
      "application/json;charset=utf-8",
    );
    options.error.value = "";
  }

  const {
    modelEntryProbeResult,
    modelEntryProbeStatusLabel,
    modelEntryProbeStatusTone,
    modelEntryStatusLabel,
    modelEntryStatusTone,
    modelProbeFailureResult,
    modelProbeSettingsForEntry,
    probeModelEntry,
    probeModelLibraryBeforeSave,
    runModelEntryProbe,
  } = createConsoleModelProbeController({
    clearAllBusy: options.clearAllBusy,
    error: options.error,
    modelEntryConfigured,
    modelEntryStatusKey,
    modelProbeResults: options.modelProbeResults,
    setBusy: options.setBusy,
    settingsPayloadForSave: options.settingsPayloadForSave,
    visibleModelEntries,
  });

  const {
    addModelProvider,
    duplicateModelEntry,
    isModelLibraryCardExpanded,
    removeModelProvider,
    toggleModelLibraryCard,
  } = createConsoleModelRepositoryController({
    clearAllBusy: options.clearAllBusy,
    error: options.error,
    modelEntryBindingSummary,
    modelEntryIsBound,
    modelEntryStatusKey,
    modelLibraryExpandedCards: options.modelLibraryExpandedCards,
    normalizeModelEntry: options.normalizeModelEntry,
    providerLabel,
    replaceSettingsDraftFromServer: options.replaceSettingsDraftFromServer,
    selectedModelProvider: options.selectedModelProvider,
    setBusy: options.setBusy,
    settingsDraft: options.settingsDraft,
    settingsPayloadForSave: options.settingsPayloadForSave,
    visibleModelEntries,
    visibleModelProviders,
  });

  return {
    addModelEntryBinding,
    addModelProvider,
    addModuleAgentProfileFromDraft,
    addableModelProviders,
    gatewayAssistantModelOptionLabel,
    agentModelAssignmentOptions,
    collectModelEntryBindings,
    duplicateModelEntry,
    ensureModuleAgentGroup,
    ensureModuleAgentProfile,
    exportAgentModelEntryConfig,
    isModelLibraryCardExpanded,
    modelEntryBindingSummary,
    modelEntryBindings,
    modelEntryBindingsByKey,
    modelEntryAllowsModule,
    modelEntryConfigured,
    modelEntryIsBound,
    modelEntryMatchesAssignment,
    modelEntryMatchesUid,
    modelEntryModuleAccess,
    modelEntryProbeResult,
    modelEntryProbeStatusLabel,
    modelEntryProbeStatusTone,
    modelEntryStatusKey,
    modelEntryStatusLabel,
    modelEntryStatusTone,
    modelEntryUidSet,
    modelProbeFailureResult,
    modelProbeSettingsForEntry,
    modelProviderDefinition,
    modelProviderFromRef,
    modelRef,
    moduleAgentProfileRows,
    moduleModelAssignmentOptions,
    moduleModelAssignmentStats,
    moduleModelRef,
    moduleNeedsIntelligence,
    parseModelRef,
    probeModelEntry,
    probeModelLibraryBeforeSave,
    providerLabel,
    removeModelProvider,
    removeModuleAgentProfile,
    runModelEntryProbe,
    setModelEntryModuleAccessMode,
    setModuleAgentProfileEnabled,
    setModuleModelRef,
    setModuleNeedsIntelligence,
    toggleModelEntryModuleAccess,
    toggleModelLibraryCard,
    visibleModelEntries,
    visibleModelProviders,
  };
}
