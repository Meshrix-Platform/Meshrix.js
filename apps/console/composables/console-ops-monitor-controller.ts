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
  MaintenanceAgentRun,
  MonitorAlertState,
  ServerConsoleState,
} from "../lib/types";
import type { WorkQueueRow } from "../types/app";
import { jsonPreview } from "./console-format-utils";
import {
  maintenanceAgentRiskLabel,
  queueLifecycleTone,
} from "./console-status-utils";

type ConsoleOpsMonitorControllerOptions = {
  allMaintenanceAgentRuns: ComputedRef<MaintenanceAgentRun[]>;
  canAdminMaintenanceAgent: ComputedRef<boolean>;
  canReadMaintenanceAgent: ComputedRef<boolean>;
  clearAllBusy: () => void;
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleOpsMonitorController(
  options: ConsoleOpsMonitorControllerOptions,
) {
  const backgroundProcessStatus = ref<BackgroundProcessStatus | null>(null);
  const monitorAlertState = ref<MonitorAlertState | null>(null);
  const monitorAlertConfigText = ref("");

  const backgroundProcesses = computed(() => backgroundProcessStatus.value?.processes || []);
  const backgroundSupervisorLabel = computed(() => {
    const status = backgroundProcessStatus.value;
    if (!status) {
      return "未读取";
    }
    if (!status.supervisor.alive) {
      return "守护进程离线";
    }
    return status.ok ? "正常" : "降级";
  });
  const backgroundRunningCount = computed(
    () => backgroundProcesses.value.filter((item) => item.alive && !item.stale).length,
  );
  const monitorAlertSummary = computed(() => monitorAlertState.value?.summary || {
    activeCount: 0,
    visibleCount: 0,
    recoveredCount: 0,
    criticalCount: 0,
    warningCount: 0,
    historyCount: 0,
  });
  const activeMonitorAlerts = computed(() => monitorAlertState.value?.activeAlerts || []);
  const recentMonitorAlertHistory = computed(() => (monitorAlertState.value?.history || []).slice(0, 8));
  const workQueueObservationState = computed(() => monitorAlertState.value?.workQueueObservation || null);
  const workQueueRows = computed<WorkQueueRow[]>(() => {
    const rows: WorkQueueRow[] = [];

    for (const job of options.consoleState.value?.jobs.items || []) {
      const registration = job.unifiedRegistration;
      const relations = registration?.relations || {};
      const attributes = registration?.attributes || {};
      const queueId = job.queueId || "";
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

    for (const run of options.allMaintenanceAgentRuns.value) {
      const registration = run.unifiedRegistration;
      const relations = registration?.relations || {};
      const attributes = registration?.attributes || {};
      rows.push({
        rowId: registration?.registrationId || `maintenance-agent:${run.runId}`,
        queueId: String(relations.queueId || `maintenance:${run.runId}`),
        kind: String(attributes.taskType || "maintenance_agent_run"),
        label: registration?.label || run.summary || run.intent || `智能巡检任务 ${run.runId}`,
        ownerId: run.runId,
        source: "maintenance-agent",
        sourceLabel: registration?.source === "maintenance-agent" ? "智能巡检" : registration?.source || "智能巡检",
        lifecycleStatus: registration?.status || run.status,
        status: run.status,
        phase: String(attributes.stage || run.status),
        tone: registration?.tone || queueLifecycleTone(run.status),
        startedAt: run.startedAt || run.createdAt || "",
        updatedAt: run.completedAt || registration?.registeredAt || run.updatedAt || "",
        lastHeartbeatAt: run.updatedAt || "",
        checkpointTreeId: "",
        detail: `${maintenanceAgentRiskLabel(run.risk)} · ${run.plan?.summary || run.intent || "智能巡检"}`,
        registration,
      });
    }

    const activeRank = (row: WorkQueueRow) =>
      ["interrupted", "failed"].includes(row.status) || row.lifecycleStatus === "interrupted"
        ? 0
        : ["running", "queued", "awaiting_approval", "open"].includes(row.status) || row.lifecycleStatus === "open"
          ? 1
          : row.lifecycleStatus === "recovered"
            ? 2
            : 3;
    return rows.sort((left, right) => {
      const rankDelta = activeRank(left) - activeRank(right);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      return Date.parse(right.updatedAt || right.startedAt || "") - Date.parse(left.updatedAt || left.startedAt || "");
    });
  });
  const workQueueSummary = computed(() => ({
    total: workQueueRows.value.length,
    active: workQueueRows.value.filter((row) =>
      ["queued", "running", "awaiting_approval"].includes(row.status) || row.lifecycleStatus === "open",
    ).length,
    interrupted: workQueueRows.value.filter((row) => row.lifecycleStatus === "interrupted" || row.status === "interrupted").length,
    recovered: workQueueRows.value.filter((row) => row.lifecycleStatus === "recovered" || row.status === "recovered").length,
  }));

  async function acknowledgeMonitorAlert(alertId: string) {
    if (!options.canAdminMaintenanceAgent.value) {
      options.error.value = "当前账号没有维护配置权限。";
      return;
    }
    options.setBusy(`monitor-alert:ack:${alertId}`);
    options.error.value = "";
    try {
      const state = await acknowledgeMonitorAlertRequest(alertId);
      monitorAlertState.value = state;
      monitorAlertConfigText.value = jsonPreview(state.config);
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "确认报警失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function recoverBackgroundSupervisor() {
    if (!options.canAdminMaintenanceAgent.value) {
      options.error.value = "当前账号没有维护配置权限。";
      return;
    }
    options.setBusy("background-supervisor:recover");
    options.error.value = "";
    try {
      const response = await recoverBackgroundSupervisorRequest();
      if (response.backgroundProcessStatus) {
        backgroundProcessStatus.value = response.backgroundProcessStatus;
      } else {
        backgroundProcessStatus.value = await getBackgroundProcesses();
      }
      if (response.monitorAlertState) {
        monitorAlertState.value = response.monitorAlertState;
        monitorAlertConfigText.value = jsonPreview(response.monitorAlertState.config);
      } else {
        const state = await getMonitorAlerts();
        monitorAlertState.value = state;
        monitorAlertConfigText.value = jsonPreview(state.config);
      }
      if (!response.recovery?.ok) {
        const reason = response.recovery?.reason || response.recovery?.action || "unknown";
        options.error.value = `拉起后台 Worker 管理进程未成功：${reason}`;
      }
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "拉起后台 Worker 管理进程失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function refreshBackgroundProcesses(refreshOptions: { silent?: boolean } = {}) {
    if (!options.canReadMaintenanceAgent.value) {
      return;
    }
    if (!refreshOptions.silent) {
      options.setBusy("background-processes:refresh");
    }
    options.error.value = "";
    try {
      backgroundProcessStatus.value = await getBackgroundProcesses();
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新后台进程状态失败。";
    } finally {
      if (!refreshOptions.silent) {
        options.clearAllBusy();
      }
    }
  }

  async function refreshMonitorAlerts(refreshOptions: { silent?: boolean } = {}) {
    if (!options.canReadMaintenanceAgent.value) {
      return;
    }
    if (!refreshOptions.silent) {
      options.setBusy("monitor-alerts:refresh");
    }
    options.error.value = "";
    try {
      const state = await getMonitorAlerts();
      monitorAlertState.value = state;
      monitorAlertConfigText.value = jsonPreview(state.config);
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新监控报警失败。";
    } finally {
      if (!refreshOptions.silent) {
        options.clearAllBusy();
      }
    }
  }

  async function saveMonitorAlertConfig() {
    if (!options.canAdminMaintenanceAgent.value) {
      options.error.value = "当前账号没有维护配置权限。";
      return;
    }
    options.setBusy("monitor-alerts:save");
    options.error.value = "";
    try {
      const parsed = JSON.parse(monitorAlertConfigText.value || "{}");
      const state = await saveMonitorAlertConfigRequest(parsed);
      monitorAlertState.value = state;
      monitorAlertConfigText.value = jsonPreview(state.config);
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "保存监控报警配置失败。";
    } finally {
      options.clearAllBusy();
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
