import { computed, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useConsole } from "./useConsole";
import { pickApprovalFlowShellContext } from "./console-shell-approval-flow-context";
import { createConsoleShellPageRefreshController } from "./console-shell-page-refresh-controller";
import { useConsoleShellPreferences } from "./console-shell-preferences";
import { createConsoleShellRouteController } from "./console-shell-route-controller";
import { pickOperationPermissionShellContext } from "./console-shell-operation-permission-context";
import { useWorkspacesConsole } from "./useWorkspacesConsole";

export function useServerConsoleShell() {
  const consoleContext = useConsole();
  const approvalFlowConsole = pickApprovalFlowShellContext(consoleContext);
  const operationPermissionConsole = pickOperationPermissionShellContext(consoleContext);
  const {
    adminView,
    isAnyBusy,
    isBusy,
    isBusyPrefix,
    consoleState,
    currentView,
    debugTab,
    isAuthenticated,
    refreshAuthAdmin,
    refreshAuthState,
    refreshBackgroundProcesses,
    refreshDashboardAlertsSnapshot,
    refreshMonitorAlerts,
    refreshState,
    refreshOperationPermission,
    reloadModules,
    serverAvailable,
  } = consoleContext;
  const {
    appearancePresetId,
    appearancePresetCatalogMessage,
    appearancePresetImporting,
    appearanceCycleScheme,
    appearanceCycleSchemeLabel,
    appearanceCycleSchemeOptions,
    appearancePresetLabel,
    appearancePresetSelectionId,
    languageMode,
    languageOptionBarOptions,
    appearancePresetOptionsForCycleScheme,
    appearancePresetOptions,
    msg,
    applyAppearancePreset,
    cycleAppearancePreset,
    toggleAppearanceCycleScheme,
    importAppearancePresetFileToServer,
    refreshAppearancePresetConfigs,
    applyLanguage,
    setAppearanceCycleScheme,
    setAppearancePreset,
    setLanguage,
    toggleLanguage,
    tt,
  } = useConsoleShellPreferences({ isAuthenticated });
  const workspacesConsole = useWorkspacesConsole({
    autoload: false,
    globalBusy: { isAnyBusy, isBusy, isBusyPrefix },
  });

  const route = useRoute();
  const {
    activeRouteAdminView,
    activeRouteDebugTab,
    activeRouteFullPath,
    activeRouteView,
    localizedDebugTabLabel,
    localizedViewTitle,
  } = createConsoleShellRouteController({
    adminView,
    currentView,
    debugTab,
    msg,
    route,
  });
  const serviceUrl = computed(() => consoleState.value?.server.url || msg.value.connecting);
  const serviceStatusLabel = computed(() =>
    serverAvailable.value ? msg.value.topbar.serverAvailable : msg.value.topbar.serverUnavailable
  );
  const {
    pageRefreshAriaLabel,
    pageRefreshBusy,
    pageRefreshTitle,
    refreshCurrentPage,
    trackPageRefreshTask,
  } = createConsoleShellPageRefreshController({
    activeRouteAdminView,
    activeRouteDebugTab,
    activeRouteView,
    isAnyBusy,
    msg,
    refreshAuthAdmin,
    refreshAuthState,
    refreshBackgroundProcesses,
    refreshDashboardAlertsSnapshot,
    refreshMonitorAlerts,
    refreshOperationPermissionPendingOperations: approvalFlowConsole.refreshOperationPermissionPendingOperations,
    refreshState,
    refreshOperationPermission,
    reloadModules,
    routeFullPath: activeRouteFullPath,
  });
  const routeShellValues = {
    activeRouteAdminView,
    activeRouteDebugTab,
    activeRouteFullPath,
    activeRouteView,
    localizedDebugTabLabel,
    localizedViewTitle,
  };
  const pageRefreshValues = {
    pageRefreshAriaLabel,
    pageRefreshBusy,
    pageRefreshTitle,
    refreshCurrentPage,
  };
  const preferenceValues = {
    appearancePresetId,
    appearancePresetCatalogMessage,
    appearancePresetImporting,
    appearanceCycleScheme,
    appearanceCycleSchemeLabel,
    appearanceCycleSchemeOptions,
    appearancePresetLabel,
    appearancePresetSelectionId,
    languageMode,
    languageOptionBarOptions,
    appearancePresetOptionsForCycleScheme,
    appearancePresetOptions,
    msg,
    applyAppearancePreset,
    cycleAppearancePreset,
    toggleAppearanceCycleScheme,
    importAppearancePresetFileToServer,
    refreshAppearancePresetConfigs,
    applyLanguage,
    setAppearanceCycleScheme,
    setAppearancePreset,
    setLanguage,
    toggleLanguage,
    tt,
  };
  const runtimeValues = { serviceUrl, serviceStatusLabel };


  let toolListRouteRefreshSequence = 0;
  const isToolListRoute = computed(() =>
    activeRouteView.value === "admin" && ["tools", "toolList"].includes(activeRouteAdminView.value),
  );
  const operationPermissionCatalogLoaded = computed(() => {
    const catalog = operationPermissionConsole.operationPermissionCatalogState.value;
    return Boolean(
      catalog?.fingerprint ||
      catalog?.toolGroups?.length ||
      catalog?.toolsets?.length ||
      catalog?.tools?.length,
    );
  });

  async function refreshToolListRouteOnEntry(sequence: number, routePath: string) {
    await trackPageRefreshTask(refreshOperationPermission({ silent: true }));
    if (sequence !== toolListRouteRefreshSequence || activeRouteFullPath.value !== routePath) {
      return;
    }
    if (!operationPermissionCatalogLoaded.value) {
      return;
    }
    await nextTick();
    if (sequence !== toolListRouteRefreshSequence || activeRouteFullPath.value !== routePath) {
      return;
    }
    await refreshCurrentPage();
  }

  watch(
    [isAuthenticated, isToolListRoute, activeRouteFullPath],
    ([authenticated, shouldRefresh, routePath]) => {
      if (!authenticated || !shouldRefresh) {
        return;
      }
      const sequence = ++toolListRouteRefreshSequence;
      void refreshToolListRouteOnEntry(sequence, routePath);
    },
    { immediate: true },
  );


function pickMembers<
  Source extends object,
  const Keys extends readonly (keyof Source)[]
>(source: Source, keys: Keys): Readonly<Pick<Source, Keys[number]>> {
  const picked = {} as Pick<Source, Keys[number]>;
  for (const key of keys) {
    picked[key] = source[key];
  }
  return Object.freeze(picked);
}

  return {
    access: pickMembers(consoleContext, ["authAudit", "authRoleOptionBarOptions", "authSessions", "authUsers", "canAccessAdminView", "canAccessRouteMeta", "canAccessView", "canAdminAuth", "canBrowseServerPaths", "currentUser", "currentUserScopes", "isAuthenticated", "loginForm", "logoutConsole", "oidcAllowedDomainsText", "oidcDraft", "oidcRoleMappingText", "revokeConsoleSession", "saveOidcConfig", "submitLoginAuth", "updateConsoleUser", "updateConsoleUserRole"]),
    navigation: pickMembers({ ...consoleContext, ...routeShellValues }, ["activeRouteAdminView", "activeRouteDebugTab", "activeRouteFullPath", "activeRouteView", "adminView", "currentView", "debugTab", "firstAccessibleRoutePath", "localizedDebugTabLabel", "localizedViewTitle", "openAdmin", "sideNavCollapsed", "sideNavOpen", "switchView"]),
    preferences: pickMembers(preferenceValues, ["appearanceCycleScheme", "appearanceCycleSchemeLabel", "appearanceCycleSchemeOptions", "appearancePresetCatalogMessage", "appearancePresetId", "appearancePresetImporting", "appearancePresetLabel", "appearancePresetOptions", "appearancePresetOptionsForCycleScheme", "appearancePresetSelectionId", "applyAppearancePreset", "applyLanguage", "cycleAppearancePreset", "importAppearancePresetFileToServer", "languageMode", "languageOptionBarOptions", "msg", "refreshAppearancePresetConfigs", "setAppearanceCycleScheme", "setAppearancePreset", "setLanguage", "toggleAppearanceCycleScheme", "toggleLanguage", "tt"]),
    refresh: pickMembers({ ...consoleContext, ...pageRefreshValues }, ["pageRefreshAriaLabel", "pageRefreshBusy", "pageRefreshTitle", "refreshAuthAdmin", "refreshAuthState", "refreshBackgroundProcesses", "refreshCurrentPage", "refreshDashboardAlertsSnapshot", "refreshMonitorAlerts", "refreshOperationPermission", "refreshState"]),
    dashboard: pickMembers(consoleContext, ["dashboardAlertInboxId", "dashboardAlerts", "dismissDashboardAlert", "openDashboardAlert"]),
    jobs: pickMembers(consoleContext, ["backgroundProcessStatus", "backgroundProcesses", "backgroundRunningCount", "backgroundSupervisorLabel", "cancelJob", "canWriteJobs", "clientSearchQuery", "clientStateFilter", "clientStateFilterOptionBarOptions", "deleteJob", "exportClients", "filteredClientList", "recentJobs", "workQueueObservationState", "workQueueRows", "workQueueSummary"]),
    modules: pickMembers(consoleContext, ["disableMountModule", "enableMountModule", "enabledMountCount", "isMountPathEditing", "moduleGroups", "mountDraft", "openMountPathPicker", "reloadModules", "saveMountModules", "toggleMountPathEdit", "totalMountCount"]),
    monitoring: pickMembers(consoleContext, ["acknowledgeMonitorAlert", "activeMonitorAlerts", "exportSystemLogRows", "filteredSystemLogRows", "goToSystemLogNextPage", "goToSystemLogPreviousPage", "handleSystemLogTableScroll", "monitorAlertConfigText", "monitorAlertState", "monitorAlertSummary", "paginatedSystemLogRows", "recentMonitorAlertHistory", "saveMonitorAlertConfig", "serverLogRows", "systemLogColumnWidths", "systemLogCurrentPage", "systemLogDisplayStatusLabel", "systemLogFilters", "systemLogKindOptionBarOptions", "systemLogPageCount", "systemLogPageRange", "systemLogPageSize", "systemLogPageSizeOptionBarOptions", "systemLogPageTotal", "systemLogStatusOptionBarOptions", "systemLogTableShellRef"]),
    settings: pickMembers(consoleContext, ["highlightedConfigTarget", "saveSettings", "settingsDraft"]),
    operationPermission: { operationPermissionConsole },
    approvals: { approvalFlowConsole },
    workspaces: { workspacesConsole },
    overlays: pickMembers(consoleContext, ["closeDrawer", "closeServerPathPicker", "confirmServerPathPicker", "discoveryDraft", "drawerOpen", "drawerTab", "openDrawer", "openPathEntry", "pathEntryMeta", "pathPicker", "pathPickerModeLabel", "refreshServerPathBrowser", "saveDiscovery", "selectServerPath"]),
    runtime: pickMembers({ ...consoleContext, ...runtimeValues }, ["activeConsoleFeatureIds", "consoleBootstrapping", "consoleState", "error", "hasAnyFeature", "hasFeature", "isAnyBusy", "isBusy", "isBusyPrefix", "serverAvailable", "serviceStatusLabel", "serviceUrl"]),
  };
}

export type { ServerConsoleShellContext } from "./server-console-shell-context";
