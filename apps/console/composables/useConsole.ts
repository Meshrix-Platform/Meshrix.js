import {
  computed,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import type {
  AgentModelConfig,
  AgentSettings,
  ModelProbeResponse,
  ServerConsoleState,
} from "../lib/types";
import type {
  AdminView,
  AgentConfigurationAlert,
  CloudProvider,
  RefreshStateOptions,
} from "../types/app";
import {
  adminSectionToSlug,
  viewToPath,
} from "../router";
import {
  isAdminPluginConsoleEntry,
  syncPluginConsoleRoutes,
  type PluginConsoleEntry,
} from "../router/plugin-console-routes";
import { configureRuntimeRouteGuard } from "../router/runtime-route-guard";
import {
  firstAccessibleRoutePath as policyFirstAccessibleRoutePath,
  routeAccessPolicyForAdminView,
  routeAccessPolicyAllowsSubject,
  routeAccessPolicyForView,
} from "../router/route-access-policy.mjs";
import { clearBrowserLocalStateFromUrl } from "./console-browser-state-utils";
import {
  confirmConsoleAction,
  createConsoleTargetHighlightController,
} from "./console-browser-effects";
import {
  emptySettings,
  intelligentModuleDefinitions,
  modelLibraryProviderDefinitions,
} from "./console-defaults";
import { createConsoleAgentSelectionReferenceController } from "./console-agent-selection-reference-controller";
import { createConsoleAgentSelectorController } from "./console-agent-selector-controller";
import { createConsoleAuthController } from "./console-auth-controller";
import { createConsoleBusyController } from "./console-busy-controller";
import { createConsoleClientController } from "./console-client-controller";
import { createConsoleContextCompilerController } from "./console-context-compiler-controller";
import { createConsoleDashboardAlertController } from "./console-dashboard-alert-controller";
import { createConsoleDiscoveryController } from "./console-discovery-controller";
import { CONSOLE_EVENT_TOPICS, createConsoleEventRouter } from "./console-event-router";
import { createConsoleJobController } from "./console-job-controller";
import { createConsoleMaintenanceAgentController } from "./console-maintenance-agent-controller";
import { createConsoleMcpAuthorizationController } from "./console-mcp-authorization-controller";
import { createConsoleModelLibraryController } from "./console-model-library-controller";
import {
  modelEntryParameters,
  normalizeAgentModelEntry,
} from "./console-model-utils";
import { createConsoleOperationPermissionController } from "./console-operation-permission-controller";
import { createConsoleOperationPermissionPendingController } from "./console-operation-permission-pending-controller";
import { createConsoleOpsMonitorController } from "./console-ops-monitor-controller";
import { createConsoleOptionBarController } from "./console-option-bar-controller";
import { createConsolePathPickerController } from "./console-path-picker-controller";
import { createConsoleRefreshStateController } from "./console-refresh-state-controller";
import { createConsoleRuntimeLifecycleController } from "./console-runtime-lifecycle-controller";
import { createConsoleRuntimeMountController } from "./console-runtime-mount-controller";
import { createConsoleServerEventController } from "./console-server-event-controller";
import { createConsoleSettingsBridgeController } from "./console-settings-bridge-controller";
import { createConsoleSettingsDraftController } from "./console-settings-draft-controller";
import { createConsoleSettingsPersistenceController } from "./console-settings-persistence-controller";
import { createConsoleSystemLogController } from "./console-system-log-controller";
import { createConsoleSystemLogRowController } from "./console-system-log-row-controller";

export type DebugTab = string;

export interface ConsoleController {
  activeConsoleFeatureIds: ComputedRef<string[]>;
  adminView: Ref<string>;
  busyKey: ComputedRef<string>;
  canAccessAdminView: (adminView?: string) => boolean;
  canAccessRouteMeta: (meta?: unknown) => boolean;
  canAccessView: (view?: string) => boolean;
  clearAllBusy: () => void;
  clearBusy: (key: string) => void;
  closeDrawer: () => void;
  consoleState: Ref<ServerConsoleState | null>;
  currentView: ComputedRef<string>;
  debugTab: Ref<DebugTab>;
  drawerOpen: Ref<boolean>;
  drawerTab: Ref<string>;
  error: Ref<string>;
  firstAccessibleRoutePath: () => string;
  hasAnyFeature: (...featureIds: string[]) => boolean;
  hasFeature: (featureId?: string) => boolean;
  isAuthenticated: ComputedRef<boolean>;
  isBusy: (key: string) => boolean;
  isBusyPrefix: (prefix: string) => boolean;
  openAdmin: (view?: string) => Promise<boolean>;
  openDrawer: (tab?: string) => void;
  refreshState: (options?: RefreshStateOptions) => Promise<void>;
  serverAvailable: Ref<boolean>;
  setBusy: (key: string) => void;
  sideNavCollapsed: Ref<boolean>;
  sideNavOpen: Ref<boolean>;
  switchView: (view?: string) => Promise<boolean>;
}

function cloneSettings(value: AgentSettings) {
  return JSON.parse(JSON.stringify(value)) as AgentSettings;
}

export function useConsole() {
  const route = useRoute();
  const router = useRouter();

  const consoleState = ref<ServerConsoleState | null>(null);
  const serverAvailable = ref(false);
  const error = ref("");
  const drawerOpen = ref(false);
  const drawerTab = ref("overview");
  const adminView = ref<AdminView>("storage");
  const debugTab = ref<DebugTab>("");
  const sideNavCollapsed = ref(false);
  const sideNavOpen = ref(false);
  const highlightedConfigTarget = ref("");
  const editingMountPaths = ref<Record<string, boolean>>({});
  const settingsDraft = ref<AgentSettings>(cloneSettings(emptySettings));
  const settingsDraftDirty = ref(false);
  const gatewayAssistantForm = ref({ modelAlias: "" });
  const ruleAuthoringForm = ref({ modelAlias: "" });
  const selectedModelProvider = ref<CloudProvider>(modelLibraryProviderDefinitions[0]?.id || "");
  const modelLibraryExpandedCards = ref<Record<string, boolean>>({});
  const modelProbeResults = ref<Record<string, ModelProbeResponse>>({});
  const moduleAgentCandidateDrafts = ref<Record<string, string>>({});
  const agentModelOptionLabelCache = ref<Record<string, string>>({});

  const currentView = computed(() => String(route.meta?.viewId || "dashboard"));
  const activeConsoleFeatureIds = computed(() =>
    consoleState.value?.features?.activeFeatureIds || [],
  );
  const busyController = createConsoleBusyController();
  const settingsBridge = createConsoleSettingsBridgeController();

  function syncAgentSelectionForms(settings: AgentSettings) {
    gatewayAssistantForm.value.modelAlias = String(
      settings.gatewayAssistantDefaults?.gatewayReviewModelAlias || "",
    );
    ruleAuthoringForm.value.modelAlias = String(
      settings.gatewayAssistantDefaults?.ruleAuthoringModelAlias || "",
    );
  }

  function applyConsoleState(
    nextState: ServerConsoleState,
    applyOptions: { forceSettings?: boolean; forceDrafts?: boolean } = {},
  ) {
    syncPluginConsoleRoutes(
      router,
      (nextState.features?.plugins?.consoleEntries || []) as PluginConsoleEntry[],
    );
    consoleState.value = nextState;
    const replaceSettings =
      applyOptions.forceSettings === true ||
      applyOptions.forceDrafts === true ||
      !settingsDraftDirty.value;
    if (replaceSettings) {
      settingsBridge.replaceSettingsDraftFromServer(nextState.settings.value);
      syncAgentSelectionForms(settingsDraft.value);
    }
    if (applyOptions.forceDrafts === true || !runtimeMountController.mountDraftDirty.value) {
      runtimeMountController.replaceMountDraftFromServer(nextState.runtime.mountModules);
    }
    if (applyOptions.forceDrafts === true || !discoveryController.discoveryDraftDirty.value) {
      discoveryController.replaceDiscoveryDraftFromServer(nextState.discovery.value);
    }
    maintenanceAgentController.applyMaintenanceAgentStateFromConsoleState(nextState);
    agentSelectorController.cacheAgentModelOptionLabels(
      agentSelectorController.agentSelectorOptions.value,
    );
    dashboardAlertController.syncDashboardAlertInbox(
      dashboardAlertController.liveDashboardAlerts.value,
    );
  }

  function currentTopics() {
    return CONSOLE_EVENT_TOPICS.join(",");
  }

  const applyServerEvent = createConsoleEventRouter({
    applyConsoleState,
    applyMaintenanceConfig: (config) => maintenanceAgentController.applyMaintenanceAgentConfigFromEvent(config),
    getConsoleState: () => consoleState.value,
    refreshMaintenanceSilently: () => void maintenanceAgentController.refreshMaintenanceAgent({ silent: true }),
    removeJob: (jobId) => jobController.removeJobFromEvent(jobId),
    upsertJob: (job) => jobController.upsertJobFromEvent(job),
  });

  const refreshStateController = createConsoleRefreshStateController({
    applyConsoleState,
    busyKey: busyController.busyKey,
    clearAllBusy: busyController.clearAllBusy,
    error,
    serverAvailable,
    setBusy: busyController.setBusy,
  });
  const serverEventController = createConsoleServerEventController({
    applyServerEvent,
    currentTopics,
    refreshState: refreshStateController.refreshState,
  });
  const authController = createConsoleAuthController({
    consoleState,
    error,
    clearAllBusy: busyController.clearAllBusy,
    refreshState: refreshStateController.refreshState,
    resetServerEventCursor: serverEventController.resetServerEventCursor,
    setBusy: busyController.setBusy,
    startServerEventSubscription: serverEventController.startServerEventSubscription,
    stopServerEventSubscription: serverEventController.stopServerEventSubscription,
  });
  const mcpAuthorizationController = createConsoleMcpAuthorizationController({
    clearBusy: busyController.clearBusy,
    error,
    setBusy: busyController.setBusy,
  });
  const operationPermissionPendingController = createConsoleOperationPermissionPendingController({
    clearBusy: busyController.clearBusy,
    error,
    setBusy: busyController.setBusy,
  });
  const agentSelectorController = createConsoleAgentSelectorController({
    agentModelOptionLabelCache,
    consoleState,
    gatewayAssistantForm,
  });
  const ruleAuthoringModelOptions = computed(() =>
    agentSelectorController.agentOptionsForModule("agentTools"),
  );

  function normalizeModelEntry(entry: Partial<AgentModelConfig>, index = 0) {
    return normalizeAgentModelEntry(entry, index);
  }

  const modelLibraryController = createConsoleModelLibraryController({
    gatewayAssistantModelAlias: () => String(
      settingsDraft.value.gatewayAssistantDefaults?.gatewayReviewModelAlias ||
      gatewayAssistantForm.value.modelAlias ||
      "",
    ),
    clearAllBusy: busyController.clearAllBusy,
    currentAgentModelOptionLabel: agentSelectorController.currentAgentModelOptionLabel,
    error,
    modelLibraryExpandedCards,
    modelProbeResults,
    moduleAgentCandidateDrafts,
    normalizeModelEntry,
    replaceSettingsDraftFromServer: settingsBridge.replaceSettingsDraftFromServer,
    ruleAuthoringModelAlias: () => String(
      settingsDraft.value.gatewayAssistantDefaults?.ruleAuthoringModelAlias ||
      ruleAuthoringForm.value.modelAlias ||
      "",
    ),
    selectedModelProvider,
    setBusy: busyController.setBusy,
    settingsDraft,
    settingsPayloadForSave: settingsBridge.settingsPayloadForSave,
  });
  const settingsDraftController = createConsoleSettingsDraftController({
    modelEntryParameters,
    modelRef: modelLibraryController.modelRef,
    moduleModelAssignmentOptions: modelLibraryController.moduleModelAssignmentOptions,
    moduleNeedsIntelligence: modelLibraryController.moduleNeedsIntelligence,
    normalizeModelEntry,
    settingsDraft,
    settingsDraftDirty,
    visibleModelEntries: () => modelLibraryController.visibleModelEntries.value,
  });
  settingsBridge.bindSettingsDraftActions(settingsDraftController);

  const pathPickerController = createConsolePathPickerController();
  const runtimeMountController = createConsoleRuntimeMountController({
    applyRemoteConsoleDraftUpdate: settingsBridge.applyRemoteConsoleDraftUpdate,
    consoleState,
    editingMountPaths,
    isApplyingRemoteConsoleDrafts: settingsBridge.isApplyingRemoteConsoleDrafts,
    openServerPathPicker: pathPickerController.openServerPathPicker,
    remoteDraftEquals: settingsBridge.remoteDraftEquals,
    saveMountModules: settingsBridge.saveMountModules,
    settingsDraft,
  });
  const discoveryController = createConsoleDiscoveryController({
    applyRemoteConsoleDraftUpdate: settingsBridge.applyRemoteConsoleDraftUpdate,
    clearAllBusy: busyController.clearAllBusy,
    error,
    isApplyingRemoteConsoleDrafts: settingsBridge.isApplyingRemoteConsoleDrafts,
    refreshState: refreshStateController.refreshState,
    remoteDraftEquals: settingsBridge.remoteDraftEquals,
    setBusy: busyController.setBusy,
  });
  const operationPermissionController = createConsoleOperationPermissionController({
    clearAllBusy: busyController.clearAllBusy,
    error,
    setBusy: busyController.setBusy,
  });
  const settingsPersistenceController = createConsoleSettingsPersistenceController({
    clearAllBusy: busyController.clearAllBusy,
    error,
    modelEntryStatusKey: modelLibraryController.modelEntryStatusKey,
    mountDraft: runtimeMountController.mountDraft,
    mountDraftDirty: runtimeMountController.mountDraftDirty,
    probeModelLibraryBeforeSave: modelLibraryController.probeModelLibraryBeforeSave,
    refreshState: refreshStateController.refreshState,
    setBusy: busyController.setBusy,
    settingsDraft,
    settingsDraftDirty,
    settingsPayloadForSave: settingsBridge.settingsPayloadForSave,
  });
  settingsBridge.bindSettingsPersistenceActions(settingsPersistenceController);

  const maintenanceAgentController = createConsoleMaintenanceAgentController({
    canReadMaintenanceAgent: authController.canReadMaintenanceAgent,
    clearAllBusy: busyController.clearAllBusy,
    consoleState,
    error,
    modelEntryStatusKey: modelLibraryController.modelEntryStatusKey,
    setBusy: busyController.setBusy,
    visibleModelEntries: modelLibraryController.visibleModelEntries,
  });
  const opsMonitorController = createConsoleOpsMonitorController({
    allMaintenanceAgentRuns: maintenanceAgentController.allMaintenanceAgentRuns,
    canAdminMaintenanceAgent: authController.canAdminMaintenanceAgent,
    canReadMaintenanceAgent: authController.canReadMaintenanceAgent,
    clearAllBusy: busyController.clearAllBusy,
    consoleState,
    error,
    setBusy: busyController.setBusy,
  });
  const clientController = createConsoleClientController({ consoleState });
  const jobController = createConsoleJobController({
    clearAllBusy: busyController.clearAllBusy,
    confirmAction: confirmConsoleAction,
    consoleState,
    error,
    refreshState: refreshStateController.refreshState,
    setBusy: busyController.setBusy,
  });

  const agentSelectionReferenceController = createConsoleAgentSelectionReferenceController();
  const selectedRuleAuthoringModel = computed(() =>
    agentSelectorController.selectedAgentFromOptions(
      ruleAuthoringModelOptions.value,
      ruleAuthoringForm.value.modelAlias,
    ),
  );
  agentSelectionReferenceController.watchAgentSelectionReference(
    "gateway-assistant",
    "网关审计智能体",
    () => gatewayAssistantForm.value.modelAlias,
    () => agentSelectorController.selectedGatewayAssistantModel.value,
  );
  agentSelectionReferenceController.watchAgentSelectionReference(
    "rule-authoring",
    "创建规则智能体",
    () => ruleAuthoringForm.value.modelAlias,
    () => selectedRuleAuthoringModel.value,
  );

  function accessSubject() {
    return { scopes: authController.currentUserScopes.value };
  }

  function pluginConsoleEntry(view: string, admin = false) {
    return (consoleState.value?.features?.plugins?.consoleEntries || []).find((entry) =>
      entry.viewKey === view && (
        admin
          ? isAdminPluginConsoleEntry(entry)
          : typeof entry.routePath === "string" && entry.routePath.startsWith("/")
      ),
    ) || null;
  }

  function pluginEntryAllowed(entry: PluginConsoleEntry | null) {
    if (!entry) return false;
    return routeAccessPolicyAllowsSubject({
      routePath: entry.routePath || `slot:${entry.slotId || entry.id}`,
      requiredScopes: [...entry.requiredScopes],
      requiredFeatureIds: [entry.featureId],
    }, accessSubject(), activeConsoleFeatureIds.value);
  }

  function canAccessView(view = "dashboard") {
    const policy = routeAccessPolicyForView(String(view || "dashboard"));
    return policy
      ? routeAccessPolicyAllowsSubject(policy, accessSubject(), activeConsoleFeatureIds.value)
      : pluginEntryAllowed(pluginConsoleEntry(String(view || "dashboard")) as PluginConsoleEntry | null);
  }

  function canAccessAdminView(view = "storage") {
    const policy = routeAccessPolicyForAdminView(String(view || "storage"));
    return policy
      ? routeAccessPolicyAllowsSubject(policy, accessSubject(), activeConsoleFeatureIds.value)
      : pluginEntryAllowed(pluginConsoleEntry(String(view || "storage"), true) as PluginConsoleEntry | null);
  }

  function canAccessRouteMeta(meta: unknown = {}) {
    const accessPolicy =
      meta && typeof meta === "object" && "accessPolicy" in meta
        ? (meta as { accessPolicy?: unknown }).accessPolicy
        : null;
    return routeAccessPolicyAllowsSubject(accessPolicy as never, accessSubject(), activeConsoleFeatureIds.value);
  }

  function firstAccessibleRoutePath() {
    return policyFirstAccessibleRoutePath(accessSubject(), activeConsoleFeatureIds.value);
  }

  async function openAdmin(view = "storage") {
    const nextView = String(view || "storage");
    if (!canAccessAdminView(nextView)) {
      await router.push(firstAccessibleRoutePath());
      return false;
    }
    adminView.value = nextView;
    const pluginEntry = pluginConsoleEntry(nextView, true);
    await router.push(pluginEntry?.routePath || "/admin/" + adminSectionToSlug(nextView));
    return true;
  }

  async function switchView(view = "dashboard") {
    const nextView = String(view || "dashboard");
    if (!canAccessView(nextView)) {
      await router.push(firstAccessibleRoutePath());
      return false;
    }
    const pluginEntry = pluginConsoleEntry(nextView);
    await router.push(pluginEntry?.routePath || viewToPath(nextView));
    return true;
  }

  const targetHighlightController = createConsoleTargetHighlightController({
    highlightedTarget: highlightedConfigTarget,
  });

  async function openAgentConfigurationAlert(alertItem: AgentConfigurationAlert) {
    const targetId = String(alertItem.targetId || "").trim();
    if (alertItem.view === "admin" && alertItem.adminView) {
      if (!canAccessAdminView(alertItem.adminView)) {
        await router.push(firstAccessibleRoutePath());
        return;
      }
      adminView.value = alertItem.adminView;
      await router.push({
        path: "/admin/" + adminSectionToSlug(alertItem.adminView),
        query: targetId ? { configTarget: targetId } : {},
      });
    } else if (alertItem.view) {
      const opened = await switchView(alertItem.view);
      if (!opened) {
        return;
      }
    }
    if (targetId) {
      await targetHighlightController.scrollToConfigTarget(targetId);
    }
  }

  const dashboardAlertController = createConsoleDashboardAlertController({
    acknowledgeMonitorAlert: opsMonitorController.acknowledgeMonitorAlert,
    activeMonitorAlerts: opsMonitorController.activeMonitorAlerts,
    agentModelAssignmentOptions: modelLibraryController.agentModelAssignmentOptions,
    agentSelectorOptions: agentSelectorController.agentSelectorOptions,
    backgroundProcesses: opsMonitorController.backgroundProcesses,
    error,
    gatewayAssistantAgentOptions: agentSelectorController.gatewayAssistantAgentOptions,
    gatewayAssistantForm,
    moduleModelRef: modelLibraryController.moduleModelRef,
    moduleNeedsIntelligence: modelLibraryController.moduleNeedsIntelligence,
    openAdmin: (view) => {
      void openAdmin(view);
    },
    openAgentConfigurationAlert,
    recoverBackgroundSupervisor: opsMonitorController.recoverBackgroundSupervisor,
    refreshMonitorAlerts: opsMonitorController.refreshMonitorAlerts,
    ruleAuthoringForm,
    ruleAuthoringModelOptions,
    settingsDraft,
    visibleModelEntries: modelLibraryController.visibleModelEntries,
  });

  const systemLogRowController = createConsoleSystemLogRowController({
    activeMonitorAlerts: opsMonitorController.activeMonitorAlerts,
    agentConfigurationAlerts: dashboardAlertController.agentConfigurationAlerts,
    agentSelectionReferenceLogs: agentSelectionReferenceController.agentSelectionReferenceLogs,
    authAudit: authController.authAudit,
    backgroundProcesses: opsMonitorController.backgroundProcesses,
    backgroundProcessStatus: opsMonitorController.backgroundProcessStatus,
    operationPermissionAuditItems: operationPermissionController.operationPermissionAuditItems,
    recentJobs: jobController.recentJobs,
    recentMonitorAlertHistory: opsMonitorController.recentMonitorAlertHistory,
    workQueueRows: opsMonitorController.workQueueRows,
  });
  const systemLogController = createConsoleSystemLogController({
    serverLogRows: systemLogRowController.serverLogRows,
  });
  const optionBarController = createConsoleOptionBarController({
    addableModelProviders: modelLibraryController.addableModelProviders,
    authState: authController.authState,
    moduleModelAssignmentOptions: modelLibraryController.moduleModelAssignmentOptions,
    providerLabel: modelLibraryController.providerLabel,
  });
  const contextCompilerController = createConsoleContextCompilerController({
    clearAllBusy: busyController.clearAllBusy,
    error,
    selectedContextProfileId: () => String(
      settingsDraft.value.gatewayAssistantDefaults?.contextProfileId || "",
    ),
    setBusy: busyController.setBusy,
  });
  const runtimeLifecycleController = createConsoleRuntimeLifecycleController({
    consoleBootstrapping: authController.consoleBootstrapping,
    clearBrowserLocalStateFromUrl,
    clearConfigTargetHighlight: targetHighlightController.clearConfigTargetHighlight,
    clearPendingRefreshState: refreshStateController.clearPendingRefreshState,
    liveDashboardAlerts: dashboardAlertController.liveDashboardAlerts,
    onBootstrapError: (nextError) => {
      error.value = nextError instanceof Error ? nextError.message : "控制台初始化失败。";
    },
    refreshAuthState: authController.refreshAuthState,
    refreshContextCompiler: contextCompilerController.refreshContextCompiler,
    refreshMonitorAlerts: opsMonitorController.refreshMonitorAlerts,
    refreshState: refreshStateController.refreshState,
    startServerEventSubscription: serverEventController.startServerEventSubscription,
    stopServerEventSubscription: serverEventController.stopServerEventSubscription,
    syncDashboardAlertInbox: dashboardAlertController.syncDashboardAlertInbox,
  });

  function hasFeature(featureId = "") {
    return activeConsoleFeatureIds.value.includes(String(featureId || ""));
  }

  function hasAnyFeature(...featureIds: string[]) {
    return featureIds.some((featureId) => hasFeature(featureId));
  }

  function openDrawer(tab = "overview") {
    drawerTab.value = String(tab || "overview");
    drawerOpen.value = true;
  }

  function closeDrawer() {
    drawerOpen.value = false;
  }

  watch(
    () => route.meta?.adminView,
    (view) => {
      if (view) {
        adminView.value = String(view);
      }
    },
    { immediate: true },
  );

  watch(
    [
      authController.isAuthenticated,
      () => Boolean(consoleState.value),
      () => authController.currentUserScopes.value.join("\u0000"),
      () => activeConsoleFeatureIds.value.join("\u0000"),
    ],
    () => configureRuntimeRouteGuard(router, {
      ready: Boolean(consoleState.value),
      authenticated: authController.isAuthenticated.value,
      scopes: authController.currentUserScopes.value,
      activeFeatureIds: activeConsoleFeatureIds.value,
    }),
    { immediate: true },
  );

  onMounted(runtimeLifecycleController.mountConsoleRuntime);
  onUnmounted(runtimeLifecycleController.unmountConsoleRuntime);

  const controller = {
    activeConsoleFeatureIds,
    adminView,
    applyConsoleState,
    applyServerEvent,
    canAccessAdminView,
    canAccessRouteMeta,
    canAccessView,
    closeDrawer,
    consoleState,
    currentTopics,
    currentView,
    debugTab,
    drawerOpen,
    drawerTab,
    error,
    firstAccessibleRoutePath,
    gatewayAssistantForm,
    hasAnyFeature,
    hasFeature,
    highlightedConfigTarget,
    intelligentModuleDefinitions,
    modelProbeResults,
    openAdmin,
    openAgentConfigurationAlert,
    openDrawer,
    ruleAuthoringForm,
    ruleAuthoringModelOptions,
    selectedModelProvider,
    serverAvailable,
    settingsDraft,
    settingsDraftDirty,
    sideNavCollapsed,
    sideNavOpen,
    switchView,
    ...busyController,
    ...refreshStateController,
    ...serverEventController,
    ...authController,
    ...mcpAuthorizationController,
    ...operationPermissionPendingController,
    ...agentSelectorController,
    ...modelLibraryController,
    ...settingsBridge,
    ...pathPickerController,
    ...runtimeMountController,
    ...discoveryController,
    ...operationPermissionController,
    ...maintenanceAgentController,
    ...opsMonitorController,
    ...clientController,
    ...jobController,
    ...dashboardAlertController,
    ...systemLogRowController,
    ...systemLogController,
    ...optionBarController,
    ...contextCompilerController,
    ...runtimeLifecycleController,
  };

  return controller satisfies ConsoleController;
}
