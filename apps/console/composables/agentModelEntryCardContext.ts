import { inject, provide, type InjectionKey } from "vue";
import type { ServerConsoleShellContext } from "./useServerConsoleShell";

export interface AgentModelEntryCardContext {
  readonly isBusy: any;
  readonly duplicateModelEntry: any;
  readonly exportAgentModelEntryConfig: any;
  readonly intelligentModuleDefinitions: any;
  readonly isModelLibraryCardExpanded: any;
  readonly modelEntryBindingSummary: any;
  readonly modelEntryBindings: any;
  readonly modelEntryIsBound: any;
  readonly modelEntryModuleAccess: any;
  readonly modelEntryProbeResult: any;
  readonly modelEntryProbeStatusLabel: any;
  readonly modelEntryProbeStatusTone: any;
  readonly modelEntryStatusKey: any;
  readonly modelProbeResults: any;
  readonly modelProviderDefinition: any;
  readonly moduleAccessModeOptionBarOptions: any;
  readonly probeModelEntry: any;
  readonly providerLabel: any;
  readonly removeModelProvider: any;
  readonly setModelEntryModuleAccessMode: any;
  readonly settingsDraft: any;
  readonly toggleModelEntryModuleAccess: any;
  readonly toggleModelLibraryCard: any;
}

const agentModelEntryCardKey: any = Symbol("agent-model-entry-card") as InjectionKey<AgentModelEntryCardContext>;

export function createAgentModelEntryCardContext(
  shell: ServerConsoleShellContext,
): AgentModelEntryCardContext {
  return {
    isBusy: shell.runtime.isBusy,
    duplicateModelEntry: shell.models.duplicateModelEntry,
    exportAgentModelEntryConfig: shell.models.exportAgentModelEntryConfig,
    intelligentModuleDefinitions: shell.modules.intelligentModuleDefinitions,
    isModelLibraryCardExpanded: shell.models.isModelLibraryCardExpanded,
    modelEntryBindingSummary: shell.models.modelEntryBindingSummary,
    modelEntryBindings: shell.models.modelEntryBindings,
    modelEntryIsBound: shell.models.modelEntryIsBound,
    modelEntryModuleAccess: shell.models.modelEntryModuleAccess,
    modelEntryProbeResult: shell.models.modelEntryProbeResult,
    modelEntryProbeStatusLabel: shell.models.modelEntryProbeStatusLabel,
    modelEntryProbeStatusTone: shell.models.modelEntryProbeStatusTone,
    modelEntryStatusKey: shell.models.modelEntryStatusKey,
    modelProbeResults: shell.models.modelProbeResults,
    modelProviderDefinition: shell.models.modelProviderDefinition,
    moduleAccessModeOptionBarOptions: shell.modules.moduleAccessModeOptionBarOptions,
    probeModelEntry: shell.models.probeModelEntry,
    providerLabel: shell.models.providerLabel,
    removeModelProvider: shell.models.removeModelProvider,
    setModelEntryModuleAccessMode: shell.models.setModelEntryModuleAccessMode,
    settingsDraft: shell.settings.settingsDraft,
    toggleModelEntryModuleAccess: shell.models.toggleModelEntryModuleAccess,
    toggleModelLibraryCard: shell.models.toggleModelLibraryCard,
  };
}

export function provideAgentModelEntryCardContext(context: AgentModelEntryCardContext) : any {
  provide(agentModelEntryCardKey, context);
}

export function useAgentModelEntryCardContext() : any {
  const context: any = inject(agentModelEntryCardKey);
  if (!context) {
    throw new Error("Agent model entry card context is not available");
  }
  return context;
}
