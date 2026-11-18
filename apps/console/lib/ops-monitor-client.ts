import { getJson, postJson } from "@meshrix/ui-console/bridge-http";
import type {
  BackgroundProcessStatus,
  BackgroundSupervisorRecoveryResponse,
  MonitorAlertConfig,
  MonitorAlertState,
} from "./types";

export function getBackgroundProcesses() : any {
  return getJson<BackgroundProcessStatus>("/api/system/background-processes");
}

export function getMonitorAlerts() : any {
  return getJson<MonitorAlertState>("/api/system/monitor-alerts");
}

export function saveMonitorAlertConfig(config: MonitorAlertConfig) : any {
  return postJson<MonitorAlertState>(
    "/api/system/monitor-alerts/config",
    { config },
    { safetyConfirm: true },
  );
}

export function acknowledgeMonitorAlert(alertId: string) : any {
  return postJson<MonitorAlertState>(
    `/api/system/monitor-alerts/${encodeURIComponent(alertId)}/ack`,
    {},
    { safetyConfirm: true },
  );
}

export function recoverBackgroundSupervisor() : any {
  return postJson<BackgroundSupervisorRecoveryResponse>(
    "/api/system/background-supervisor/recover",
    {},
    { safetyConfirm: true },
  );
}
