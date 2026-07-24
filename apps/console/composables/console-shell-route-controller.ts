import { computed, type ComputedRef, type Ref } from "vue";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import type { consoleMessages } from "../i18n/console";

type ConsoleShellRouteMessages = (typeof consoleMessages)[keyof typeof consoleMessages];

type LabeledTab = {
  id: string;
  label: string;
};

type ConsoleShellRouteControllerOptions = {
  adminView: Ref<string>;
  currentView: Ref<string>;
  debugTab: Ref<string>;
  msg: ComputedRef<ConsoleShellRouteMessages>;
  route: RouteLocationNormalizedLoaded;
};

function adminRouteTitle(adminView: string, messages: ConsoleShellRouteMessages) {
  switch (adminView) {
    case "operationPermission":
      return messages.nav.operationPermission;
    case "tools":
    case "toolList":
      return messages.nav.toolList;
    case "toolGovernance":
      return messages.nav.toolGovernance;
    case "toolStats":
      return messages.nav.toolStats;
    case "agentConfig":
      return messages.nav.agentConfig;
    case "agentAssignment":
      return messages.nav.agentAssignment;
    case "contextManagement":
      return messages.nav.contextManagement;
    case "maintenanceAgent":
      return messages.nav.maintenanceAgent;
    case "jobs":
      return messages.nav.jobs;
    case "logs":
      return messages.nav.logs;
    case "opsMonitor":
      return messages.nav.opsMonitor;
    case "strategyManagement":
      return messages.nav.strategyManagement;
    case "tagManagement":
      return messages.nav.tagManagement;
    case "versionRelease":
      return messages.nav.versionRelease;
    case "versionAssembly":
      return messages.nav.versionAssembly;
    case "productionHealth":
      return messages.nav.productionHealth;
    case "modules":
      return messages.title.modules;
    case "storage":
      return messages.title.storage;
    default:
      return messages.title.admin;
  }
}

function routeViewTitle(view: string, messages: ConsoleShellRouteMessages) {
  switch (view) {
    case "dashboard":
      return messages.nav.dashboard;
    case "approval":
      return messages.nav.approvalFlow;
    case "workspaces":
      return messages.nav.workspaces;
    case "debug":
      return messages.nav.debugPanel;
    default:
      return "";
  }
}

export function createConsoleShellRouteController(options: ConsoleShellRouteControllerOptions) {
  const activeRouteView = computed(() => String(options.route.meta?.viewId || options.currentView.value));
  const activeRouteDebugTab = computed(() => String(options.route.params.tab || options.debugTab.value));
  const activeRouteAdminView = computed(() => String(options.route.meta?.adminView || options.adminView.value));
  const activeRouteFullPath = computed(() => options.route.fullPath);

  const localizedViewTitle = computed(() => {
    const messages = options.msg.value;
    const contributedTitle = String(options.route.meta?.title || "").trim();
    if (contributedTitle) return contributedTitle;
    if (activeRouteView.value === "admin") {
      return adminRouteTitle(activeRouteAdminView.value, messages);
    }
    return routeViewTitle(activeRouteView.value, messages);
  });

  function localizedDebugTabLabel(tab: LabeledTab) {
    switch (tab.id) {
      case "gatewayReview":
        return options.msg.value.nav.gatewayReview;
      default:
        return tab.label;
    }
  }

  return {
    activeRouteAdminView,
    activeRouteDebugTab,
    activeRouteFullPath,
    activeRouteView,
    localizedDebugTabLabel,
    localizedViewTitle,
  };
}
