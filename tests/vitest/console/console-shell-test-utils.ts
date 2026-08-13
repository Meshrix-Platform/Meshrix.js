import type { ServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";

// Fixture routing is compile-time checked against the real inferred shell contract.
const CONSOLE_SHELL_NAMESPACE_MEMBERS = {
  access: ["authAudit", "authRoleOptionBarOptions", "authSessions", "authUsers", "canAccessAdminView", "canAccessRouteMeta", "canAccessView", "canAdminAuth", "canBrowseServerPaths", "currentUser", "currentUserScopes", "isAuthenticated", "loginForm", "logoutConsole", "oidcAllowedDomainsText", "oidcDraft", "oidcRoleMappingText", "revokeConsoleSession", "saveOidcConfig", "submitLoginAuth", "updateConsoleUser", "updateConsoleUserRole"],
  navigation: ["activeRouteAdminView", "activeRouteDebugTab", "activeRouteFullPath", "activeRouteView", "adminView", "currentView", "debugTab", "firstAccessibleRoutePath", "localizedDebugTabLabel", "localizedViewTitle", "openAdmin", "sideNavCollapsed", "sideNavOpen", "switchView"],
  preferences: ["appearanceCycleScheme", "appearanceCycleSchemeLabel", "appearanceCycleSchemeOptions", "appearancePresetCatalogMessage", "appearancePresetId", "appearancePresetImporting", "appearancePresetLabel", "appearancePresetOptions", "appearancePresetOptionsForCycleScheme", "appearancePresetSelectionId", "applyAppearancePreset", "applyLanguage", "cycleAppearancePreset", "importAppearancePresetFileToServer", "languageMode", "languageOptionBarOptions", "msg", "refreshAppearancePresetConfigs", "setAppearanceCycleScheme", "setAppearancePreset", "setLanguage", "toggleAppearanceCycleScheme", "toggleLanguage", "tt"],
  refresh: ["pageRefreshAriaLabel", "pageRefreshBusy", "pageRefreshTitle", "refreshAuthAdmin", "refreshAuthState", "refreshBackgroundProcesses", "refreshContextCompiler", "refreshCurrentPage", "refreshDashboardAlertsSnapshot", "refreshMaintenanceAgent", "refreshMonitorAlerts", "refreshOperationPermission", "refreshState"],
  dashboard: ["dashboardAlertInboxId", "dashboardAlerts", "dismissDashboardAlert", "openDashboardAlert"],
  jobs: ["backgroundProcessStatus", "backgroundProcesses", "backgroundRunningCount", "backgroundSupervisorLabel", "cancelJob", "canWriteJobs", "clientSearchQuery", "clientStateFilter", "clientStateFilterOptionBarOptions", "deleteJob", "exportClients", "filteredClientList", "recentJobs", "workQueueObservationState", "workQueueRows", "workQueueSummary"],
  maintenance: ["addMaintenanceAgentSchedule", "approveMaintenanceAgentRun", "autoApproveRiskOptionBarOptions", "canAdminMaintenanceAgent", "canApproveMaintenanceAgent", "canRunMaintenanceAgent", "cancelMaintenanceAgentRun", "displayedMaintenanceAgentRuns", "enabledBooleanOptionBarOptions", "latestMaintenanceAgentRun", "maintenanceAgentConfig", "maintenanceAgentResultJson", "maintenanceAgentRunbook", "maintenanceAgentRunbookOptionBarOptions", "maintenanceAgentRunbooks", "maintenanceAgentSummary", "nextMaintenanceAgentRunAt", "pendingMaintenanceApprovalCount", "plannerModeOptionBarOptions", "removeMaintenanceAgentSchedule", "runMaintenanceAgentGatewayReview", "runMaintenanceAgentRunbook", "saveMaintenanceAgentConfig", "selectedMaintenanceAgentRun"],
  models: ["addModelProvider", "addableModelProviderOptionBarOptions", "duplicateModelEntry", "exportAgentModelEntryConfig", "isModelLibraryCardExpanded", "modelEntryBindingSummary", "modelEntryBindings", "modelEntryIsBound", "modelEntryModuleAccess", "modelEntryProbeResult", "modelEntryProbeStatusLabel", "modelEntryProbeStatusTone", "modelEntryStatusKey", "modelProbeResults", "modelProviderDefinition", "parseModelRef", "probeModelEntry", "providerLabel", "removeModelProvider", "runModelEntryProbe", "saveModelLibrarySettings", "selectedModelProvider", "setModelEntryModuleAccessMode", "toggleModelEntryModuleAccess", "toggleModelLibraryCard", "visibleModelEntries"],
  modules: ["disableMountModule", "enableMountModule", "enabledMountCount", "intelligentModuleDefinitions", "isMountPathEditing", "moduleAccessModeOptionBarOptions", "moduleGroups", "moduleModelAssignmentSelectOptions", "moduleModelAssignmentStats", "moduleModelRef", "moduleNeedsIntelligence", "mountDraft", "openMountPathPicker", "reloadModules", "saveMountModules", "setModuleModelRef", "setModuleNeedsIntelligence", "toggleMountPathEdit", "totalMountCount"],
  contextCompilation: ["contextBuildRecordRows", "contextEvaluationResult", "contextPreviewRequiredEvidence", "contextPreviewResult", "contextPreviewTask", "contextProfileRows", "contextProfilesResponse", "exportContextBuildRecords", "previewContextCompiler", "runContextReplayEvaluation"],
  monitoring: ["acknowledgeMonitorAlert", "activeMonitorAlerts", "exportSystemLogRows", "filteredSystemLogRows", "goToSystemLogNextPage", "goToSystemLogPreviousPage", "handleSystemLogTableScroll", "monitorAlertConfigText", "monitorAlertState", "monitorAlertSummary", "paginatedSystemLogRows", "recentMonitorAlertHistory", "saveMonitorAlertConfig", "serverLogRows", "systemLogColumnWidths", "systemLogCurrentPage", "systemLogDisplayStatusLabel", "systemLogFilters", "systemLogKindOptionBarOptions", "systemLogPageCount", "systemLogPageRange", "systemLogPageSize", "systemLogPageSizeOptionBarOptions", "systemLogPageTotal", "systemLogStatusOptionBarOptions", "systemLogTableShellRef"],
  settings: ["agentSelectorOptions", "gatewayAssistantAgentOptions", "gatewayAssistantForm", "highlightedConfigTarget", "ruleAuthoringForm", "ruleAuthoringModelOptions", "saveSettings", "settingsDraft"],
  operationPermission: ["operationPermissionConsole"],
  approvals: ["approvalFlowConsole"],
  workspaces: ["workspacesConsole"],
  overlays: ["closeDrawer", "closeServerPathPicker", "confirmServerPathPicker", "discoveryDraft", "drawerOpen", "drawerTab", "openDrawer", "openPathEntry", "pathEntryMeta", "pathPicker", "pathPickerModeLabel", "refreshServerPathBrowser", "saveDiscovery", "selectServerPath"],
  runtime: ["activeConsoleFeatureIds", "consoleBootstrapping", "consoleState", "error", "hasAnyFeature", "hasFeature", "isAnyBusy", "isBusy", "isBusyPrefix", "serverAvailable", "serviceStatusLabel", "serviceUrl"],
} satisfies {
  [Namespace in keyof ServerConsoleShellContext]: readonly (
    keyof ServerConsoleShellContext[Namespace]
  )[];
};

/**
 * Wrap a flat server console shell fixture into the exact namespaced contract.
 * Unknown keys fail loudly so fixtures stay aligned with the real context type.
 */
export function namespaceServerConsoleShell(flat: Record<string, unknown>): ServerConsoleShellContext {
  const namespaced: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(flat)) {
    const namespace = Object.entries(CONSOLE_SHELL_NAMESPACE_MEMBERS)
      .find(([, keys]) => (keys as readonly string[]).includes(key))?.[0];
    if (!namespace) {
      throw new Error(`Unknown server console shell fixture key: ${key}`);
    }
    namespaced[namespace] = namespaced[namespace] || {};
    namespaced[namespace][key] = value;
  }
  return namespaced as unknown as ServerConsoleShellContext;
}
