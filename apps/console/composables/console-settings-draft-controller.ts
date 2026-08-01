import { watch, type Ref } from "vue";
import type {
  AgentModelConfig,
  AgentSettings,
  ModuleAgentProfile,
} from "../lib/types";
import type { CloudProvider } from "../types/app";
import { emptySettings } from "./console-defaults";
import {
  normalizeAgentLocalCommandsForDraft,
  normalizeModelLibraryEntries,
  normalizeModuleAgentProfile,
  normalizeModuleAgentProfilesForDraft,
} from "./console-model-utils";

type ModuleModelAssignmentOption = {
  ref: string;
};

type ConsoleSettingsDraftControllerOptions = {
  modelEntryParameters: (entry: AgentModelConfig) => Record<string, unknown>;
  modelRef: (provider: string, model: string) => string;
  moduleModelAssignmentOptions: (moduleId: string) => ModuleModelAssignmentOption[];
  moduleNeedsIntelligence: (moduleId: string) => boolean;
  normalizeModelEntry: (
    entry: Partial<AgentModelConfig>,
    index?: number,
    settings?: AgentSettings,
  ) => AgentModelConfig;
  settingsDraft: Ref<AgentSettings>;
  settingsDraftDirty: Ref<boolean>;
  visibleModelEntries: () => AgentModelConfig[];
};

export function remoteDraftEquals(left: unknown, right: unknown) : any {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createConsoleSettingsDraftController(
  options: ConsoleSettingsDraftControllerOptions,
) : any {
  let applyingRemoteSettings: any = false;

  watch(
    options.settingsDraft,
    () : any => {
      if (!applyingRemoteSettings) {
        options.settingsDraftDirty.value = true;
      }
    },
    { deep: true, flush: "sync" },
  );

  function normalizeModelLibraryAgents(settings: AgentSettings): AgentModelConfig[] {
    const models: any = Array.isArray(settings.modelLibraryAgents)
      ? settings.modelLibraryAgents
      : [];
    return models.map((item?: any, index?: any) : any =>
      options.normalizeModelEntry(item, index, settings),
    );
  }

  function moduleAgentProfilesPayload() : any {
    const next: AgentSettings["moduleAgentProfiles"] = {};
    for (const [moduleId, group] of (Object.entries(options.settingsDraft.value.moduleAgentProfiles || {}) as [string, any][])) {
      const agents: Record<string, ModuleAgentProfile> = {};
      for (const [agentId, profile] of (Object.entries(group.agents || {}) as [string, any][])) {
        const normalizedAgentId: any = String(agentId || "").trim();
        if (!normalizedAgentId) {
          continue;
        }
        const normalizedProfile: any = normalizeModuleAgentProfile(profile);
        agents[normalizedAgentId] = {
          enabled: normalizedProfile.enabled,
          role: normalizedProfile.role,
          contextProfileId: normalizedProfile.contextProfileId,
          systemPrompt: normalizedProfile.systemPrompt,
          parameters: normalizedProfile.parameters,
          dependencyContext: normalizedProfile.dependencyContext,
        };
      }
      if (Object.keys(agents).length > 0 || group.primaryAgent) {
        next[moduleId] = {
          primaryAgent: String(group.primaryAgent || "").trim(),
          agents,
        };
      }
    }
    return next;
  }

  function normalizeSettingsDraft(settings: AgentSettings): AgentSettings {
    return {
      ...settings,
      modelLibraryEntries: normalizeModelLibraryEntries(settings.modelLibraryEntries),
      modelLibraryAgents: normalizeModelLibraryAgents(settings),
      gatewayAssistantDefaults: {
        ...emptySettings.gatewayAssistantDefaults,
        ...(settings.gatewayAssistantDefaults || {}),
      },
      agentToolExecution: {
        functionCallSchema:
          settings.agentToolExecution?.functionCallSchema ||
          emptySettings.agentToolExecution.functionCallSchema,
        http: {
          ...emptySettings.agentToolExecution.http,
          ...(settings.agentToolExecution?.http || {}),
        },
        local: {
          ...emptySettings.agentToolExecution.local,
          ...(settings.agentToolExecution?.local || {}),
          commands: normalizeAgentLocalCommandsForDraft(settings),
        },
      },
      moduleAgentProfiles: normalizeModuleAgentProfilesForDraft(settings),
    };
  }

  function settingsPayloadForSave() : any {
    const normalized: any = normalizeSettingsDraft(options.settingsDraft.value);
    normalized.modelLibraryAgents = options.visibleModelEntries().map((entry?: any, index?: any) : any => ({
      ...options.normalizeModelEntry(entry, index, options.settingsDraft.value),
      parameters: options.modelEntryParameters(entry),
    }));
    normalized.modelLibraryEntries = [
      ...new Set<any>(normalized.modelLibraryAgents.map((entry?: any) : any => String(entry.provider || "").trim()).filter(Boolean)),
    ] as CloudProvider[];
    normalized.moduleModelAssignments = Object.fromEntries(
      (Object.entries(normalized.moduleModelAssignments || {}) as [string, any][]).filter(([moduleId, assignment]: any[]) : any => {
        if (!options.moduleNeedsIntelligence(moduleId)) {
          return false;
        }
        return options.moduleModelAssignmentOptions(moduleId).some(
          (option?: any) : any => option.ref === options.modelRef(assignment.provider, assignment.model),
        );
      }),
    );
    normalized.moduleAgentProfiles = moduleAgentProfilesPayload();
    return normalized;
  }

  function normalizeRemoteSettings(settings: AgentSettings) : any {
    return normalizeSettingsDraft({
      ...emptySettings,
      ...settings,
    });
  }

  function normalizedSettingsFromServer(settings: AgentSettings) : any {
    return normalizeRemoteSettings(settings);
  }

  function settingsDraftEquals(left: AgentSettings, right: AgentSettings) : any {
    return remoteDraftEquals(left, right);
  }

  function replaceSettingsDraftFromServer(
    settings: AgentSettings,
    replaceOptions: { markClean?: boolean } = {},
  ) : any {
    const normalized: any = normalizedSettingsFromServer(settings);
    if (settingsDraftEquals(options.settingsDraft.value, normalized)) {
      if (replaceOptions.markClean !== false) {
        options.settingsDraftDirty.value = false;
      }
      return;
    }
    applyingRemoteSettings = true;
    options.settingsDraft.value = normalized;
    if (replaceOptions.markClean !== false) {
      options.settingsDraftDirty.value = false;
    }
    queueMicrotask(() : any => {
      applyingRemoteSettings = false;
    });
  }

  function isApplyingRemoteSettings() : any {
    return applyingRemoteSettings;
  }

  return {
    isApplyingRemoteSettings,
    moduleAgentProfilesPayload,
    normalizeModelLibraryAgents,
    normalizeRemoteSettings,
    normalizedSettingsFromServer,
    remoteDraftEquals,
    replaceSettingsDraftFromServer,
    settingsDraftEquals,
    settingsPayloadForSave,
  };
}
