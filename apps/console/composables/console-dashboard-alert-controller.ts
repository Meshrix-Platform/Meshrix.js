import { type ComputedRef, type Ref } from "vue";
import {
  createConsoleDashboardConfigurationAlertController,
  type DashboardAgentOption,
} from "./console-dashboard-configuration-alert-controller";
import {
  createConsoleDashboardAlertInboxController,
  type BackgroundProcessItem,
  type MonitorAlertItem,
} from "./console-dashboard-alert-inbox-controller";
import type {
  AgentModelConfig,
  AgentSettings,
} from "../lib/types";
import type {
  AdminView,
  AgentConfigurationAlert,
} from "../types/app";

type DashboardAlertControllerOptions = {
  acknowledgeMonitorAlert: (alertId: string) => Promise<void>;
  activeMonitorAlerts: ComputedRef<MonitorAlertItem[]>;
  gatewayAssistantAgentOptions: ComputedRef<DashboardAgentOption[]>;
  gatewayAssistantForm: Ref<{ modelAlias?: string }>;
  agentModelAssignmentOptions: ComputedRef<DashboardAgentOption[]>;
  agentSelectorOptions: ComputedRef<DashboardAgentOption[]>;
  backgroundProcesses: ComputedRef<BackgroundProcessItem[]>;
  error: Ref<string>;
  moduleModelRef: (moduleId: string) => string;
  moduleNeedsIntelligence: (moduleId: string) => boolean;
  openAdmin: (tab: AdminView) => void;
  openAgentConfigurationAlert: (alertItem: AgentConfigurationAlert) => Promise<void>;
  refreshMonitorAlerts: (options?: { silent?: boolean }) => Promise<void>;
  recoverBackgroundSupervisor: () => Promise<void>;
  ruleAuthoringForm: Ref<{ modelAlias?: string }>;
  ruleAuthoringModelOptions: ComputedRef<DashboardAgentOption[]>;
  settingsDraft: Ref<AgentSettings>;
  visibleModelEntries: ComputedRef<AgentModelConfig[]>;
};

export function createConsoleDashboardAlertController(options: DashboardAlertControllerOptions) : any {
  const configurationAlerts: any = createConsoleDashboardConfigurationAlertController({
    gatewayAssistantAgentOptions: options.gatewayAssistantAgentOptions,
    gatewayAssistantForm: options.gatewayAssistantForm,
    agentModelAssignmentOptions: options.agentModelAssignmentOptions,
    agentSelectorOptions: options.agentSelectorOptions,
    moduleModelRef: options.moduleModelRef,
    moduleNeedsIntelligence: options.moduleNeedsIntelligence,
    ruleAuthoringForm: options.ruleAuthoringForm,
    ruleAuthoringModelOptions: options.ruleAuthoringModelOptions,
    settingsDraft: options.settingsDraft,
    visibleModelEntries: options.visibleModelEntries,
  });

  const alertInbox: any = createConsoleDashboardAlertInboxController({
    acknowledgeMonitorAlert: options.acknowledgeMonitorAlert,
    activeMonitorAlerts: options.activeMonitorAlerts,
    agentConfigurationAlerts: configurationAlerts.agentConfigurationAlerts,
    backgroundProcesses: options.backgroundProcesses,
    error: options.error,
    openAdmin: options.openAdmin,
    openAgentConfigurationAlert: options.openAgentConfigurationAlert,
    refreshMonitorAlerts: options.refreshMonitorAlerts,
    recoverBackgroundSupervisor: options.recoverBackgroundSupervisor,
  });

  return {
    ...configurationAlerts,
    ...alertInbox,
  };
}
