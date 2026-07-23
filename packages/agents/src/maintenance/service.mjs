import {
  MAINTENANCE_RUNBOOK_CATALOG,
  getMaintenanceAgentConfigPath,
  loadMaintenanceAgentConfig,
  saveMaintenanceAgentConfig
} from "./config.mjs";
import { createMaintenanceAgentAuditStore } from "./audit-store.mjs";
import { createMaintenancePlanner } from "./planner.mjs";
import { createMaintenanceToolRegistry } from "./tool-registry.mjs";
import { createMaintenanceRunExecutor } from "./execution.mjs";
import { createMaintenanceRunbookPlanning } from "./runbook-planning.mjs";
import { createMaintenanceScheduler } from "./scheduler.mjs";
import {
  EVENT_TYPES,
  cloneRun,
  normalizeConfigNextRunAt,
  nowIso,
  publicActor,
  summarizeRun
} from "./reporting.mjs";
import {
  assertRunApprovalAllowed,
  isTerminalRunStatus,
  shouldKeepInMemoryRun
} from "./validation.mjs";
import {
  getRuntimeLogger,
  summarizeForLog
} from "@lico/foundation/observability/runtime-logger";

export function createMaintenanceAgentService({
  userDataPath,
  runtime,
  jobManager,
  protocolEventBus = null,
  getDiscoveryState = () => ({}),
  getListenUrl = () => "",
  contextRuntime = null,
  loadRuntimeSettings,
  getControllers = () => null,
  operationDispatcher,
  operationAuditStore = null,
  operationConcurrencyScope = undefined,
  operationPermissionStore: incomingOperationPermissionStore = null,
  workQueuePort = null,
  schedulerEnabled = process.env.LICO_MAINTENANCE_WORKER_EXTERNAL !== "1",
  logger = getRuntimeLogger()
}) {
  const auditStore = createMaintenanceAgentAuditStore({ userDataPath });
  if (!incomingOperationPermissionStore ||
      typeof incomingOperationPermissionStore.appendExecution !== "function" ||
      typeof incomingOperationPermissionStore.appendMetric !== "function" ||
      typeof incomingOperationPermissionStore.close !== "function") {
    throw new TypeError("Maintenance agent requires a durable operationPermissionStore.");
  }
  const operationPermissionStore = incomingOperationPermissionStore;
  const toolRegistry = createMaintenanceToolRegistry({
    userDataPath,
    runtime,
    jobManager,
    getDiscoveryState,
    getListenUrl,
    getControllers,
    operationDispatcher,
    operationAuditStore,
    operationConcurrencyScope,
    logger
  });
  const planner = createMaintenancePlanner({
    userDataPath,
    toolRegistry,
    contextRuntime,
    loadRuntimeSettings
  });
  const runs = new Map();
  const state = {
    activeRunId: "",
    started: false,
    closed: false
  };
  let config = null;
  let closePromise = null;

  function logMaintenance(level, event, details = {}) {
    if (!logger || typeof logger[level] !== "function") {
      return;
    }
    logger[level](event, {
      schedulerEnabled,
      activeRunId: state.activeRunId,
      queuedRunCount: [...runs.values()].filter((run) => run.status === "queued").length,
      started: state.started,
      closed: state.closed,
      ...details
    });
  }

  logMaintenance("info", "maintenance.agent.service.created", {
    userDataPath
  });

  async function publish(topic, payload, type = topic) {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return null;
    }
    return protocolEventBus.publish(topic, payload, { type });
  }

  async function audit(entry) {
    logMaintenance("debug", "maintenance.agent.audit.append.requested", {
      action: entry?.action || "",
      runId: entry?.runId || "",
      stepId: entry?.stepId || "",
      status: entry?.status || "",
      risk: entry?.risk || ""
    });
    const result = await auditStore.appendAudit(entry);
    const run = entry?.runId ? runs.get(entry.runId) : null;
    if (run) {
      run.auditIds.push(result.auditId);
    }
    logMaintenance("debug", "maintenance.agent.audit.appended", {
      auditId: result.auditId,
      action: entry?.action || "",
      runId: entry?.runId || ""
    });
    return result;
  }

  async function saveRun(run) {
    run.updatedAt = nowIso();
    runs.set(run.runId, run);
    await auditStore.appendRunSnapshot(run);
    logMaintenance("debug", "maintenance.agent.run.snapshot_saved", {
      runId: run.runId,
      status: run.status,
      risk: run.risk,
      stepSummary: summarizeRun(run).stepSummary
    });
    return run;
  }

  async function ensureStarted() {
    if (!state.started) {
      await start();
    }
  }

  async function refreshRunsFromStore() {
    const restoredRuns = await auditStore.listLatestRuns({ limit: 500 });
    for (const run of restoredRuns) {
      const current = runs.get(run.runId);
      if (shouldKeepInMemoryRun({ current })) {
        continue;
      }
      runs.set(run.runId, run);
    }
  }

  const executor = createMaintenanceRunExecutor({
    toolRegistry,
    operationPermissionStore,
    workQueuePort,
    logMaintenance,
    publish,
    audit,
    saveRun,
    runs,
    state
  });
  const planning = createMaintenanceRunbookPlanning({
    planner,
    getConfig: () => config,
    ensureStarted,
    saveRun,
    publish,
    audit,
    enqueueRun: executor.enqueueRun,
    getRun: (runId) => runs.get(runId) || null,
    logMaintenance
  });
  const scheduler = createMaintenanceScheduler({
    userDataPath,
    schedulerEnabled,
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
    ensureStarted,
    createScheduledRun: planning.createScheduledRun,
    publish,
    logMaintenance,
    state
  });

  async function start() {
    if (state.started) {
      logMaintenance("debug", "maintenance.agent.start.skipped", {
        reason: "already_started"
      });
      return;
    }
    logMaintenance("info", "maintenance.agent.start.requested", {});
    config = normalizeConfigNextRunAt(await loadMaintenanceAgentConfig(userDataPath));
    const restoredRuns = await auditStore.listLatestRuns({ limit: 500 });
    for (const run of restoredRuns) {
      runs.set(run.runId, run);
    }
    state.started = true;
    for (const run of restoredRuns) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "queued";
        run.error = "";
        await saveRun(run);
        await executor.resumeRun(run);
      }
    }
    if (config.enabled) {
      await saveMaintenanceAgentConfig(userDataPath, config);
    }
    if (schedulerEnabled) {
      scheduler.startScheduler();
    }
    logMaintenance("info", "maintenance.agent.started", {
      enabled: config.enabled,
      restoredRunCount: restoredRuns.length,
      scheduleCount: config.schedules?.length || 0
    });
  }

  async function getConfig() {
    logMaintenance("info", "maintenance.agent.config.get.requested", {});
    await ensureStarted();
    return {
      path: getMaintenanceAgentConfigPath(userDataPath),
      config,
      runbookCatalog: Object.values(MAINTENANCE_RUNBOOK_CATALOG)
    };
  }

  async function setConfig(input = {}, { authSession = null } = {}) {
    logMaintenance("info", "maintenance.agent.config.set.requested", {
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    config = normalizeConfigNextRunAt(await saveMaintenanceAgentConfig(userDataPath, input));
    await saveMaintenanceAgentConfig(userDataPath, config);
    scheduler.resetScheduler();
    await publish("maintenance.agent.config", { config }, "maintenance.agent.config.updated");
    await audit({
      action: "config.updated",
      status: "ok",
      risk: "safe_write",
      actor: publicActor(authSession),
      details: {
        enabled: config.enabled,
        plannerMode: config.plannerMode,
        autoApproveRisk: config.autoApproveRisk,
        schedules: config.schedules
      }
    });
    logMaintenance("info", "maintenance.agent.config.updated", {
      enabled: config.enabled,
      plannerMode: config.plannerMode,
      autoApproveRisk: config.autoApproveRisk,
      scheduleCount: config.schedules?.length || 0
    });
    return {
      config
    };
  }

  async function listRuns({ limit = 50 } = {}) {
    logMaintenance("debug", "maintenance.agent.runs.list.requested", {
      limit
    });
    await ensureStarted();
    await refreshRunsFromStore();
    return {
      items: [...runs.values()]
        .sort((left, right) =>
          String(right.updatedAt || right.createdAt || "").localeCompare(
            String(left.updatedAt || left.createdAt || "")
          )
        )
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)))
        .map((run) => cloneRun(run)),
      activeRunId: state.activeRunId,
      queuedRunIds: [...runs.values()]
        .filter((run) => run.status === "queued")
        .map((run) => run.runId)
    };
  }

  async function getRun(runId) {
    logMaintenance("debug", "maintenance.agent.run.get.requested", {
      runId
    });
    await ensureStarted();
    await refreshRunsFromStore();
    return cloneRun(runs.get(String(runId || "")) || null);
  }

  async function approveRun(runId, input = {}, { authSession = null } = {}) {
    logMaintenance("warn", "maintenance.agent.approve.requested", {
      runId,
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const run = runs.get(String(runId || ""));
    if (!run) {
      return null;
    }
    assertRunApprovalAllowed(run, input);
    run.requiresApproval = false;
    run.status = "queued";
    run.approvedAt = nowIso();
    run.approvedBy = publicActor(authSession);
    await saveRun(run);
    await audit({
      action: "approval.approved",
      runId: run.runId,
      status: "approved",
      risk: run.risk,
      actor: run.approvedBy,
      details: {
        planHash: run.planHash
      }
    });
    logMaintenance("info", "maintenance.agent.approved", {
      runId: run.runId,
      planHash: run.planHash,
      approvedBy: run.approvedBy
    });
    return executor.enqueueRun(run, { wait: input.wait !== false });
  }

  async function cancelRun(runId, input = {}, { authSession = null } = {}) {
    logMaintenance("warn", "maintenance.agent.cancel.requested", {
      runId,
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const run = runs.get(String(runId || ""));
    if (!run) {
      return null;
    }
    if (isTerminalRunStatus(run.status)) {
      return cloneRun(run);
    }
    run.cancelRequested = true;
    if (run.status !== "running") {
      run.status = "cancelled";
      run.completedAt = nowIso();
    }
    await saveRun(run);
    await executor.cancelRun(run);
    await audit({
      action: "run.cancelled",
      runId: run.runId,
      status: run.status,
      risk: run.risk,
      actor: publicActor(authSession),
      details: {
        reason: input.reason || ""
      }
    });
    await publish(EVENT_TYPES.runCompleted, { run: cloneRun(run) });
    logMaintenance("warn", "maintenance.agent.cancelled", {
      runId: run.runId,
      status: run.status
    });
    return cloneRun(run);
  }

  async function getConsoleSummary() {
    logMaintenance("debug", "maintenance.agent.console_summary.requested", {});
    await ensureStarted();
    await refreshRunsFromStore();
    const runList = await listRuns({ limit: 8 });
    const pendingApprovalCount = runList.items.filter((run) => run.status === "awaiting_approval").length;
    const nextRunAt = (config.schedules || [])
      .filter((schedule) => schedule.enabled && schedule.nextRunAt)
      .map((schedule) => schedule.nextRunAt)
      .sort()[0] || "";
    return {
      config,
      tools: toolRegistry.listTools(),
      latestRun: runList.items[0] || null,
      runs: runList.items,
      activeRunId: state.activeRunId,
      queuedRunIds: [...runs.values()]
        .filter((run) => run.status === "queued")
        .map((run) => run.runId),
      pendingApprovalCount,
      nextRunAt,
      auditPath: auditStore.auditPath,
      runsPath: auditStore.runsPath
    };
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      logMaintenance("info", "maintenance.agent.close.started", {});
      state.closed = true;
      scheduler.stopScheduler();
      await executor.prepareClose();
      operationPermissionStore.close();
      logMaintenance("info", "maintenance.agent.close.completed", {});
    })().catch((error) => {
      closePromise = null;
      throw error;
    });
    return closePromise;
  }

  return {
    start,
    close,
    getConfig,
    setConfig,
    chat: planning.chat,
    startRun: planning.startRun,
    listRuns,
    getRun,
    approveRun,
    cancelRun,
    getConsoleSummary,
    async dispatchQueuedRun(runId) {
      await ensureStarted();
      return executor.dispatchQueuedRun(String(runId || ""));
    },
    tickScheduler: scheduler.tickScheduler,
    toolRegistry
  };
}
