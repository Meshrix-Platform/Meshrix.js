import { computed, ref, type ComputedRef, type Ref } from "vue";
import {
  approveMaintenanceAgentRun as approveMaintenanceAgentRunRequest,
  cancelMaintenanceAgentRun as cancelMaintenanceAgentRunRequest,
  chatMaintenanceAgent as chatMaintenanceAgentRequest,
  getMaintenanceAgentConfig,
  listMaintenanceAgentRuns,
  saveMaintenanceAgentConfig as saveMaintenanceAgentConfigRequest,
  startMaintenanceAgentRun,
} from "../lib/maintenance-agent-client";
import type {
  AgentModelConfig,
  MaintenanceAgentConfig,
  MaintenanceAgentRunbook,
  MaintenanceAgentRun,
  ServerConsoleState,
} from "../lib/types";
import type { OptionBarOption } from "../types/app";
import { jsonPreview } from "./console-format-utils";
import { asRecord } from "./console-model-utils";

type MaintenanceAgentState = NonNullable<ServerConsoleState["maintenanceAgent"]>;

type ConsoleMaintenanceAgentControllerOptions = {
  canReadMaintenanceAgent: ComputedRef<boolean>;
  clearAllBusy: () => void;
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  modelEntryStatusKey: (entry: AgentModelConfig) => string;
  setBusy: (key: string) => void;
  visibleModelEntries: ComputedRef<AgentModelConfig[]>;
};

function cloneConfig(config: MaintenanceAgentConfig) {
  return JSON.parse(JSON.stringify(config)) as MaintenanceAgentConfig;
}

export function createConsoleMaintenanceAgentController(
  options: ConsoleMaintenanceAgentControllerOptions,
) {
  const maintenanceAgentConfig = ref<MaintenanceAgentConfig | null>(null);
  const maintenanceAgentRuns = ref<MaintenanceAgentRun[]>([]);
  const selectedMaintenanceAgentRun = ref<MaintenanceAgentRun | null>(null);
  const maintenanceAgentMessage = ref("");
  const maintenanceAgentModelAlias = ref("");
  const maintenanceAgentRunbook = ref("");
  const maintenanceAgentRunbookCatalog = ref<MaintenanceAgentRunbook[]>([]);
  const maintenanceAgentResultJson = ref("");

  const maintenanceAgentSummary = computed(() => options.consoleState.value?.maintenanceAgent || null);
  const maintenanceAgentRunbooks = computed(() => maintenanceAgentRunbookCatalog.value);
  const maintenanceAgentRunbookOptionBarOptions = computed<OptionBarOption[]>(() =>
    maintenanceAgentRunbooks.value.map((runbook) => ({
      value: runbook.id,
      label: `${runbook.label} / ${runbook.id}`,
    })),
  );
  const maintenanceAgentSchedules = computed(
    () =>
      maintenanceAgentConfig.value?.schedules ||
      maintenanceAgentSummary.value?.config.schedules ||
      [],
  );
  const displayedMaintenanceAgentRuns = computed(() =>
    (maintenanceAgentRuns.value.length > 0
      ? maintenanceAgentRuns.value
      : maintenanceAgentSummary.value?.runs || []
    ).slice(0, 12),
  );
  const latestMaintenanceAgentRun = computed(
    () => displayedMaintenanceAgentRuns.value[0] || maintenanceAgentSummary.value?.latestRun || null,
  );
  const pendingMaintenanceApprovalCount = computed(
    () =>
      displayedMaintenanceAgentRuns.value.filter((run) => run.status === "awaiting_approval").length ||
      maintenanceAgentSummary.value?.pendingApprovalCount ||
      0,
  );
  const nextMaintenanceAgentRunAt = computed(() => {
    const scheduled =
      maintenanceAgentSchedules.value
        .filter((schedule) => schedule.enabled && schedule.nextRunAt)
        .map((schedule) => schedule.nextRunAt)
        .sort()[0] || "";
    return scheduled || maintenanceAgentSummary.value?.nextRunAt || "";
  });
  const allMaintenanceAgentRuns = computed(() =>
    maintenanceAgentRuns.value.length > 0
      ? maintenanceAgentRuns.value
      : maintenanceAgentSummary.value?.runs || [],
  );

  function applyMaintenanceAgentStateFromConsoleState(nextState: ServerConsoleState) {
    maintenanceAgentConfig.value = nextState.maintenanceAgent?.config
      ? cloneConfig(nextState.maintenanceAgent.config)
      : null;
    maintenanceAgentRuns.value = nextState.maintenanceAgent?.runs || [];
    selectedMaintenanceAgentRun.value =
      maintenanceAgentRuns.value.find(
        (run) => run.runId === selectedMaintenanceAgentRun.value?.runId,
      ) ||
      selectedMaintenanceAgentRun.value ||
      maintenanceAgentRuns.value[0] ||
      null;
  }

  function defaultMaintenanceAgentState(): MaintenanceAgentState {
    return {
      config: maintenanceAgentConfig.value as MaintenanceAgentConfig,
      tools: [],
      latestRun: null,
      runs: [],
      activeRunId: "",
      queuedRunIds: [],
      pendingApprovalCount: 0,
      nextRunAt: "",
      auditPath: "",
      runsPath: "",
    };
  }

  function patchMaintenanceAgentState(patch: Partial<MaintenanceAgentState>) {
    if (!options.consoleState.value) {
      return;
    }
    const previous = options.consoleState.value.maintenanceAgent || defaultMaintenanceAgentState();
    if (!previous.config && !patch.config) {
      return;
    }
    options.consoleState.value = {
      ...options.consoleState.value,
      maintenanceAgent: {
        ...previous,
        ...patch,
      },
    };
  }

  function applyMaintenanceAgentConfigFromEvent(value: unknown) {
    const config = asRecord(value) as MaintenanceAgentConfig | null;
    if (!config) {
      return false;
    }
    maintenanceAgentConfig.value = cloneConfig(config);
    patchMaintenanceAgentState({ config });
    return true;
  }

  async function refreshMaintenanceAgent(refreshOptions: { silent?: boolean } = {}) {
    if (!options.canReadMaintenanceAgent.value) {
      return;
    }
    if (!refreshOptions.silent) {
      options.setBusy("maintenance-agent:refresh");
    }
    options.error.value = "";
    try {
      const [configResult, runsResult] = await Promise.all([
        getMaintenanceAgentConfig(),
        listMaintenanceAgentRuns(30),
      ]);
      maintenanceAgentConfig.value = cloneConfig(configResult.config);
      maintenanceAgentRunbookCatalog.value = configResult.runbookCatalog || [];
      maintenanceAgentRuns.value = runsResult.items;
      selectedMaintenanceAgentRun.value =
        maintenanceAgentRuns.value.find(
          (run) => run.runId === selectedMaintenanceAgentRun.value?.runId,
        ) ||
        maintenanceAgentRuns.value[0] ||
        null;
      patchMaintenanceAgentState({
        config: configResult.config,
        runs: runsResult.items,
        latestRun: runsResult.items[0] || null,
        activeRunId: runsResult.activeRunId,
        queuedRunIds: runsResult.queuedRunIds,
        pendingApprovalCount: runsResult.items.filter((run) => run.status === "awaiting_approval").length,
        nextRunAt:
          (configResult.config.schedules || [])
            .filter((schedule) => schedule.enabled && schedule.nextRunAt)
            .map((schedule) => schedule.nextRunAt)
            .sort()[0] || "",
      });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新智能巡检失败。";
    } finally {
      if (!refreshOptions.silent) {
        options.clearAllBusy();
      }
    }
  }

  async function saveMaintenanceAgentConfig() {
    if (!maintenanceAgentConfig.value) {
      return;
    }
    options.setBusy("maintenance-agent:config");
    options.error.value = "";
    try {
      const result = await saveMaintenanceAgentConfigRequest(maintenanceAgentConfig.value);
      maintenanceAgentConfig.value = cloneConfig(result.config);
      patchMaintenanceAgentState({ config: result.config });
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "保存智能巡检配置失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  function addMaintenanceAgentSchedule() {
    const config = maintenanceAgentConfig.value;
    const runbook = maintenanceAgentRunbookCatalog.value.find(
      (item) => item.id === maintenanceAgentRunbook.value,
    );
    if (!config || !runbook) return;
    config.schedules.push({
      id: `schedule_${globalThis.crypto.randomUUID()}`,
      label: runbook.label,
      enabled: false,
      runbook: runbook.id,
      intervalMinutes: Number(runbook.suggestedIntervalMinutes || 60),
      nextRunAt: "",
    });
  }

  function removeMaintenanceAgentSchedule(scheduleId: string) {
    const config = maintenanceAgentConfig.value;
    if (!config) return;
    config.schedules = config.schedules.filter((schedule) => schedule.id !== scheduleId);
  }

  async function chatMaintenanceAgent() {
    const message = maintenanceAgentMessage.value.trim();
    if (!message) {
      options.error.value = "请输入维护指令。";
      return;
    }
    options.setBusy("maintenance-agent:chat");
    options.error.value = "";
    try {
      const selectedAgent = options.visibleModelEntries.value.find(
        (entry) => options.modelEntryStatusKey(entry) === maintenanceAgentModelAlias.value,
      );
      const result = await chatMaintenanceAgentRequest({
        message,
        modelAlias: maintenanceAgentModelAlias.value || undefined,
        agentName: selectedAgent?.agentName || selectedAgent?.label || undefined,
        wait: true,
      });
      maintenanceAgentResultJson.value = jsonPreview(result);
      selectedMaintenanceAgentRun.value = result.run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "智能巡检对话执行失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function runMaintenanceAgentRunbook() {
    options.setBusy("maintenance-agent:run");
    options.error.value = "";
    try {
      const run = await startMaintenanceAgentRun({
        runbook: maintenanceAgentRunbook.value,
        wait: true,
      });
      maintenanceAgentResultJson.value = jsonPreview(run);
      selectedMaintenanceAgentRun.value = run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "维护 runbook 执行失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function runMaintenanceAgentGatewayReview() {
    maintenanceAgentRunbook.value = "failed_jobs_review";
    await runMaintenanceAgentRunbook();
  }

  async function approveMaintenanceAgentRun(run: MaintenanceAgentRun) {
    options.setBusy(`maintenance-agent:approve:${run.runId}`);
    options.error.value = "";
    try {
      const result = await approveMaintenanceAgentRunRequest(run.runId, {
        planHash: run.planHash,
        wait: true,
      });
      maintenanceAgentResultJson.value = jsonPreview(result.run);
      selectedMaintenanceAgentRun.value = result.run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "维护计划审批失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  async function cancelMaintenanceAgentRun(run: MaintenanceAgentRun) {
    options.setBusy(`maintenance-agent:cancel:${run.runId}`);
    options.error.value = "";
    try {
      const result = await cancelMaintenanceAgentRunRequest(run.runId, {
        reason: "console",
      });
      maintenanceAgentResultJson.value = jsonPreview(result.run);
      selectedMaintenanceAgentRun.value = result.run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "维护运行取消失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  return {
    allMaintenanceAgentRuns,
    addMaintenanceAgentSchedule,
    applyMaintenanceAgentConfigFromEvent,
    applyMaintenanceAgentStateFromConsoleState,
    approveMaintenanceAgentRun,
    cancelMaintenanceAgentRun,
    chatMaintenanceAgent,
    displayedMaintenanceAgentRuns,
    latestMaintenanceAgentRun,
    maintenanceAgentConfig,
    maintenanceAgentMessage,
    maintenanceAgentModelAlias,
    maintenanceAgentResultJson,
    maintenanceAgentRunbook,
    maintenanceAgentRunbookOptionBarOptions,
    maintenanceAgentRunbooks,
    maintenanceAgentRuns,
    maintenanceAgentSchedules,
    maintenanceAgentSummary,
    nextMaintenanceAgentRunAt,
    patchMaintenanceAgentState,
    pendingMaintenanceApprovalCount,
    refreshMaintenanceAgent,
    removeMaintenanceAgentSchedule,
    runMaintenanceAgentGatewayReview,
    runMaintenanceAgentRunbook,
    saveMaintenanceAgentConfig,
    selectedMaintenanceAgentRun,
  };
}
