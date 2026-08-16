import { computed, ref, type ComputedRef, type Ref } from "vue";
import { monitorAlertSeverityLabel } from "./console-status-utils";
import type { BackgroundProcessStatus, MonitorAlertState } from "../lib/types";
import type { AdminView, DashboardAlert } from "../types/app";

export type MonitorAlertItem = NonNullable<MonitorAlertState["activeAlerts"]>[number];
export type BackgroundProcessItem = NonNullable<BackgroundProcessStatus["processes"]>[number];

type DashboardAlertInboxControllerOptions = {
  acknowledgeMonitorAlert: (alertId: string) => Promise<void>;
  activeMonitorAlerts: ComputedRef<MonitorAlertItem[]>;
  backgroundProcesses: ComputedRef<BackgroundProcessItem[]>;
  error: Ref<string>;
  openAdmin: (tab: AdminView) => void;
  refreshMonitorAlerts: (options?: { silent?: boolean }) => Promise<void>;
  recoverBackgroundSupervisor: () => Promise<void>;
};

export function createConsoleDashboardAlertInboxController(options: DashboardAlertInboxControllerOptions) : any {
  const dashboardAlertInbox: any = ref<Record<string, DashboardAlert>>({});
  const dismissedDashboardAlertIds: any = ref<Set<string>>(new Set<any>());

  const dashboardMonitorAlerts: any = computed<DashboardAlert[]>(() : any =>
    options.activeMonitorAlerts.value.map((alert?: any) : any => {
      const recovered: any = alert.ackRequired || alert.active === false || alert.status === "recovered";
      const isQueueInterruption: any = alert.ruleId === "queueInterrupted";
      const isSupervisorStopped: any = alert.alertId === "monitor.supervisor.stopped";
      return {
        alertId: alert.alertId,
        category: isQueueInterruption ? "中断报警" : "后台报警",
        title: alert.title,
        detail: alert.resourceRef ? `${alert.message} 资源引用：${alert.resourceRef}` : alert.message,
        status: recovered ? "已恢复，待确认" : monitorAlertSeverityLabel(alert.severity),
        tone: recovered ? "success" : alert.severity === "critical" ? "danger" : "warning",
        actionLabel: recovered ? "确认关闭" : isSupervisorStopped ? "拉起进程" : "查看报警",
        actionKind: isSupervisorStopped && !recovered ? "recover-supervisor" : "open",
        source: "monitor",
        monitorAlert: alert,
      };
    }),
  );

  const liveDashboardAlerts: any = computed<DashboardAlert[]>(() : any => dashboardMonitorAlerts.value);

  function dashboardAlertInboxId(alertItem: DashboardAlert) : any {
    return `${alertItem.source}:${alertItem.alertId}`;
  }

  function shouldDropResolvedDashboardAlert(alertItem: DashboardAlert) : any {
    if (alertItem.source !== "monitor") return false;
    const alertId: any = String(alertItem.alertId || "");
    const processIsHealthy: any = (role: string) : any => {
      const processItem: any = options.backgroundProcesses.value.find((item?: any) : any => item.role === role);
      return processItem?.alive === true && ["running", "standby"].includes(String(processItem.status || ""));
    };
    if (alertId === "monitor.supervisor.stopped") return processIsHealthy("background-supervisor");
    for (const role of ["background-supervisor", "system-inspection"]) {
      if (alertId.startsWith(`monitor.process.${role}.`)) return processIsHealthy(role);
    }
    const demandManagedRoles: any[] = ["import-worker"];
    const role: any = demandManagedRoles.find((item?: any) : any => alertId.startsWith(`monitor.process.${item}.`));
    if (!role) return false;
    const processItem: any = options.backgroundProcesses.value.find((item?: any) : any => item.role === role);
    return processItem?.desired === false;
  }

  function syncDashboardAlertInbox(liveAlerts: DashboardAlert[]) : any {
    const now: any = new Date().toISOString();
    const liveById: any = new Map<string, DashboardAlert>(liveAlerts.map((alertItem?: any) : any => [
      dashboardAlertInboxId(alertItem),
      alertItem,
    ]));
    const nextDismissedIds: any = new Set<string>();
    for (const alertId of dismissedDashboardAlertIds.value) {
      if (liveById.has(alertId)) nextDismissedIds.add(alertId);
    }
    const nextInbox: Record<string, DashboardAlert> = {};
    for (const [alertId, previousAlert] of (Object.entries(dashboardAlertInbox.value) as [string, any][])) {
      if (nextDismissedIds.has(alertId)) continue;
      if (!liveById.has(alertId)) {
        if (shouldDropResolvedDashboardAlert(previousAlert)) continue;
        nextInbox[alertId] = previousAlert.live === false
          ? previousAlert
          : {
              ...previousAlert,
              status: "已恢复，待确认",
              tone: "success",
              actionLabel: "确认关闭",
              live: false,
              resolvedAt: now,
            };
      }
    }
    for (const [alertId, liveAlert] of liveById.entries()) {
      if (nextDismissedIds.has(alertId)) continue;
      const previousAlert: any = dashboardAlertInbox.value[alertId];
      nextInbox[alertId] = {
        ...previousAlert,
        ...liveAlert,
        firstSeenAt: previousAlert?.firstSeenAt || now,
        lastSeenAt: now,
        live: true,
        resolvedAt: "",
      };
    }
    dismissedDashboardAlertIds.value = nextDismissedIds;
    dashboardAlertInbox.value = nextInbox;
  }

  const dashboardAlerts: any = computed<DashboardAlert[]>(() : any => {
    const severityRank: Record<string, number> = { danger: 0, warning: 1, success: 2 };
    return (Object.values(dashboardAlertInbox.value) as any[])
      .filter((alertItem?: any) : any => !dismissedDashboardAlertIds.value.has(dashboardAlertInboxId(alertItem)))
      .sort((left?: any, right?: any) : any => {
        const severityDiff: any = severityRank[left.tone] - severityRank[right.tone];
        if (severityDiff !== 0) return severityDiff;
        return String(left.firstSeenAt || "").localeCompare(String(right.firstSeenAt || ""));
      });
  });

  const dashboardPrimaryAlert: any = computed<DashboardAlert | null>(() : any => dashboardAlerts.value[0] || null);
  const dashboardPrimaryAlertInboxId: any = computed(() : any => dashboardPrimaryAlert.value ? dashboardAlertInboxId(dashboardPrimaryAlert.value) : "");
  const isNotPrimaryAlert: any = (alertItem: DashboardAlert) : any => dashboardAlertInboxId(alertItem) !== dashboardPrimaryAlertInboxId.value;
  const dashboardMonitorQueue: any = computed<DashboardAlert[]>(() : any =>
    dashboardAlerts.value.filter((alertItem?: any) : any => alertItem.source === "monitor" && isNotPrimaryAlert(alertItem)),
  );
  const dashboardSecondaryAlerts: any = computed<DashboardAlert[]>(() : any =>
    dashboardAlerts.value.filter(isNotPrimaryAlert).slice(0, 4),
  );
  const dashboardAlertCounts: any = computed(() : any => ({
    total: dashboardAlerts.value.length,
    danger: dashboardAlerts.value.filter((item?: any) : any => item.tone === "danger").length,
    warning: dashboardAlerts.value.filter((item?: any) : any => item.tone === "warning").length,
    recovered: dashboardAlerts.value.filter((item?: any) : any => item.tone === "success").length,
    monitor: dashboardAlerts.value.filter((item?: any) : any => item.source === "monitor").length,
  }));

  const dashboardAlertSummary: any = computed(() : any => {
    const dangerCount: any = dashboardAlertCounts.value.danger;
    const warningCount: any = dashboardAlertCounts.value.warning;
    const recoveredCount: any = dashboardAlertCounts.value.recovered;
    if (dashboardAlerts.value.length === 0) return "当前没有需要处理的报警。";
    return [
      dangerCount ? `${dangerCount} 项严重` : "",
      warningCount ? `${warningCount} 项警告` : "",
      recoveredCount ? `${recoveredCount} 项已恢复待确认` : "",
    ].filter(Boolean).join("，");
  });

  async function openDashboardAlert(alertItem: DashboardAlert) : Promise<any> {
    if (alertItem.source === "monitor" && alertItem.actionKind === "recover-supervisor") {
      await options.recoverBackgroundSupervisor();
      if (!options.error.value) {
        await options.refreshMonitorAlerts({ silent: true });
        syncDashboardAlertInbox(liveDashboardAlerts.value);
      }
      return;
    }
    options.openAdmin("opsMonitor");
    await options.refreshMonitorAlerts({ silent: true });
  }

  async function dismissDashboardAlert(alertItem: DashboardAlert) : Promise<any> {
    const inboxId: any = dashboardAlertInboxId(alertItem);
    const monitorAlert: any = alertItem.monitorAlert;
    if (
      alertItem.source === "monitor" &&
      monitorAlert &&
      (monitorAlert.ackRequired || monitorAlert.active === false || monitorAlert.status === "recovered")
    ) {
      await options.acknowledgeMonitorAlert(alertItem.alertId);
      if (options.error.value) return;
    }
    dismissedDashboardAlertIds.value = new Set<any>([...dismissedDashboardAlertIds.value, inboxId]);
    const nextInbox: Record<string, any> = { ...dashboardAlertInbox.value };
    delete nextInbox[inboxId];
    dashboardAlertInbox.value = nextInbox;
  }

  async function refreshDashboardAlertsSnapshot(optionsOverride: { silent?: boolean } = {}) : Promise<any> {
    await options.refreshMonitorAlerts({ silent: optionsOverride.silent !== false });
    syncDashboardAlertInbox(liveDashboardAlerts.value);
  }

  return {
    dashboardAlertCounts,
    dashboardAlertInbox,
    dashboardAlertInboxId,
    dashboardAlertSummary,
    dashboardAlerts,
    dismissDashboardAlert,
    dismissedDashboardAlertIds,
    dashboardMonitorQueue,
    dashboardPrimaryAlert,
    dashboardSecondaryAlerts,
    liveDashboardAlerts,
    openDashboardAlert,
    refreshDashboardAlertsSnapshot,
    syncDashboardAlertInbox,
  };
}
