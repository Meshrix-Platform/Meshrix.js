import { computed, ref, type ComputedRef, type Ref } from "vue";
import { monitorAlertSeverityLabel } from "./console-status-utils";
import type { BackgroundProcessStatus, MonitorAlertState } from "../lib/types";
import type { AdminView, AgentConfigurationAlert, DashboardAlert } from "../types/app";

export type MonitorAlertItem = NonNullable<MonitorAlertState["activeAlerts"]>[number];
export type BackgroundProcessItem = NonNullable<BackgroundProcessStatus["processes"]>[number];

type DashboardAlertInboxControllerOptions = {
  acknowledgeMonitorAlert: (alertId: string) => Promise<void>;
  activeMonitorAlerts: ComputedRef<MonitorAlertItem[]>;
  agentConfigurationAlerts: ComputedRef<AgentConfigurationAlert[]>;
  backgroundProcesses: ComputedRef<BackgroundProcessItem[]>;
  error: Ref<string>;
  openAdmin: (tab: AdminView) => void;
  openAgentConfigurationAlert: (alertItem: AgentConfigurationAlert) => Promise<void>;
  refreshMonitorAlerts: (options?: { silent?: boolean }) => Promise<void>;
  recoverBackgroundSupervisor: () => Promise<void>;
};

export function createConsoleDashboardAlertInboxController(options: DashboardAlertInboxControllerOptions) {
  const dashboardAlertInbox = ref<Record<string, DashboardAlert>>({});
  const dismissedDashboardAlertIds = ref<Set<string>>(new Set());

  const dashboardMonitorAlerts = computed<DashboardAlert[]>(() =>
    options.activeMonitorAlerts.value.map((alert) => {
      const recovered = alert.ackRequired || alert.active === false || alert.status === "recovered";
      const isQueueInterruption = alert.ruleId === "queueInterrupted";
      const isSupervisorStopped = alert.alertId === "monitor.supervisor.stopped";
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

  const liveDashboardAlerts = computed<DashboardAlert[]>(() => [
    ...dashboardMonitorAlerts.value,
    ...options.agentConfigurationAlerts.value.map((alert) => ({
      alertId: alert.alertId,
      category: "空配置报警",
      title: alert.title,
      detail: alert.detail,
      status: alert.status,
      tone: alert.tone,
      actionLabel: "去配置",
      source: "configuration" as const,
      configAlert: alert,
    })),
  ]);

  function dashboardAlertInboxId(alertItem: DashboardAlert) {
    return `${alertItem.source}:${alertItem.alertId}`;
  }

  function shouldDropResolvedDashboardAlert(alertItem: DashboardAlert) {
    if (alertItem.source !== "monitor") return false;
    const alertId = String(alertItem.alertId || "");
    const processIsHealthy = (role: string) => {
      const processItem = options.backgroundProcesses.value.find((item) => item.role === role);
      return processItem?.alive === true && ["running", "standby"].includes(String(processItem.status || ""));
    };
    if (alertId === "monitor.supervisor.stopped") return processIsHealthy("background-supervisor");
    for (const role of ["background-supervisor", "system-inspection"]) {
      if (alertId.startsWith(`monitor.process.${role}.`)) return processIsHealthy(role);
    }
    const demandManagedRoles = ["import-worker", "maintenance-worker", "agent-worker"];
    const role = demandManagedRoles.find((item) => alertId.startsWith(`monitor.process.${item}.`));
    if (!role) return false;
    const processItem = options.backgroundProcesses.value.find((item) => item.role === role);
    return processItem?.desired === false;
  }

  function syncDashboardAlertInbox(liveAlerts: DashboardAlert[]) {
    const now = new Date().toISOString();
    const liveById = new Map<string, DashboardAlert>(liveAlerts.map((alertItem) => [
      dashboardAlertInboxId(alertItem),
      alertItem,
    ]));
    const nextDismissedIds = new Set<string>();
    for (const alertId of dismissedDashboardAlertIds.value) {
      if (liveById.has(alertId)) nextDismissedIds.add(alertId);
    }
    const nextInbox: Record<string, DashboardAlert> = {};
    for (const [alertId, previousAlert] of Object.entries(dashboardAlertInbox.value)) {
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
      const previousAlert = dashboardAlertInbox.value[alertId];
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

  const dashboardAlerts = computed<DashboardAlert[]>(() => {
    const severityRank: Record<DashboardAlert["tone"], number> = { danger: 0, warning: 1, success: 2 };
    return Object.values(dashboardAlertInbox.value)
      .filter((alertItem) => !dismissedDashboardAlertIds.value.has(dashboardAlertInboxId(alertItem)))
      .sort((left, right) => {
        const severityDiff = severityRank[left.tone] - severityRank[right.tone];
        if (severityDiff !== 0) return severityDiff;
        return String(left.firstSeenAt || "").localeCompare(String(right.firstSeenAt || ""));
      });
  });

  const dashboardPrimaryAlert = computed<DashboardAlert | null>(() => dashboardAlerts.value[0] || null);
  const dashboardPrimaryAlertInboxId = computed(() => dashboardPrimaryAlert.value ? dashboardAlertInboxId(dashboardPrimaryAlert.value) : "");
  const isNotPrimaryAlert = (alertItem: DashboardAlert) => dashboardAlertInboxId(alertItem) !== dashboardPrimaryAlertInboxId.value;
  const dashboardConfigurationQueue = computed<DashboardAlert[]>(() =>
    dashboardAlerts.value.filter((alertItem) => alertItem.source === "configuration" && isNotPrimaryAlert(alertItem)),
  );
  const dashboardMonitorQueue = computed<DashboardAlert[]>(() =>
    dashboardAlerts.value.filter((alertItem) => alertItem.source === "monitor" && isNotPrimaryAlert(alertItem)),
  );
  const dashboardSecondaryAlerts = computed<DashboardAlert[]>(() =>
    dashboardAlerts.value.filter(isNotPrimaryAlert).slice(0, 4),
  );
  const dashboardAlertCounts = computed(() => ({
    total: dashboardAlerts.value.length,
    danger: dashboardAlerts.value.filter((item) => item.tone === "danger").length,
    warning: dashboardAlerts.value.filter((item) => item.tone === "warning").length,
    recovered: dashboardAlerts.value.filter((item) => item.tone === "success").length,
    configuration: dashboardAlerts.value.filter((item) => item.source === "configuration").length,
    monitor: dashboardAlerts.value.filter((item) => item.source === "monitor").length,
  }));

  const dashboardAlertSummary = computed(() => {
    const dangerCount = dashboardAlertCounts.value.danger;
    const warningCount = dashboardAlertCounts.value.warning;
    const recoveredCount = dashboardAlertCounts.value.recovered;
    if (dashboardAlerts.value.length === 0) return "当前没有需要处理的报警。";
    return [
      dangerCount ? `${dangerCount} 项严重` : "",
      warningCount ? `${warningCount} 项警告` : "",
      recoveredCount ? `${recoveredCount} 项已恢复待确认` : "",
    ].filter(Boolean).join("，");
  });

  async function openDashboardAlert(alertItem: DashboardAlert) {
    if (alertItem.source === "configuration" && alertItem.configAlert) {
      await options.openAgentConfigurationAlert(alertItem.configAlert);
      return;
    }
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

  async function dismissDashboardAlert(alertItem: DashboardAlert) {
    const inboxId = dashboardAlertInboxId(alertItem);
    const monitorAlert = alertItem.monitorAlert;
    if (
      alertItem.source === "monitor" &&
      monitorAlert &&
      (monitorAlert.ackRequired || monitorAlert.active === false || monitorAlert.status === "recovered")
    ) {
      await options.acknowledgeMonitorAlert(alertItem.alertId);
      if (options.error.value) return;
    }
    dismissedDashboardAlertIds.value = new Set([...dismissedDashboardAlertIds.value, inboxId]);
    const nextInbox = { ...dashboardAlertInbox.value };
    delete nextInbox[inboxId];
    dashboardAlertInbox.value = nextInbox;
  }

  async function refreshDashboardAlertsSnapshot(optionsOverride: { silent?: boolean } = {}) {
    await options.refreshMonitorAlerts({ silent: optionsOverride.silent !== false });
    syncDashboardAlertInbox(liveDashboardAlerts.value);
  }

  return {
    dashboardAlertCounts,
    dashboardAlertInbox,
    dashboardAlertInboxId,
    dashboardAlertSummary,
    dashboardAlerts,
    dashboardConfigurationQueue,
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
