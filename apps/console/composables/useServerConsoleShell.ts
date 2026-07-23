import { computed, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useConsole } from "./useConsole";
import { pickServerConsoleShellPublicContext } from "./console-shell-public-context";
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
  const publicConsoleContext = pickServerConsoleShellPublicContext(consoleContext);
  const {
    adminView,
    busyKey,
    consoleState,
    currentView,
    debugTab,
    hasFeature,
    isAuthenticated,
    refreshAuthAdmin,
    refreshAuthState,
    refreshBackgroundProcesses,
    refreshContextCompiler,
    refreshDashboardAlertsSnapshot,
    refreshMaintenanceAgent,
    refreshMcpAuthorizationRequests,
    refreshMonitorAlerts,
    refreshState,
    refreshOperationPermission,
    reloadModules,
    serverAvailable,
  } = publicConsoleContext;
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
  const workspacesConsole = useWorkspacesConsole({ autoload: false, globalBusyKey: busyKey });

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
    busyKey,
    hasFeature,
    msg,
    refreshAuthAdmin,
    refreshAuthState,
    refreshBackgroundProcesses,
    refreshContextCompiler,
    refreshDashboardAlertsSnapshot,
    refreshMaintenanceAgent,
    refreshMcpAuthorizationRequests,
    refreshMonitorAlerts,
    refreshOperationPermissionPendingOperations: approvalFlowConsole.refreshOperationPermissionPendingOperations,
    refreshState,
    refreshOperationPermission,
    reloadModules,
    routeFullPath: activeRouteFullPath,
  });

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

  return {
    ...publicConsoleContext,
    approvalFlowConsole,
    operationPermissionConsole,
    workspacesConsole,
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
    activeRouteView,
    activeRouteAdminView,
    serviceUrl,
    serviceStatusLabel,
    pageRefreshBusy,
    pageRefreshTitle,
    pageRefreshAriaLabel,
    refreshCurrentPage,
    localizedViewTitle,
  };
}
