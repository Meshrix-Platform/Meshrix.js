import { computed, ref, type ComputedRef } from "vue";
import { collectPageRefreshTasks } from "@meshrix/ui-console/page-refresh";

type MaybePromise<T> = T | Promise<T>;

type RefreshStateOptions = {
  forceDrafts?: boolean;
  silent?: boolean;
};

type SilentRefreshOptions = {
  silent?: boolean;
};

type PageRefreshMessages = {
  actions: {
    refreshing: string;
    refreshPage: string;
  };
};

type ConsoleShellPageRefreshControllerOptions = {
  activeRouteAdminView: ComputedRef<string>;
  activeRouteDebugTab: ComputedRef<string>;
  activeRouteView: ComputedRef<string>;
  busyKey: ComputedRef<string>;
  hasFeature: (featureId: string) => boolean;
  msg: ComputedRef<PageRefreshMessages>;
  refreshAuthAdmin: () => MaybePromise<unknown>;
  refreshAuthState: () => MaybePromise<unknown>;
  refreshBackgroundProcesses: (options?: SilentRefreshOptions) => MaybePromise<unknown>;
  refreshContextCompiler: () => MaybePromise<unknown>;
  refreshDashboardAlertsSnapshot: (options?: SilentRefreshOptions) => MaybePromise<unknown>;
  refreshMaintenanceAgent: (options?: SilentRefreshOptions) => MaybePromise<unknown>;
  refreshMcpAuthorizationRequests: () => MaybePromise<unknown>;
  refreshMonitorAlerts: (options?: SilentRefreshOptions) => MaybePromise<unknown>;
  refreshOperationPermissionPendingOperations: () => MaybePromise<unknown>;
  refreshState: (options?: RefreshStateOptions) => MaybePromise<unknown>;
  refreshOperationPermission: (options?: SilentRefreshOptions) => MaybePromise<unknown>;
  reloadModules: () => MaybePromise<unknown>;
  routeFullPath: ComputedRef<string>;
};

async function waitForPageRefreshTasks(tasks: Promise<unknown>[]) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) {
    throw failed.reason;
  }
}

export function createConsoleShellPageRefreshController(options: ConsoleShellPageRefreshControllerOptions) {
  const pageRefreshPendingCount = ref(0);
  const pageRefreshActionBusy = computed(() => pageRefreshPendingCount.value > 0);
  const busyKey = computed(() => options.busyKey?.value || "");
  const pageRefreshMessages = computed(() => options.msg?.value || {
    actions: {
      refreshing: "刷新中",
      refreshPage: "刷新",
    },
  });
  const pageRefreshBusy = computed(() =>
    pageRefreshActionBusy.value || Boolean(busyKey.value),
  );
  const pageRefreshTitle = computed(() =>
    pageRefreshBusy.value ? `${pageRefreshMessages.value.actions.refreshing}...` : pageRefreshMessages.value.actions.refreshPage,
  );
  const pageRefreshAriaLabel = computed(() =>
    pageRefreshBusy.value ? pageRefreshMessages.value.actions.refreshing : pageRefreshMessages.value.actions.refreshPage,
  );

  async function trackPageRefreshTask<T>(task: MaybePromise<T>): Promise<T> {
    pageRefreshPendingCount.value += 1;
    try {
      return await task;
    } finally {
      pageRefreshPendingCount.value = Math.max(0, pageRefreshPendingCount.value - 1);
    }
  }

  async function refreshAdminRoute() {
    switch (options.activeRouteAdminView.value) {
      case "storage":
        await Promise.all([
          options.refreshAuthAdmin(),
          options.reloadModules(),
          options.refreshState({ silent: true, forceDrafts: false }),
        ]);
        return;
      case "jobs":
        await Promise.all([
          options.refreshState({ silent: true, forceDrafts: true }),
          options.refreshMaintenanceAgent({ silent: true }),
          options.refreshMonitorAlerts({ silent: true }),
        ]);
        return;
      case "logs":
        await Promise.all([
          options.refreshState({ silent: true }),
          options.hasFeature("maintenance-agent-runbooks")
            ? options.refreshMaintenanceAgent({ silent: true })
            : Promise.resolve(),
          options.hasFeature("agent-gateway") || options.hasFeature("agent-management")
            ? options.refreshOperationPermission({ silent: true })
            : Promise.resolve(),
          options.refreshBackgroundProcesses({ silent: true }),
          options.refreshMonitorAlerts({ silent: true }),
          options.refreshAuthAdmin(),
        ]);
        return;
      case "opsMonitor":
        await Promise.all([
          options.refreshBackgroundProcesses({ silent: true }),
          options.refreshMonitorAlerts({ silent: true }),
        ]);
        return;
      case "productionHealth":
        return;
      case "strategyManagement":
        return;
      case "versionRelease":
        return;
      case "versionAssembly":
        return;
      case "tools":
      case "toolList":
      case "toolGovernance":
      case "toolStats":
        await options.refreshOperationPermission();
        return;
      case "modules":
        await options.reloadModules();
        return;
      case "operationPermission":
        await Promise.all([
          options.refreshAuthAdmin(),
          options.refreshOperationPermission(),
        ]);
        return;
      case "agentConfig":
      case "agentAssignment":
        await options.refreshState({ silent: true, forceDrafts: true });
        return;
      case "contextManagement":
        await options.refreshContextCompiler();
        return;
      case "maintenanceAgent":
        await options.refreshMaintenanceAgent();
        return;
      default:
        await options.refreshState({ silent: true });
    }
  }

  async function refreshCurrentRouteDefaults() {
    switch (options.activeRouteView.value) {
      case "dashboard":
        await options.refreshDashboardAlertsSnapshot({ silent: false });
        return;
      case "approval":
        await Promise.all([
          options.refreshMcpAuthorizationRequests(),
          options.refreshOperationPermissionPendingOperations(),
        ]);
        return;
      case "workspaces":
        await options.refreshAuthState();
        return;
      case "debug":
        await options.refreshState({ silent: true });
        return;
      case "admin":
        await refreshAdminRoute();
        return;
      default:
        await options.refreshState({ silent: true });
    }
  }

  async function refreshCurrentPage() {
    if (pageRefreshActionBusy.value) {
      return;
    }
    await trackPageRefreshTask((async () => {
      const pageTasks = collectPageRefreshTasks({
        viewId: options.activeRouteView.value,
        adminView: options.activeRouteAdminView.value,
        gatewayTab: "",
        debugTab: options.activeRouteDebugTab.value,
        routePath: options.routeFullPath.value,
      });
      await waitForPageRefreshTasks([
        Promise.resolve(refreshCurrentRouteDefaults()),
        ...pageTasks,
      ]);
    })());
  }

  return {
    pageRefreshAriaLabel,
    pageRefreshBusy,
    pageRefreshTitle,
    refreshCurrentPage,
    trackPageRefreshTask,
  };
}
