import { inject, provide, type InjectionKey } from "vue";
import type { ServerConsoleShellContext } from "./useServerConsoleShell";

export type AgentModelEntryCardContext = Pick<
  ServerConsoleShellContext,
  | "isBusy"
  | "duplicateModelEntry"
  | "exportAgentModelEntryConfig"
  | "intelligentModuleDefinitions"
  | "isModelLibraryCardExpanded"
  | "modelEntryBindingSummary"
  | "modelEntryBindings"
  | "modelEntryIsBound"
  | "modelEntryModuleAccess"
  | "modelEntryProbeResult"
  | "modelEntryProbeStatusLabel"
  | "modelEntryProbeStatusTone"
  | "modelEntryStatusKey"
  | "modelProbeResults"
  | "modelProviderDefinition"
  | "moduleAccessModeOptionBarOptions"
  | "probeModelEntry"
  | "providerLabel"
  | "removeModelProvider"
  | "setModelEntryModuleAccessMode"
  | "settingsDraft"
  | "toggleModelEntryModuleAccess"
  | "toggleModelLibraryCard"
>;

const agentModelEntryCardKey: any = Symbol("agent-model-entry-card") as InjectionKey<AgentModelEntryCardContext>;

export function createAgentModelEntryCardContext(
  shell: ServerConsoleShellContext,
): AgentModelEntryCardContext {
  return {
    isBusy: shell.isBusy,
    duplicateModelEntry: shell.duplicateModelEntry,
    exportAgentModelEntryConfig: shell.exportAgentModelEntryConfig,
    intelligentModuleDefinitions: shell.intelligentModuleDefinitions,
    isModelLibraryCardExpanded: shell.isModelLibraryCardExpanded,
    modelEntryBindingSummary: shell.modelEntryBindingSummary,
    modelEntryBindings: shell.modelEntryBindings,
    modelEntryIsBound: shell.modelEntryIsBound,
    modelEntryModuleAccess: shell.modelEntryModuleAccess,
    modelEntryProbeResult: shell.modelEntryProbeResult,
    modelEntryProbeStatusLabel: shell.modelEntryProbeStatusLabel,
    modelEntryProbeStatusTone: shell.modelEntryProbeStatusTone,
    modelEntryStatusKey: shell.modelEntryStatusKey,
    modelProbeResults: shell.modelProbeResults,
    modelProviderDefinition: shell.modelProviderDefinition,
    moduleAccessModeOptionBarOptions: shell.moduleAccessModeOptionBarOptions,
    probeModelEntry: shell.probeModelEntry,
    providerLabel: shell.providerLabel,
    removeModelProvider: shell.removeModelProvider,
    setModelEntryModuleAccessMode: shell.setModelEntryModuleAccessMode,
    settingsDraft: shell.settingsDraft,
    toggleModelEntryModuleAccess: shell.toggleModelEntryModuleAccess,
    toggleModelLibraryCard: shell.toggleModelLibraryCard,
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
