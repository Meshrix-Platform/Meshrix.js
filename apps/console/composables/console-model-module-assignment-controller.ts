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
) {
  const agentModelAssignmentOptions = computed(() =>
    options.visibleModelEntries.value
      .map((entry) => ({
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

  function modelEntryAllowsModule(entry: AgentModelConfig, moduleId: string) {
    const access = modelEntryModuleAccess(entry);
    return access.mode !== "selected" || access.moduleIds.includes(moduleId);
  }

  function setModelEntryModuleAccessMode(entry: AgentModelConfig, mode: string) {
    entry.moduleAccess = {
      ...modelEntryModuleAccess(entry),
      mode: mode === "selected" ? "selected" : "all",
    };
  }

  function toggleModelEntryModuleAccess(entry: AgentModelConfig, moduleId: string, checked: boolean) {
    const access = modelEntryModuleAccess(entry);
    const next = new Set(access.moduleIds);
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

  function moduleModelAssignmentOptions(moduleId: string) {
    return agentModelAssignmentOptions.value.filter((option) => {
      const entry = options.visibleModelEntries.value.find(
        (model) => options.modelEntryStatusKey(model) === option.value,
      );
      return Boolean(entry && modelEntryAllowsModule(entry, moduleId));
    });
  }

  function modelProviderFromRef(refValue: string) {
    return options.parseModelRef(refValue).provider;
  }

  function moduleNeedsIntelligence(moduleId: string) {
    if (moduleModelRef(moduleId)) {
      return true;
    }
    return options.settingsDraft.value.moduleIntelligence?.[moduleId] === true;
  }

  function setModuleNeedsIntelligence(moduleId: string, enabled: boolean) {
    options.settingsDraft.value.moduleIntelligence = {
      ...(options.settingsDraft.value.moduleIntelligence || {}),
      [moduleId]: enabled,
    };
  }

  function ensureModuleAgentGroup(moduleId: string) {
    const groups = { ...(options.settingsDraft.value.moduleAgentProfiles || {}) };
    const group = groups[moduleId] || { primaryAgent: "", agents: {} };
    groups[moduleId] = {
      primaryAgent: String(group.primaryAgent || "").trim(),
      agents: { ...(group.agents || {}) },
    };
    options.settingsDraft.value.moduleAgentProfiles = groups;
    return groups[moduleId];
  }

  function ensureModuleAgentProfile(moduleId: string, agentId: string, defaults: Partial<ModuleAgentProfile> = {}) {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      return null;
    }
    const group = ensureModuleAgentGroup(moduleId);
    const existing = group.agents[normalizedAgentId];
    group.agents[normalizedAgentId] = normalizeModuleAgentProfile({
      ...(existing || {}),
      ...defaults,
      enabled: existing ? existing.enabled : true,
      role: defaults.role || (group.primaryAgent === normalizedAgentId ? "primary" : "assistant"),
    });
    return group.agents[normalizedAgentId];
  }

  function removeModuleAgentProfile(moduleId: string, agentId: string) {
    const group = ensureModuleAgentGroup(moduleId);
    delete group.agents[agentId];
    if (group.primaryAgent === agentId) {
      group.primaryAgent = "";
      const nextAssignments = { ...(options.settingsDraft.value.moduleModelAssignments || {}) };
      delete nextAssignments[moduleId];
      options.settingsDraft.value.moduleModelAssignments = nextAssignments;
    }
  }

  function moduleAgentProfileRows(moduleId: string) {
    const group = options.settingsDraft.value.moduleAgentProfiles?.[moduleId];
    const agents = group?.agents || {};
    return Object.entries(agents).map(([agentId, profile]) => {
      const entry = options.visibleModelEntries.value.find(
        (model) => options.modelEntryStatusKey(model) === agentId,
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

  function moduleModelRef(moduleId: string) {
    const assignment = options.settingsDraft.value.moduleModelAssignments?.[moduleId];
    if (!assignment?.provider || !assignment?.model) {
      return "";
    }
    const refValue = options.modelRef(assignment.provider, assignment.model);
    return moduleModelAssignmentOptions(moduleId).some((option) => option.ref === refValue)
      ? refValue
      : "";
  }

  function setModuleModelRef(moduleId: string, refValue: string) {
    if (!String(refValue || "").trim()) {
      const nextAssignments = { ...(options.settingsDraft.value.moduleModelAssignments || {}) };
      delete nextAssignments[moduleId];
      options.settingsDraft.value.moduleModelAssignments = nextAssignments;
      const group = ensureModuleAgentGroup(moduleId);
      group.primaryAgent = "";
      const moduleDefinition = intelligentModuleDefinitions.find((item) => item.id === moduleId);
      if (moduleDefinition?.alertRequired === false) {
        setModuleNeedsIntelligence(moduleId, false);
      }
      return;
    }
    const parsed = options.parseModelRef(refValue);
    options.settingsDraft.value.moduleModelAssignments = {
      ...(options.settingsDraft.value.moduleModelAssignments || {}),
      [moduleId]: {
        provider: parsed.provider,
        model: parsed.model,
      },
    };
    const group = ensureModuleAgentGroup(moduleId);
    group.primaryAgent = parsed.model;
    ensureModuleAgentProfile(moduleId, parsed.model, { role: "primary" });
    setModuleNeedsIntelligence(moduleId, true);
  }

  function setModuleAgentProfileEnabled(moduleId: string, agentId: string, enabled: boolean) {
    const profile = ensureModuleAgentProfile(moduleId, agentId);
    if (profile) {
      profile.enabled = enabled;
    }
  }

  function addModuleAgentProfileFromDraft(moduleId: string) {
    const refValue = String(options.moduleAgentCandidateDrafts.value[moduleId] || "").trim();
    if (!refValue) {
      return;
    }
    const parsed = options.parseModelRef(refValue);
    ensureModuleAgentProfile(moduleId, parsed.model, { role: "assistant" });
    options.moduleAgentCandidateDrafts.value = {
      ...options.moduleAgentCandidateDrafts.value,
      [moduleId]: "",
    };
  }

  const moduleModelAssignmentStats = computed(() => {
    const enabled = intelligentModuleDefinitions.filter((item) => moduleNeedsIntelligence(item.id)).length;
    const assigned = intelligentModuleDefinitions.filter(
      (item) => moduleNeedsIntelligence(item.id) && moduleModelRef(item.id),
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
