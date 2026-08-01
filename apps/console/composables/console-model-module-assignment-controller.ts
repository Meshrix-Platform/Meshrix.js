import { computed, type Ref } from "vue";
import type {
  AgentModelConfig,
  AgentModuleAccess,
  AgentSettings,
  ModuleAgentProfile,
} from "../lib/types";
import type { CloudProvider } from "../types/app";
import { intelligentModuleDefinitions } from "./console-defaults";
import {
  normalizeAgentModuleAccess,
  normalizeModuleAgentProfile,
} from "./console-model-utils";

type ReadonlyRef<T> = {
  readonly value: T;
};

type ConsoleModelModuleAssignmentControllerOptions = {
  gatewayAssistantModelOptionLabel: (entry: AgentModelConfig) => string;
  currentAgentModelOptionLabel: (value?: string) => string;
  modelEntryConfigured: (entry: AgentModelConfig) => boolean;
  modelEntryStatusKey: (entry: AgentModelConfig) => string;
  modelRef: (provider: string, model: string) => string;
  moduleAgentCandidateDrafts: Ref<Record<string, string>>;
  parseModelRef: (refValue: string) => { provider: CloudProvider; model: string };
  settingsDraft: Ref<AgentSettings>;
  visibleModelEntries: ReadonlyRef<AgentModelConfig[]>;
};

export function createConsoleModelModuleAssignmentController(
  options: ConsoleModelModuleAssignmentControllerOptions,
) : any {
  const agentModelAssignmentOptions: any = computed(() : any =>
    options.visibleModelEntries.value
      .map((entry?: any) : any => ({
        provider: entry.provider as CloudProvider,
        value: options.modelEntryStatusKey(entry),
        label: options.gatewayAssistantModelOptionLabel(entry),
        ref: options.modelRef(entry.provider, options.modelEntryStatusKey(entry)),
        enabled: options.modelEntryConfigured(entry),
      })),
  );

  function modelEntryModuleAccess(entry: AgentModelConfig): AgentModuleAccess {
    return normalizeAgentModuleAccess(entry.moduleAccess);
  }

  function modelEntryAllowsModule(entry: AgentModelConfig, moduleId: string) : any {
    const access: any = modelEntryModuleAccess(entry);
    return access.mode !== "selected" || access.moduleIds.includes(moduleId);
  }

  function setModelEntryModuleAccessMode(entry: AgentModelConfig, mode: string) : any {
    entry.moduleAccess = {
      ...modelEntryModuleAccess(entry),
      mode: mode === "selected" ? "selected" : "all",
    };
  }

  function toggleModelEntryModuleAccess(entry: AgentModelConfig, moduleId: string, checked: boolean) : any {
    const access: any = modelEntryModuleAccess(entry);
    const next: any = new Set<any>(access.moduleIds);
    if (checked) {
      next.add(moduleId);
    } else {
      next.delete(moduleId);
    }
    entry.moduleAccess = {
      mode: "selected",
      moduleIds: [...next],
    };
  }

  function moduleModelAssignmentOptions(moduleId: string) : any {
    return agentModelAssignmentOptions.value.filter((option?: any) : any => {
      const entry: any = options.visibleModelEntries.value.find(
        (model?: any) : any => options.modelEntryStatusKey(model) === option.value,
      );
      return Boolean(entry && modelEntryAllowsModule(entry, moduleId));
    });
  }

  function modelProviderFromRef(refValue: string) : any {
    return options.parseModelRef(refValue).provider;
  }

  function moduleNeedsIntelligence(moduleId: string) : any {
    if (moduleModelRef(moduleId)) {
      return true;
    }
    return options.settingsDraft.value.moduleIntelligence?.[moduleId] === true;
  }

  function setModuleNeedsIntelligence(moduleId: string, enabled: boolean) : any {
    options.settingsDraft.value.moduleIntelligence = {
      ...(options.settingsDraft.value.moduleIntelligence || {}),
      [moduleId]: enabled,
    };
  }

  function ensureModuleAgentGroup(moduleId: string) : any {
    const groups: Record<string, any> = { ...(options.settingsDraft.value.moduleAgentProfiles || {}) };
    const group: any = groups[moduleId] || { primaryAgent: "", agents: {} };
    groups[moduleId] = {
      primaryAgent: String(group.primaryAgent || "").trim(),
      agents: { ...(group.agents || {}) },
    };
    options.settingsDraft.value.moduleAgentProfiles = groups;
    return groups[moduleId];
  }

  function ensureModuleAgentProfile(moduleId: string, agentId: string, defaults: Partial<ModuleAgentProfile> = {}) : any {
    const normalizedAgentId: any = String(agentId || "").trim();
    if (!normalizedAgentId) {
      return null;
    }
    const group: any = ensureModuleAgentGroup(moduleId);
    const existing: any = group.agents[normalizedAgentId];
    group.agents[normalizedAgentId] = normalizeModuleAgentProfile({
      ...(existing || {}),
      ...defaults,
      enabled: existing ? existing.enabled : true,
      role: defaults.role || (group.primaryAgent === normalizedAgentId ? "primary" : "assistant"),
    });
    return group.agents[normalizedAgentId];
  }

  function removeModuleAgentProfile(moduleId: string, agentId: string) : any {
    const group: any = ensureModuleAgentGroup(moduleId);
    delete group.agents[agentId];
    if (group.primaryAgent === agentId) {
      group.primaryAgent = "";
      const nextAssignments: Record<string, any> = { ...(options.settingsDraft.value.moduleModelAssignments || {}) };
      delete nextAssignments[moduleId];
      options.settingsDraft.value.moduleModelAssignments = nextAssignments;
    }
  }

  function moduleAgentProfileRows(moduleId: string) : any {
    const group: any = options.settingsDraft.value.moduleAgentProfiles?.[moduleId];
    const agents: any = group?.agents || {};
    return (Object.entries(agents) as [string, any][]).map(([agentId, profile]: any[]) : any => {
      const entry: any = options.visibleModelEntries.value.find(
        (model?: any) : any => options.modelEntryStatusKey(model) === agentId,
      );
      return {
        agentId,
        label: entry
          ? options.gatewayAssistantModelOptionLabel(entry)
          : options.currentAgentModelOptionLabel(agentId) || agentId,
        isPrimary: group?.primaryAgent === agentId,
        profile,
      };
    });
  }

  function moduleModelRef(moduleId: string) : any {
    const assignment: any = options.settingsDraft.value.moduleModelAssignments?.[moduleId];
    if (!assignment?.provider || !assignment?.model) {
      return "";
    }
    const refValue: any = options.modelRef(assignment.provider, assignment.model);
    return moduleModelAssignmentOptions(moduleId).some((option?: any) : any => option.ref === refValue)
      ? refValue
      : "";
  }

  function setModuleModelRef(moduleId: string, refValue: string) : any {
    if (!String(refValue || "").trim()) {
      const nextAssignments: Record<string, any> = { ...(options.settingsDraft.value.moduleModelAssignments || {}) };
      delete nextAssignments[moduleId];
      options.settingsDraft.value.moduleModelAssignments = nextAssignments;
      const group: any = ensureModuleAgentGroup(moduleId);
      group.primaryAgent = "";
      const moduleDefinition: any = intelligentModuleDefinitions.find((item?: any) : any => item.id === moduleId);
      if (moduleDefinition?.alertRequired === false) {
        setModuleNeedsIntelligence(moduleId, false);
      }
      return;
    }
    const parsed: any = options.parseModelRef(refValue);
    options.settingsDraft.value.moduleModelAssignments = {
      ...(options.settingsDraft.value.moduleModelAssignments || {}),
      [moduleId]: {
        provider: parsed.provider,
        model: parsed.model,
      },
    };
    const group: any = ensureModuleAgentGroup(moduleId);
    group.primaryAgent = parsed.model;
    ensureModuleAgentProfile(moduleId, parsed.model, { role: "primary" });
    setModuleNeedsIntelligence(moduleId, true);
  }

  function setModuleAgentProfileEnabled(moduleId: string, agentId: string, enabled: boolean) : any {
    const profile: any = ensureModuleAgentProfile(moduleId, agentId);
    if (profile) {
      profile.enabled = enabled;
    }
  }

  function addModuleAgentProfileFromDraft(moduleId: string) : any {
    const refValue: any = String(options.moduleAgentCandidateDrafts.value[moduleId] || "").trim();
    if (!refValue) {
      return;
    }
    const parsed: any = options.parseModelRef(refValue);
    ensureModuleAgentProfile(moduleId, parsed.model, { role: "assistant" });
    options.moduleAgentCandidateDrafts.value = {
      ...options.moduleAgentCandidateDrafts.value,
      [moduleId]: "",
    };
  }

  const moduleModelAssignmentStats: any = computed(() : any => {
    const enabled: any = intelligentModuleDefinitions.filter((item?: any) : any => moduleNeedsIntelligence(item.id)).length;
    const assigned: any = intelligentModuleDefinitions.filter(
      (item?: any) : any => moduleNeedsIntelligence(item.id) && moduleModelRef(item.id),
    ).length;
    return {
      assigned,
      enabled,
      total: intelligentModuleDefinitions.length,
    };
  });

  return {
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
  };
}
