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

export function useServerConsoleShell() : any {
  const consoleContext: any = useConsole();
  const approvalFlowConsole: any = pickApprovalFlowShellContext(consoleContext);
  const operationPermissionConsole: any = pickOperationPermissionShellContext(consoleContext);
  const publicConsoleContext: any = pickServerConsoleShellPublicContext(consoleContext);
  const {
    adminView,
    isAnyBusy,
    isBusy,
    isBusyPrefix,
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
  const workspacesConsole: any = useWorkspacesConsole({
    autoload: false,
    globalBusy: { isAnyBusy, isBusy, isBusyPrefix },
  });

  const route: any = useRoute();
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
  const serviceUrl: any = computed(() : any => consoleState.value?.server.url || msg.value.connecting);
  const serviceStatusLabel: any = computed(() : any =>
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
    hasFeature,
    msg,
    refreshAuthAdmin,
    refreshAuthState,
    refreshBackgroundProcesses,
    refreshContextCompiler,
    refreshDashboardAlertsSnapshot,
    refreshMaintenanceAgent,
    refreshMonitorAlerts,
    refreshOperationPermissionPendingOperations: approvalFlowConsole.refreshOperationPermissionPendingOperations,
    refreshState,
    refreshOperationPermission,
    reloadModules,
    routeFullPath: activeRouteFullPath,
  });

  let toolListRouteRefreshSequence: any = 0;
  const isToolListRoute: any = computed(() : any =>
    activeRouteView.value === "admin" && ["tools", "toolList"].includes(activeRouteAdminView.value),
  );
  const operationPermissionCatalogLoaded: any = computed(() : any => {
    const catalog: any = operationPermissionConsole.operationPermissionCatalogState.value;
    return Boolean(
      catalog?.fingerprint ||
      catalog?.toolGroups?.length ||
      catalog?.toolsets?.length ||
      catalog?.tools?.length,
    );
  });

  async function refreshToolListRouteOnEntry(sequence: number, routePath: string) : Promise<any> {
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
    ([authenticated, shouldRefresh, routePath]: any[]) : any => {
      if (!authenticated || !shouldRefresh) {
        return;
      }
      const sequence: any = ++toolListRouteRefreshSequence;
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

export type ServerConsoleShellContext = ReturnType<typeof useServerConsoleShell>;
