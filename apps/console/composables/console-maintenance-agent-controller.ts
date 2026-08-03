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
  clearBusy: (key: string) => void;
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  modelEntryStatusKey: (entry: AgentModelConfig) => string;
  setBusy: (key: string) => void;
  visibleModelEntries: ComputedRef<AgentModelConfig[]>;
};

function cloneConfig(config: MaintenanceAgentConfig) : any {
  return JSON.parse(JSON.stringify(config)) as MaintenanceAgentConfig;
}

export function createConsoleMaintenanceAgentController(
  options: ConsoleMaintenanceAgentControllerOptions,
) : any {
  const maintenanceAgentConfig: any = ref<MaintenanceAgentConfig | null>(null);
  const maintenanceAgentRuns: any = ref<MaintenanceAgentRun[]>([]);
  const selectedMaintenanceAgentRun: any = ref<MaintenanceAgentRun | null>(null);
  const maintenanceAgentMessage: any = ref("");
  const maintenanceAgentModelAlias: any = ref("");
  const maintenanceAgentRunbook: any = ref("");
  const maintenanceAgentRunbookCatalog: any = ref<MaintenanceAgentRunbook[]>([]);
  const maintenanceAgentResultJson: any = ref("");

  const maintenanceAgentSummary: any = computed(() : any => options.consoleState.value?.maintenanceAgent || null);
  const maintenanceAgentRunbooks: any = computed(() : any => maintenanceAgentRunbookCatalog.value);
  const maintenanceAgentRunbookOptionBarOptions: any = computed<OptionBarOption[]>(() : any =>
    maintenanceAgentRunbooks.value.map((runbook?: any) : any => ({
      value: runbook.id,
      label: `${runbook.label} / ${runbook.id}`,
    })),
  );
  const maintenanceAgentSchedules: any = computed(
    () : any =>
      maintenanceAgentConfig.value?.schedules ||
      maintenanceAgentSummary.value?.config.schedules ||
      [],
  );
  const displayedMaintenanceAgentRuns: any = computed(() : any =>
    (maintenanceAgentRuns.value.length > 0
      ? maintenanceAgentRuns.value
      : maintenanceAgentSummary.value?.runs || []
    ).slice(0, 12),
  );
  const latestMaintenanceAgentRun: any = computed(
    () : any => displayedMaintenanceAgentRuns.value[0] || maintenanceAgentSummary.value?.latestRun || null,
  );
  const pendingMaintenanceApprovalCount: any = computed(
    () : any =>
      displayedMaintenanceAgentRuns.value.filter((run?: any) : any => run.status === "awaiting_approval").length ||
      maintenanceAgentSummary.value?.pendingApprovalCount ||
      0,
  );
  const nextMaintenanceAgentRunAt: any = computed(() : any => {
    const scheduled: any =
      maintenanceAgentSchedules.value
        .filter((schedule?: any) : any => schedule.enabled && schedule.nextRunAt)
        .map((schedule?: any) : any => schedule.nextRunAt)
        .sort()[0] || "";
    return scheduled || maintenanceAgentSummary.value?.nextRunAt || "";
  });
  const allMaintenanceAgentRuns: any = computed(() : any =>
    maintenanceAgentRuns.value.length > 0
      ? maintenanceAgentRuns.value
      : maintenanceAgentSummary.value?.runs || [],
  );

  function applyMaintenanceAgentStateFromConsoleState(nextState: ServerConsoleState) : any {
    maintenanceAgentConfig.value = nextState.maintenanceAgent?.config
      ? cloneConfig(nextState.maintenanceAgent.config)
      : null;
    maintenanceAgentRuns.value = nextState.maintenanceAgent?.runs || [];
    selectedMaintenanceAgentRun.value =
      maintenanceAgentRuns.value.find(
        (run?: any) : any => run.runId === selectedMaintenanceAgentRun.value?.runId,
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

  function patchMaintenanceAgentState(patch: Partial<MaintenanceAgentState>) : any {
    if (!options.consoleState.value) {
      return;
    }
    const previous: any = options.consoleState.value.maintenanceAgent || defaultMaintenanceAgentState();
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

  function applyMaintenanceAgentConfigFromEvent(value: unknown) : any {
    const config: any = asRecord(value) as MaintenanceAgentConfig | null;
    if (!config) {
      return false;
    }
    maintenanceAgentConfig.value = cloneConfig(config);
    patchMaintenanceAgentState({ config });
    return true;
  }

  async function refreshMaintenanceAgent(refreshOptions: { silent?: boolean } = {}) : Promise<any> {
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
          (run?: any) : any => run.runId === selectedMaintenanceAgentRun.value?.runId,
        ) ||
        maintenanceAgentRuns.value[0] ||
        null;
      patchMaintenanceAgentState({
        config: configResult.config,
        runs: runsResult.items,
        latestRun: runsResult.items[0] || null,
        activeRunId: runsResult.activeRunId,
        queuedRunIds: runsResult.queuedRunIds,
        pendingApprovalCount: runsResult.items.filter((run?: any) : any => run.status === "awaiting_approval").length,
        nextRunAt:
          (configResult.config.schedules || [])
            .filter((schedule?: any) : any => schedule.enabled && schedule.nextRunAt)
            .map((schedule?: any) : any => schedule.nextRunAt)
            .sort()[0] || "",
      });
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新智能巡检失败。";
    } finally {
      if (!refreshOptions.silent) {
        options.clearBusy("maintenance-agent:refresh");
      }
    }
  }

  async function saveMaintenanceAgentConfig() : Promise<any> {
    if (!maintenanceAgentConfig.value) {
      return;
    }
    options.setBusy("maintenance-agent:config");
    options.error.value = "";
    try {
      const result: any = await saveMaintenanceAgentConfigRequest(maintenanceAgentConfig.value);
      maintenanceAgentConfig.value = cloneConfig(result.config);
      patchMaintenanceAgentState({ config: result.config });
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "保存智能巡检配置失败。";
    } finally {
      options.clearBusy("maintenance-agent:config");
    }
  }

  function addMaintenanceAgentSchedule() : any {
    const config: any = maintenanceAgentConfig.value;
    const runbook: any = maintenanceAgentRunbookCatalog.value.find(
      (item?: any) : any => item.id === maintenanceAgentRunbook.value,
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

  function removeMaintenanceAgentSchedule(scheduleId: string) : any {
    const config: any = maintenanceAgentConfig.value;
    if (!config) return;
    config.schedules = config.schedules.filter((schedule?: any) : any => schedule.id !== scheduleId);
  }

  async function chatMaintenanceAgent() : Promise<any> {
    const message: any = maintenanceAgentMessage.value.trim();
    if (!message) {
      options.error.value = "请输入维护指令。";
      return;
    }
    options.setBusy("maintenance-agent:chat");
    options.error.value = "";
    try {
      const selectedAgent: any = options.visibleModelEntries.value.find(
        (entry?: any) : any => options.modelEntryStatusKey(entry) === maintenanceAgentModelAlias.value,
      );
      const result: any = await chatMaintenanceAgentRequest({
        message,
        modelAlias: maintenanceAgentModelAlias.value || undefined,
        agentName: selectedAgent?.agentName || selectedAgent?.label || undefined,
        wait: true,
      });
      maintenanceAgentResultJson.value = jsonPreview(result);
      selectedMaintenanceAgentRun.value = result.run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "智能巡检对话执行失败。";
    } finally {
      options.clearBusy("maintenance-agent:chat");
    }
  }

  async function runMaintenanceAgentRunbook() : Promise<any> {
    options.setBusy("maintenance-agent:run");
    options.error.value = "";
    try {
      const run: any = await startMaintenanceAgentRun({
        runbook: maintenanceAgentRunbook.value,
        wait: true,
      });
      maintenanceAgentResultJson.value = jsonPreview(run);
      selectedMaintenanceAgentRun.value = run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "维护 runbook 执行失败。";
    } finally {
      options.clearBusy("maintenance-agent:run");
    }
  }

  async function runMaintenanceAgentGatewayReview() : Promise<any> {
    maintenanceAgentRunbook.value = "failed_jobs_review";
    await runMaintenanceAgentRunbook();
  }

  async function approveMaintenanceAgentRun(run: MaintenanceAgentRun) : Promise<any> {
    options.setBusy(`maintenance-agent:approve:${run.runId}`);
    options.error.value = "";
    try {
      const result: any = await approveMaintenanceAgentRunRequest(run.runId, {
        planHash: run.planHash,
        wait: true,
      });
      maintenanceAgentResultJson.value = jsonPreview(result.run);
      selectedMaintenanceAgentRun.value = result.run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "维护计划审批失败。";
    } finally {
      options.clearBusy(`maintenance-agent:approve:${run.runId}`);
    }
  }

  async function cancelMaintenanceAgentRun(run: MaintenanceAgentRun) : Promise<any> {
    options.setBusy(`maintenance-agent:cancel:${run.runId}`);
    options.error.value = "";
    try {
      const result: any = await cancelMaintenanceAgentRunRequest(run.runId, {
        reason: "console",
      });
      maintenanceAgentResultJson.value = jsonPreview(result.run);
      selectedMaintenanceAgentRun.value = result.run;
      await refreshMaintenanceAgent({ silent: true });
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "维护运行取消失败。";
    } finally {
      options.clearBusy(`maintenance-agent:cancel:${run.runId}`);
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
