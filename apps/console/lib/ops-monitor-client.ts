import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  BackgroundProcessStatus,
  BackgroundSupervisorRecoveryResponse,
  MonitorAlertConfig,
  MonitorAlertState,
} from "./types";

export function getBackgroundProcesses() {
  return getJson<BackgroundProcessStatus>("/api/system/background-processes");
}

export function getMonitorAlerts() {
  return getJson<MonitorAlertState>("/api/system/monitor-alerts");
}

export function saveMonitorAlertConfig(config: MonitorAlertConfig) {
  return postJson<MonitorAlertState>(
    "/api/system/monitor-alerts/config",
    { config },
    { safetyConfirm: true },
  );
}

export function acknowledgeMonitorAlert(alertId: string) {
  return postJson<MonitorAlertState>(
    `/api/system/monitor-alerts/${encodeURIComponent(alertId)}/ack`,
    {},
    { safetyConfirm: true },
  );
}

export function recoverBackgroundSupervisor() {
  return postJson<BackgroundSupervisorRecoveryResponse>(
    "/api/system/background-supervisor/recover",
    {},
    { safetyConfirm: true },
  );
}
