import { type ComputedRef, type Ref } from "vue";
import {
  createConsoleDashboardAlertInboxController,
  type BackgroundProcessItem,
  type MonitorAlertItem,
} from "./console-dashboard-alert-inbox-controller";
import type { AdminView } from "../types/app";

type DashboardAlertControllerOptions = {
  acknowledgeMonitorAlert: (alertId: string) => Promise<void>;
  activeMonitorAlerts: ComputedRef<MonitorAlertItem[]>;
  backgroundProcesses: ComputedRef<BackgroundProcessItem[]>;
  error: Ref<string>;
  openAdmin: (tab: AdminView) => void;
  refreshMonitorAlerts: (options?: { silent?: boolean }) => Promise<void>;
  recoverBackgroundSupervisor: () => Promise<void>;
};

export function createConsoleDashboardAlertController(options: DashboardAlertControllerOptions) : any {
  const alertInbox: any = createConsoleDashboardAlertInboxController({
    acknowledgeMonitorAlert: options.acknowledgeMonitorAlert,
    activeMonitorAlerts: options.activeMonitorAlerts,
    backgroundProcesses: options.backgroundProcesses,
    error: options.error,
    openAdmin: options.openAdmin,
    refreshMonitorAlerts: options.refreshMonitorAlerts,
    recoverBackgroundSupervisor: options.recoverBackgroundSupervisor,
  });

  return alertInbox;
}
