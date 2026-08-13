import { computed } from "vue";
import type { MonitorAlertItem } from "../lib/types";
import { formatCompactDate } from "@meshrix/ui-console/console-format-utils";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import {
  backgroundProcessLabel,
  backgroundProcessTone,
  monitorAlertSeverityLabel,
  monitorAlertSeverityTone,
  processRelationText,
  processRelationBullets,
  processTypeLabel,
} from "./console-status-utils";

type MonitorAlertDetailBullet = {
  label: string;
  text: string;
};

function splitMonitorAlertMessage(message: string) : any {
  return String(message || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[。；;])\s*/u)
    .map((item?: any) : any => item.replace(/[。；;]+$/u, "").trim())
    .filter(Boolean);
}

function monitorAlertMessageLabel(text: string, index: number) : any {
  if (/^(请|建议|检查|确认|修复|处理)/u.test(text)) {
    return "处理";
  }
  if (/(PID|当前状态|未运行|离线|失败|中断|超时|stopped|missing)/iu.test(text)) {
    return "状态";
  }
  if (/(负责|影响|导致|依赖|关联|拉起|管理)/u.test(text)) {
    return "影响";
  }
  return index === 0 ? "详情" : "补充";
}

function isRecoveredMonitorAlert(alert: MonitorAlertItem) : any {
  if (alert.ackRequired || alert.active === false || alert.status === "recovered") {
    return true;
  }
  return false;
}

function monitorAlertLifecycleText(alert: MonitorAlertItem, severityLabel: (severity: string) => string) : any {
  if (isRecoveredMonitorAlert(alert)) {
    return "已恢复";
  }
  return alert.status || severityLabel(alert.severity);
}

function monitorAlertMergeKey(alert: MonitorAlertItem) : any {
  return [
    alert.alertId,
    alert.resolvedAt || "",
    alert.acknowledgedAt || "",
    isRecoveredMonitorAlert(alert) ? "recovered" : "active",
  ].join(":");
}

function shouldIncludeMonitorAlertLifecycle(alert: MonitorAlertItem) : any {
  return isRecoveredMonitorAlert(alert);
}

function isAcknowledgedMonitorAlert(alert: MonitorAlertItem) : any {
  return Boolean(alert.acknowledgedAt && isRecoveredMonitorAlert(alert));
}

function uniqueMonitorAlerts(alerts: MonitorAlertItem[]) : any {
  const seen: any = new Set<string>();
  return alerts.filter((alert?: any) : any => {
    if (isAcknowledgedMonitorAlert(alert)) {
      return false;
    }
    const key: any = monitorAlertMergeKey(alert);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function useOpsMonitorViewConsole() : any {
  const {
  backgroundProcessStatus,
  backgroundProcesses,
  backgroundRunningCount,
  backgroundSupervisorLabel,
} = useServerConsoleShellContext().jobs;
const {
  canAdminMaintenanceAgent,
} = useServerConsoleShellContext().maintenance;
const {
  acknowledgeMonitorAlert,
  activeMonitorAlerts,
  monitorAlertConfigText,
  monitorAlertState,
  monitorAlertSummary,
  recentMonitorAlertHistory,
  saveMonitorAlertConfig,
} = useServerConsoleShellContext().monitoring;
const {
  isBusy,
} = useServerConsoleShellContext().runtime;

  const monitorAlertRows: any = computed(() : any =>
    uniqueMonitorAlerts([...activeMonitorAlerts.value, ...recentMonitorAlertHistory.value]),
  );

  const visibleMonitorAlerts: any = computed(() : any =>
    monitorAlertRows.value.filter((alert?: any) : any => !isRecoveredMonitorAlert(alert)),
  );

  const monitorAlertHistoryRows: any = computed(() : any =>
    monitorAlertRows.value.filter((alert?: any) : any => isRecoveredMonitorAlert(alert)),
  );

  function monitorAlertDetailBullets(
    alert: MonitorAlertItem,
    includeLifecycle: any = false,
  ): MonitorAlertDetailBullet[] {
    const bullets: MonitorAlertDetailBullet[] = [];
    if (includeLifecycle) {
      bullets.push({ label: "状态", text: monitorAlertLifecycleText(alert, monitorAlertSeverityLabel) });
    }
    if (alert.resourceRef) {
      bullets.push({ label: "资源引用", text: alert.resourceRef });
    }
    splitMonitorAlertMessage(alert.message).forEach((text?: any, index?: any) : any => {
      bullets.push({ label: monitorAlertMessageLabel(text, index), text });
    });
    const sourceParts: any = [alert.source, alert.role].filter(
      (item?: any, index?: any, list?: any) : any => item && list.indexOf(item) === index,
    );
    if (sourceParts.length > 0) {
	      bullets.push({ label: "来源", text: sourceParts.join("，") });
    }
    return bullets.length > 0 ? bullets : [{ label: "详情", text: "-" }];
  }

  return {
    acknowledgeMonitorAlert,
    backgroundProcessLabel,
    backgroundProcessStatus,
    backgroundProcessTone,
    backgroundProcesses,
    backgroundRunningCount,
    backgroundSupervisorLabel,
    isBusy,
    canAdminMaintenanceAgent,
    formatCompactDate,
    monitorAlertConfigText,
    monitorAlertDetailBullets,
    mergedMonitorAlerts: monitorAlertRows,
    monitorAlertHistoryRows,
    monitorAlertMergeKey,
    monitorAlertSeverityLabel,
    monitorAlertSeverityTone,
    monitorAlertState,
    monitorAlertSummary,
    processRelationText,
    processRelationBullets,
    processTypeLabel,
    saveMonitorAlertConfig,
    shouldIncludeMonitorAlertLifecycle,
    visibleMonitorAlerts,
  };
}
