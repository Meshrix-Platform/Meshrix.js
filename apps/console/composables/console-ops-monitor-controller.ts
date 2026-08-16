import { computed, ref, type ComputedRef, type Ref } from "vue";
import {
  acknowledgeMonitorAlert as acknowledgeMonitorAlertRequest,
  getBackgroundProcesses,
  getMonitorAlerts,
  recoverBackgroundSupervisor as recoverBackgroundSupervisorRequest,
  saveMonitorAlertConfig as saveMonitorAlertConfigRequest,
} from "../lib/ops-monitor-client";
import type {
  BackgroundProcessStatus,
  MonitorAlertState,
  ServerConsoleState,
} from "../lib/types";
import type { WorkQueueRow } from "../types/app";
import { jsonPreview } from "@meshrix/ui-console/console-format-utils";
import { queueLifecycleTone } from "./console-status-utils";

type ConsoleOpsMonitorControllerOptions = {
  canAdminOperations: ComputedRef<boolean>;
  canReadOperations: ComputedRef<boolean>;
  clearBusy: (key: string) => void;
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleOpsMonitorController(
  options: ConsoleOpsMonitorControllerOptions,
) : any {
  const backgroundProcessStatus: any = ref<BackgroundProcessStatus | null>(null);
  const monitorAlertState: any = ref<MonitorAlertState | null>(null);
  const monitorAlertConfigText: any = ref("");

  const backgroundProcesses: any = computed(() : any => backgroundProcessStatus.value?.processes || []);
  const backgroundSupervisorLabel: any = computed(() : any => {
    const status: any = backgroundProcessStatus.value;
    if (!status) {
      return "未读取";
    }
    if (!status.supervisor.alive) {
      return "守护进程离线";
    }
    return status.ok ? "正常" : "降级";
  });
  const backgroundRunningCount: any = computed(
    () : any => backgroundProcesses.value.filter((item?: any) : any => item.alive && !item.stale).length,
  );
  const monitorAlertSummary: any = computed(() : any => monitorAlertState.value?.summary || {
    activeCount: 0,
    visibleCount: 0,
    recoveredCount: 0,
    criticalCount: 0,
    warningCount: 0,
    historyCount: 0,
  });
  const activeMonitorAlerts: any = computed(() : any => monitorAlertState.value?.activeAlerts || []);
  const recentMonitorAlertHistory: any = computed(() : any => (monitorAlertState.value?.history || []).slice(0, 8));
  const workQueueObservationState: any = computed(() : any => monitorAlertState.value?.workQueueObservation || null);
  const workQueueRows: any = computed<WorkQueueRow[]>(() : any => {
    const rows: WorkQueueRow[] = [];

    for (const job of options.consoleState.value?.jobs.items || []) {
      const registration: any = job.unifiedRegistration;
      const relations: any = registration?.relations || {};
      const attributes: any = registration?.attributes || {};
      const queueId: any = job.queueId || "";
      rows.push({
        rowId: `split-job:${job.id}`,
        queueId: queueId || `job:${job.id}`,
        kind: "import_parse_job",
        label: registration?.label || `导入解析任务 ${job.id}`,
        ownerId: job.id,
        source: "split-job",
        sourceLabel: registration?.source === "jobs" ? "服务端任务" : registration?.source || "服务端任务",
        lifecycleStatus: registration?.status || job.status,
        status: job.status,
        phase: String(attributes.stage || job.stage || job.status),
        tone: registration?.tone || queueLifecycleTone(job.status),
        startedAt: job.startedAt || job.createdAt || "",
        updatedAt: job.finishedAt || registration?.registeredAt || job.updatedAt || "",
        lastHeartbeatAt: job.updatedAt || "",
        checkpointTreeId: String(relations.checkpointTreeId || job.checkpointTreeId || ""),
        detail: `进度 ${job.progressPercent}% · ${job.stage || "无阶段信息"}`,
        registration,
      });
    }

    const activeRank: any = (row: WorkQueueRow) : any =>
      ["interrupted", "failed"].includes(row.status) || row.lifecycleStatus === "interrupted"
        ? 0
        : ["running", "queued", "awaiting_approval", "open"].includes(row.status) || row.lifecycleStatus === "open"
          ? 1
          : row.lifecycleStatus === "recovered"
            ? 2
            : 3;
    return rows.sort((left?: any, right?: any) : any => {
      const rankDelta: any = activeRank(left) - activeRank(right);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      return Date.parse(right.updatedAt || right.startedAt || "") - Date.parse(left.updatedAt || left.startedAt || "");
    });
  });
  const workQueueSummary: any = computed(() : any => ({
    total: workQueueRows.value.length,
    active: workQueueRows.value.filter((row?: any) : any =>
      ["queued", "running", "awaiting_approval"].includes(row.status) || row.lifecycleStatus === "open",
    ).length,
    interrupted: workQueueRows.value.filter((row?: any) : any => row.lifecycleStatus === "interrupted" || row.status === "interrupted").length,
    recovered: workQueueRows.value.filter((row?: any) : any => row.lifecycleStatus === "recovered" || row.status === "recovered").length,
  }));

  async function acknowledgeMonitorAlert(alertId: string) : Promise<any> {
    if (!options.canAdminOperations.value) {
      options.error.value = "当前账号没有维护配置权限。";
      return;
    }
    options.setBusy(`monitor-alert:ack:${alertId}`);
    options.error.value = "";
    try {
      const state: any = await acknowledgeMonitorAlertRequest(alertId);
      monitorAlertState.value = state;
      monitorAlertConfigText.value = jsonPreview(state.config);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "确认报警失败。";
    } finally {
      options.clearBusy(`monitor-alert:ack:${alertId}`);
    }
  }

  async function recoverBackgroundSupervisor() : Promise<any> {
    if (!options.canAdminOperations.value) {
      options.error.value = "当前账号没有维护配置权限。";
      return;
    }
    options.setBusy("background-supervisor:recover");
    options.error.value = "";
    try {
      const response: any = await recoverBackgroundSupervisorRequest();
      if (response.backgroundProcessStatus) {
        backgroundProcessStatus.value = response.backgroundProcessStatus;
      } else {
        backgroundProcessStatus.value = await getBackgroundProcesses();
      }
      if (response.monitorAlertState) {
        monitorAlertState.value = response.monitorAlertState;
        monitorAlertConfigText.value = jsonPreview(response.monitorAlertState.config);
      } else {
        const state: any = await getMonitorAlerts();
        monitorAlertState.value = state;
        monitorAlertConfigText.value = jsonPreview(state.config);
      }
      if (!response.recovery?.ok) {
        const reason: any = response.recovery?.reason || response.recovery?.action || "unknown";
        options.error.value = `拉起后台 Worker 管理进程未成功：${reason}`;
      }
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "拉起后台 Worker 管理进程失败。";
    } finally {
      options.clearBusy("background-supervisor:recover");
    }
  }

  async function refreshBackgroundProcesses(refreshOptions: { silent?: boolean } = {}) : Promise<any> {
    if (!options.canReadOperations.value) {
      return;
    }
    if (!refreshOptions.silent) {
      options.setBusy("background-processes:refresh");
    }
    options.error.value = "";
    try {
      backgroundProcessStatus.value = await getBackgroundProcesses();
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新后台进程状态失败。";
    } finally {
      if (!refreshOptions.silent) {
        options.clearBusy("background-processes:refresh");
      }
    }
  }

  async function refreshMonitorAlerts(refreshOptions: { silent?: boolean } = {}) : Promise<any> {
    if (!options.canReadOperations.value) {
      return;
    }
    if (!refreshOptions.silent) {
      options.setBusy("monitor-alerts:refresh");
    }
    options.error.value = "";
    try {
      const state: any = await getMonitorAlerts();
      monitorAlertState.value = state;
      monitorAlertConfigText.value = jsonPreview(state.config);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新监控报警失败。";
    } finally {
      if (!refreshOptions.silent) {
        options.clearBusy("monitor-alerts:refresh");
      }
    }
  }

  async function saveMonitorAlertConfig() : Promise<any> {
    if (!options.canAdminOperations.value) {
      options.error.value = "当前账号没有维护配置权限。";
      return;
    }
    options.setBusy("monitor-alerts:save");
    options.error.value = "";
    try {
      const parsed: any = JSON.parse(monitorAlertConfigText.value || "{}");
      const state: any = await saveMonitorAlertConfigRequest(parsed);
      monitorAlertState.value = state;
      monitorAlertConfigText.value = jsonPreview(state.config);
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "保存监控报警配置失败。";
    } finally {
      options.clearBusy("monitor-alerts:save");
    }
  }

  return {
    acknowledgeMonitorAlert,
    activeMonitorAlerts,
    backgroundProcesses,
    backgroundProcessStatus,
    backgroundRunningCount,
    backgroundSupervisorLabel,
    monitorAlertConfigText,
    monitorAlertState,
    monitorAlertSummary,
    recentMonitorAlertHistory,
    refreshBackgroundProcesses,
    refreshMonitorAlerts,
    recoverBackgroundSupervisor,
    saveMonitorAlertConfig,
    workQueueRows,
    workQueueObservationState,
    workQueueSummary,
  };
}
