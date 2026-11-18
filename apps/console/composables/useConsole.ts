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
  AgentSettings,
  ServerConsoleState,
} from "../lib/types";
import type {
  AdminView,
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
} from "../router/route-access-policy.ts";
import { clearBrowserLocalStateFromUrl } from "./console-browser-state-utils";
import {
  confirmConsoleAction,
  createConsoleTargetHighlightController,
} from "./console-browser-effects";
import {
  emptySettings,
} from "./console-defaults";
import { createConsoleApprovalFlowSelectionController } from "./console-approval-flow-selection-controller";
import { createConsoleAuthController } from "./console-auth-controller";
import { createConsoleBusyController } from "./console-busy-controller";
import { createConsoleClientController } from "./console-client-controller";
import { createConsoleDashboardAlertController } from "./console-dashboard-alert-controller";
import { createConsoleDiscoveryController } from "./console-discovery-controller";
import { CONSOLE_EVENT_TOPICS, createConsoleEventRouter } from "./console-event-router";
import { createConsoleJobController } from "./console-job-controller";
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
  isAnyBusy: ComputedRef<boolean>;
  canAccessAdminView: (adminView?: string) => boolean;
  canAccessRouteMeta: (meta?: unknown) => boolean;
  canAccessView: (view?: string) => boolean;
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

function cloneSettings(value: AgentSettings) : any {
  return JSON.parse(JSON.stringify(value)) as AgentSettings;
}

export function useConsole() : any {
  const route: any = useRoute();
  const router: any = useRouter();

  const consoleState: any = ref<ServerConsoleState | null>(null);
  const serverAvailable: any = ref(false);
  const error: any = ref("");
  const drawerOpen: any = ref(false);
  const drawerTab: any = ref("overview");
  const adminView: any = ref<AdminView>("storage");
  const debugTab: any = ref<DebugTab>("");
  const sideNavCollapsed: any = ref(false);
  const sideNavOpen: any = ref(false);
  const highlightedConfigTarget: any = ref("");
  const editingMountPaths: any = ref<Record<string, boolean>>({});
  const settingsDraft: any = ref<AgentSettings>(cloneSettings(emptySettings));
  const settingsDraftDirty: any = ref(false);

  const currentView: any = computed(() : any => String(route.meta?.viewId || "dashboard"));
  const activeConsoleFeatureIds: any = computed(() : any =>
    consoleState.value?.features?.activeFeatureIds || [],
  );
  const busyController: any = createConsoleBusyController();
  const settingsBridge: any = createConsoleSettingsBridgeController();

  function applyConsoleState(
    nextState: ServerConsoleState,
    applyOptions: { forceSettings?: boolean; forceDrafts?: boolean } = {},
  ) : any {
    syncPluginConsoleRoutes(
      router,
      (nextState.features?.plugins?.consoleEntries || []) as PluginConsoleEntry[],
    );
    consoleState.value = nextState;
    const replaceSettings: any =
      applyOptions.forceSettings === true ||
      applyOptions.forceDrafts === true ||
      !settingsDraftDirty.value;
    if (replaceSettings) {
      settingsBridge.replaceSettingsDraftFromServer(nextState.settings.value);
    }
    if (applyOptions.forceDrafts === true || !runtimeMountController.mountDraftDirty.value) {
      runtimeMountController.replaceMountDraftFromServer(nextState.runtime.mountModules);
    }
    if (applyOptions.forceDrafts === true || !discoveryController.discoveryDraftDirty.value) {
      discoveryController.replaceDiscoveryDraftFromServer(nextState.discovery.value);
    }
    dashboardAlertController.syncDashboardAlertInbox(
      dashboardAlertController.liveDashboardAlerts.value,
    );
  }

  function currentTopics() : any {
    return CONSOLE_EVENT_TOPICS.join(",");
  }

  const applyServerEvent: any = createConsoleEventRouter({
    applyConsoleState,
    getConsoleState: () : any => consoleState.value,
    removeJob: (jobId?: any) : any => jobController.removeJobFromEvent(jobId),
    upsertJob: (job?: any) : any => jobController.upsertJobFromEvent(job),
  });

  const refreshStateController: any = createConsoleRefreshStateController({
    applyConsoleState,
    clearBusy: busyController.clearBusy,
    error,
    serverAvailable,
    setBusy: busyController.setBusy,
  });
  const serverEventController: any = createConsoleServerEventController({
    applyServerEvent,
    currentTopics,
    refreshState: refreshStateController.refreshState,
  });
  const authController: any = createConsoleAuthController({
    consoleState,
    error,
    clearBusy: busyController.clearBusy,
    refreshState: refreshStateController.refreshState,
    resetServerEventCursor: serverEventController.resetServerEventCursor,
    setBusy: busyController.setBusy,
    startServerEventSubscription: serverEventController.startServerEventSubscription,
    stopServerEventSubscription: serverEventController.stopServerEventSubscription,
  });
  const operationPermissionPendingController: any = createConsoleOperationPermissionPendingController({
    clearBusy: busyController.clearBusy,
    error,
    setBusy: busyController.setBusy,
  });
  const approvalFlowSelectionController: any =
    createConsoleApprovalFlowSelectionController({
      operationPermissionPendingStatus:
        operationPermissionPendingController.operationPermissionPendingStatus,
      refreshOperationPermissionPendingOperations:
        operationPermissionPendingController.refreshOperationPermissionPendingOperations,
    });
  const settingsDraftController: any = createConsoleSettingsDraftController({
    settingsDraft,
    settingsDraftDirty,
  });
  settingsBridge.bindSettingsDraftActions(settingsDraftController);

  const pathPickerController: any = createConsolePathPickerController();
  const runtimeMountController: any = createConsoleRuntimeMountController({
    applyRemoteConsoleDraftUpdate: settingsBridge.applyRemoteConsoleDraftUpdate,
    consoleState,
    editingMountPaths,
    isApplyingRemoteConsoleDrafts: settingsBridge.isApplyingRemoteConsoleDrafts,
    openServerPathPicker: pathPickerController.openServerPathPicker,
    remoteDraftEquals: settingsBridge.remoteDraftEquals,
    saveMountModules: settingsBridge.saveMountModules,
    settingsDraft,
  });
  const discoveryController: any = createConsoleDiscoveryController({
    applyRemoteConsoleDraftUpdate: settingsBridge.applyRemoteConsoleDraftUpdate,
    clearBusy: busyController.clearBusy,
    error,
    isApplyingRemoteConsoleDrafts: settingsBridge.isApplyingRemoteConsoleDrafts,
    refreshState: refreshStateController.refreshState,
    remoteDraftEquals: settingsBridge.remoteDraftEquals,
    setBusy: busyController.setBusy,
  });
  const operationPermissionController: any = createConsoleOperationPermissionController({
    clearBusy: busyController.clearBusy,
    error,
    setBusy: busyController.setBusy,
  });
  const settingsPersistenceController: any = createConsoleSettingsPersistenceController({
    clearBusy: busyController.clearBusy,
    error,
    mountDraft: runtimeMountController.mountDraft,
    mountDraftDirty: runtimeMountController.mountDraftDirty,
    refreshState: refreshStateController.refreshState,
    setBusy: busyController.setBusy,
    settingsDraft,
    settingsDraftDirty,
    settingsPayloadForSave: settingsBridge.settingsPayloadForSave,
  });
  settingsBridge.bindSettingsPersistenceActions(settingsPersistenceController);

  const opsMonitorController: any = createConsoleOpsMonitorController({
    canAdminOperations: authController.canAdminAuth,
    canReadOperations: authController.isAuthenticated,
    clearBusy: busyController.clearBusy,
    consoleState,
    error,
    setBusy: busyController.setBusy,
  });
  const clientController: any = createConsoleClientController({ consoleState });
  const jobController: any = createConsoleJobController({
    clearBusy: busyController.clearBusy,
    confirmAction: confirmConsoleAction,
    consoleState,
    error,
    refreshState: refreshStateController.refreshState,
    setBusy: busyController.setBusy,
  });

  function accessSubject() : any {
    return { scopes: authController.currentUserScopes.value };
  }

  function pluginConsoleEntry(view: string, admin: any = false) : any {
    return (consoleState.value?.features?.plugins?.consoleEntries || []).find((entry?: any) : any =>
      entry.viewKey === view && (
        admin
          ? isAdminPluginConsoleEntry(entry)
          : typeof entry.routePath === "string" && entry.routePath.startsWith("/")
      ),
    ) || null;
  }

  function pluginEntryAllowed(entry: PluginConsoleEntry | null) : any {
    if (!entry) return false;
    return routeAccessPolicyAllowsSubject({
      routePath: entry.routePath || `slot:${entry.slotId || entry.id}`,
      requiredScopes: [...entry.requiredScopes],
      requiredFeatureIds: [entry.featureId],
    }, accessSubject(), activeConsoleFeatureIds.value);
  }

  function canAccessView(view: any = "dashboard") : any {
    const policy: any = routeAccessPolicyForView(String(view || "dashboard"));
    return policy
      ? routeAccessPolicyAllowsSubject(policy, accessSubject(), activeConsoleFeatureIds.value)
      : pluginEntryAllowed(pluginConsoleEntry(String(view || "dashboard")) as PluginConsoleEntry | null);
  }

  function canAccessAdminView(view: any = "storage") : any {
    const policy: any = routeAccessPolicyForAdminView(String(view || "storage"));
    return policy
      ? routeAccessPolicyAllowsSubject(policy, accessSubject(), activeConsoleFeatureIds.value)
      : pluginEntryAllowed(pluginConsoleEntry(String(view || "storage"), true) as PluginConsoleEntry | null);
  }

  function canAccessRouteMeta(meta: unknown = {}) : any {
    const accessPolicy: any =
      meta && typeof meta === "object" && "accessPolicy" in meta
        ? (meta as { accessPolicy?: unknown }).accessPolicy
        : null;
    return routeAccessPolicyAllowsSubject(accessPolicy as never, accessSubject(), activeConsoleFeatureIds.value);
  }

  function firstAccessibleRoutePath() : any {
    return policyFirstAccessibleRoutePath(accessSubject(), activeConsoleFeatureIds.value);
  }

  async function openAdmin(view: any = "storage") : Promise<any> {
    const nextView: any = String(view || "storage");
    if (!canAccessAdminView(nextView)) {
      await router.push(firstAccessibleRoutePath());
      return false;
    }
    adminView.value = nextView;
    const pluginEntry: any = pluginConsoleEntry(nextView, true);
    await router.push(pluginEntry?.routePath || "/admin/" + adminSectionToSlug(nextView));
    return true;
  }

  async function switchView(view: any = "dashboard") : Promise<any> {
    const nextView: any = String(view || "dashboard");
    if (!canAccessView(nextView)) {
      await router.push(firstAccessibleRoutePath());
      return false;
    }
    const pluginEntry: any = pluginConsoleEntry(nextView);
    await router.push(pluginEntry?.routePath || viewToPath(nextView));
    return true;
  }

  const targetHighlightController: any = createConsoleTargetHighlightController({
    highlightedTarget: highlightedConfigTarget,
  });

  const dashboardAlertController: any = createConsoleDashboardAlertController({
    acknowledgeMonitorAlert: opsMonitorController.acknowledgeMonitorAlert,
    activeMonitorAlerts: opsMonitorController.activeMonitorAlerts,
    backgroundProcesses: opsMonitorController.backgroundProcesses,
    error,
    openAdmin: (view?: any) : any => {
      void openAdmin(view);
    },
    recoverBackgroundSupervisor: opsMonitorController.recoverBackgroundSupervisor,
    refreshMonitorAlerts: opsMonitorController.refreshMonitorAlerts,
  });

  const systemLogRowController: any = createConsoleSystemLogRowController({
    activeMonitorAlerts: opsMonitorController.activeMonitorAlerts,
    authAudit: authController.authAudit,
    backgroundProcesses: opsMonitorController.backgroundProcesses,
    backgroundProcessStatus: opsMonitorController.backgroundProcessStatus,
    operationPermissionAuditItems: operationPermissionController.operationPermissionAuditItems,
    recentJobs: jobController.recentJobs,
    recentMonitorAlertHistory: opsMonitorController.recentMonitorAlertHistory,
    workQueueRows: opsMonitorController.workQueueRows,
  });
  const systemLogController: any = createConsoleSystemLogController({
    serverLogRows: systemLogRowController.serverLogRows,
  });
  const optionBarController: any = createConsoleOptionBarController({
    authState: authController.authState,
  });
  const runtimeLifecycleController: any = createConsoleRuntimeLifecycleController({
    consoleBootstrapping: authController.consoleBootstrapping,
    clearBrowserLocalStateFromUrl,
    clearConfigTargetHighlight: targetHighlightController.clearConfigTargetHighlight,
    clearPendingRefreshState: refreshStateController.clearPendingRefreshState,
    liveDashboardAlerts: dashboardAlertController.liveDashboardAlerts,
    onBootstrapError: (nextError?: any) : any => {
      error.value = nextError instanceof Error ? nextError.message : "控制台初始化失败。";
    },
    refreshAuthState: authController.refreshAuthState,
    refreshMonitorAlerts: opsMonitorController.refreshMonitorAlerts,
    refreshState: refreshStateController.refreshState,
    startServerEventSubscription: serverEventController.startServerEventSubscription,
    stopServerEventSubscription: serverEventController.stopServerEventSubscription,
    syncDashboardAlertInbox: dashboardAlertController.syncDashboardAlertInbox,
  });

  function hasFeature(featureId: any = "") : any {
    return activeConsoleFeatureIds.value.includes(String(featureId || ""));
  }

  function hasAnyFeature(...featureIds: string[]) : any {
    return featureIds.some((featureId?: any) : any => hasFeature(featureId));
  }

  function openDrawer(tab: any = "overview") : any {
    drawerTab.value = String(tab || "overview");
    drawerOpen.value = true;
  }

  function closeDrawer() : any {
    drawerOpen.value = false;
  }

  watch(
    () : any => route.meta?.adminView,
    (view?: any) : any => {
      if (view) {
        adminView.value = String(view);
      }
    },
    { immediate: true },
  );

  watch(
    [
      authController.isAuthenticated,
      () : any => Boolean(consoleState.value),
      () : any => authController.currentUserScopes.value.join("\u0000"),
      () : any => activeConsoleFeatureIds.value.join("\u0000"),
    ],
    () : any => configureRuntimeRouteGuard(router, {
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
    hasAnyFeature,
    hasFeature,
    highlightedConfigTarget,
    openAdmin,
    openDrawer,
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
    ...operationPermissionPendingController,
    ...approvalFlowSelectionController,
    ...settingsBridge,
    ...pathPickerController,
    ...runtimeMountController,
    ...discoveryController,
    ...operationPermissionController,
    ...opsMonitorController,
    ...clientController,
    ...jobController,
    ...dashboardAlertController,
    ...systemLogRowController,
    ...systemLogController,
    ...optionBarController,
    ...runtimeLifecycleController,
  };

  return controller satisfies ConsoleController;
}
