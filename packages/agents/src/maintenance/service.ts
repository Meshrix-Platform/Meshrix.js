import {
  MAINTENANCE_RUNBOOK_CATALOG,
  getMaintenanceAgentConfigPath,
  loadMaintenanceAgentConfig,
  saveMaintenanceAgentConfig
} from "./config.ts";
import { createMaintenanceAgentAuditStore } from "./audit-store.ts";
import { createMaintenancePlanner } from "./planner.ts";
import { createMaintenanceToolRegistry } from "./tool-registry.ts";
import { createMaintenanceRunExecutor } from "./execution.ts";
import { createMaintenanceRunbookPlanning } from "./runbook-planning.ts";
import { createMaintenanceScheduler } from "./scheduler.ts";
import {
  EVENT_TYPES,
  cloneRun,
  normalizeConfigNextRunAt,
  nowIso,
  publicActor,
  summarizeRun
} from "./reporting.ts";
import {
  assertRunApprovalAllowed,
  isTerminalRunStatus,
  shouldKeepInMemoryRun
} from "./validation.ts";
import {
  getRuntimeLogger,
  summarizeForLog
} from "@meshrix/foundation/observability/runtime-logger";
import { createMaintenanceAuthorizationAuthority } from "./authorization.ts";

export function createMaintenanceAgentService({
  userDataPath,
  runtime,
  jobManager,
  protocolEventBus = null,
  getDiscoveryState = () : any => ({}),
  getListenUrl = () : any => "",
  contextRuntime = null,
  loadRuntimeSettings,
  getControllers = () : any => null,
  operationDispatcher,
  operationAuditStore = null,
  operationProofSubstrate = null,
  operationConcurrencyScope = undefined,
  operationPermissionStore: incomingOperationPermissionStore = null,
  maintenanceAuthorizationAuthority: incomingMaintenanceAuthorizationAuthority = null,
  getGovernancePolicyRevision = null,
  workQueuePort = null,
  schedulerEnabled = process.env.MESHRIX_MAINTENANCE_WORKER_EXTERNAL !== "1",
  logger = getRuntimeLogger()
}: Record<string, any>) : any {
  const auditStore: any = createMaintenanceAgentAuditStore({ userDataPath });
  if (!incomingOperationPermissionStore ||
      typeof incomingOperationPermissionStore.appendExecution !== "function" ||
      typeof incomingOperationPermissionStore.appendMetric !== "function" ||
      typeof incomingOperationPermissionStore.close !== "function") {
    throw new TypeError("Maintenance agent requires a durable operationPermissionStore.");
  }
  const operationPermissionStore: any = incomingOperationPermissionStore;
  const maintenanceAuthorizationAuthority: any =
    incomingMaintenanceAuthorizationAuthority ||
    createMaintenanceAuthorizationAuthority({
      operationPermissionStore,
      getGovernancePolicyRevision
    });
  const toolRegistry: any = createMaintenanceToolRegistry({
    userDataPath,
    runtime,
    jobManager,
    getDiscoveryState,
    getListenUrl,
    getControllers,
    operationDispatcher,
    operationAuditStore,
    operationProofSubstrate,
    revalidateMaintenanceAuthorization: maintenanceAuthorizationAuthority.revalidate,
    operationConcurrencyScope,
    logger
  });
  const planner: any = createMaintenancePlanner({
    userDataPath,
    toolRegistry,
    contextRuntime,
    loadRuntimeSettings
  });
  const runs: any = new Map<any, any>();
  const state: Record<string, any> = {
    activeRunId: "",
    started: false,
    closed: false
  };
  let config: any = null;
  let closePromise: any = null;

  function logMaintenance(level?: any, event?: any, details: Record<string, any> = {}) : any {
    if (!logger || typeof logger[level] !== "function") {
      return;
    }
    logger[level](event, {
      schedulerEnabled,
      activeRunId: state.activeRunId,
      queuedRunCount: [...runs.values()].filter((run?: any) : any => run.status === "queued").length,
      started: state.started,
      closed: state.closed,
      ...details
    });
  }

  logMaintenance("info", "maintenance.agent.service.created", {
    userDataPath
  });

  async function publish(topic?: any, payload?: any, type: any = topic) : Promise<any> {
    if (!protocolEventBus || typeof protocolEventBus.publish !== "function") {
      return null;
    }
    return protocolEventBus.publish(topic, payload, { type });
  }

  async function audit(entry?: any) : Promise<any> {
    logMaintenance("debug", "maintenance.agent.audit.append.requested", {
      action: entry?.action || "",
      runId: entry?.runId || "",
      stepId: entry?.stepId || "",
      status: entry?.status || "",
      risk: entry?.risk || ""
    });
    const result: any = await auditStore.appendAudit(entry);
    const run: any = entry?.runId ? runs.get(entry.runId) : null;
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

  async function saveRun(run?: any) : Promise<any> {
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

  async function ensureStarted() : Promise<any> {
    if (!state.started) {
      await start();
    }
  }

  async function refreshRunsFromStore() : Promise<any> {
    const restoredRuns: any = await auditStore.listLatestRuns({ limit: 500 });
    for (const run of restoredRuns) {
      const current: any = runs.get(run.runId);
      if (shouldKeepInMemoryRun({ current })) {
        continue;
      }
      runs.set(run.runId, run);
    }
  }

  const executor: any = createMaintenanceRunExecutor({
    toolRegistry,
    operationPermissionStore,
    maintenanceAuthorizationAuthority,
    workQueuePort,
    logMaintenance,
    publish,
    audit,
    saveRun,
    runs,
    state
  });
  const planning: any = createMaintenanceRunbookPlanning({
    planner,
    getConfig: () : any => config,
    ensureStarted,
    saveRun,
    publish,
    audit,
    enqueueRun: executor.enqueueRun,
    captureAuthorization: maintenanceAuthorizationAuthority.capture,
    getRun: (runId?: any) : any => runs.get(runId) || null,
    logMaintenance
  });
  const scheduler: any = createMaintenanceScheduler({
    userDataPath,
    schedulerEnabled,
    getConfig: () : any => config,
    setConfig: (nextConfig?: any) : any => {
      config = nextConfig;
    },
    ensureStarted,
    createScheduledRun: planning.createScheduledRun,
    publish,
    logMaintenance,
    state
  });

  async function start() : Promise<any> {
    if (state.started) {
      logMaintenance("debug", "maintenance.agent.start.skipped", {
        reason: "already_started"
      });
      return;
    }
    logMaintenance("info", "maintenance.agent.start.requested", {});
    config = normalizeConfigNextRunAt(await loadMaintenanceAgentConfig(userDataPath));
    const restoredRuns: any = await auditStore.listLatestRuns({ limit: 500 });
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

  async function getConfig() : Promise<any> {
    logMaintenance("info", "maintenance.agent.config.get.requested", {});
    await ensureStarted();
    return {
      path: getMaintenanceAgentConfigPath(userDataPath),
      config,
      runbookCatalog: (Object.values(MAINTENANCE_RUNBOOK_CATALOG) as any[])
    };
  }

  async function setConfig(input: Record<string, any> = {}, { authSession = null }: Record<string, any> = {}) : Promise<any> {
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
        workloadGrantConfigured: Boolean(config.workloadGrantId),
        schedules: config.schedules
      }
    });
    logMaintenance("info", "maintenance.agent.config.updated", {
      enabled: config.enabled,
      plannerMode: config.plannerMode,
      autoApproveRisk: config.autoApproveRisk,
      workloadGrantConfigured: Boolean(config.workloadGrantId),
      scheduleCount: config.schedules?.length || 0
    });
    return {
      config
    };
  }

  async function listRuns({ limit = 50 }: Record<string, any> = {}) : Promise<any> {
    logMaintenance("debug", "maintenance.agent.runs.list.requested", {
      limit
    });
    await ensureStarted();
    await refreshRunsFromStore();
    return {
      items: [...runs.values()]
        .sort((left?: any, right?: any) : any =>
          String(right.updatedAt || right.createdAt || "").localeCompare(
            String(left.updatedAt || left.createdAt || "")
          )
        )
        .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)))
        .map((run?: any) : any => cloneRun(run)),
      activeRunId: state.activeRunId,
      queuedRunIds: [...runs.values()]
        .filter((run?: any) : any => run.status === "queued")
        .map((run?: any) : any => run.runId)
    };
  }

  async function getRun(runId?: any) : Promise<any> {
    logMaintenance("debug", "maintenance.agent.run.get.requested", {
      runId
    });
    await ensureStarted();
    await refreshRunsFromStore();
    return cloneRun(runs.get(String(runId || "")) || null);
  }

  async function approveRun(
    runId?: any,
    input: Record<string, any> = {},
    { authSession = null, operationAuthorization = null }: Record<string, any> = {}
  ) : Promise<any> {
    logMaintenance("warn", "maintenance.agent.approve.requested", {
      runId,
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const run: any = runs.get(String(runId || ""));
    if (!run) {
      return null;
    }
    assertRunApprovalAllowed(run, input);
    await maintenanceAuthorizationAuthority.revalidate(run.authorization, {
      requiredScope: "maintenance:run",
      planHash: run.planHash
    });
    run.approvalAuthorization = await maintenanceAuthorizationAuthority.capture({
      operationAuthorization,
      requiredScope: "maintenance:approve",
      plannedOperationIds: run.plan?.steps?.map((step?: any) : any => step.toolId) || [],
      planHash: run.planHash
    });
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

  async function cancelRun(runId?: any, input: Record<string, any> = {}, { authSession = null }: Record<string, any> = {}) : Promise<any> {
    logMaintenance("warn", "maintenance.agent.cancel.requested", {
      runId,
      input: summarizeForLog(input),
      actor: publicActor(authSession)
    });
    await ensureStarted();
    const run: any = runs.get(String(runId || ""));
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

  async function getConsoleSummary() : Promise<any> {
    logMaintenance("debug", "maintenance.agent.console_summary.requested", {});
    await ensureStarted();
    await refreshRunsFromStore();
    const runList: any = await listRuns({ limit: 8 });
    const pendingApprovalCount: any = runList.items.filter((run?: any) : any => run.status === "awaiting_approval").length;
    const nextRunAt: any = (config.schedules || [])
      .filter((schedule?: any) : any => schedule.enabled && schedule.nextRunAt)
      .map((schedule?: any) : any => schedule.nextRunAt)
      .sort()[0] || "";
    return {
      config,
      tools: toolRegistry.listTools(),
      latestRun: runList.items[0] || null,
      runs: runList.items,
      activeRunId: state.activeRunId,
      queuedRunIds: [...runs.values()]
        .filter((run?: any) : any => run.status === "queued")
        .map((run?: any) : any => run.runId),
      pendingApprovalCount,
      nextRunAt,
      auditPath: auditStore.auditPath,
      runsPath: auditStore.runsPath
    };
  }

  function close() : any {
    if (closePromise) return closePromise;
    closePromise = (async () : Promise<any> => {
      logMaintenance("info", "maintenance.agent.close.started", {});
      state.closed = true;
      scheduler.stopScheduler();
      await executor.prepareClose();
      await operationPermissionStore.close();
      logMaintenance("info", "maintenance.agent.close.completed", {});
    })().catch((error?: any) : any => {
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
    async dispatchQueuedRun(runId?: any, options: Record<string, any> = {}) : Promise<any> {
      await ensureStarted();
      return executor.dispatchQueuedRun(String(runId || ""), options);
    },
    async revalidateRunAuthorization(run?: any) : Promise<any> {
      const current: any = await maintenanceAuthorizationAuthority.revalidate(
        run?.authorization,
        { requiredScope: "maintenance:run", planHash: run?.planHash }
      );
      if (run?.approvalAuthorization) {
        await maintenanceAuthorizationAuthority.revalidate(
          run.approvalAuthorization,
          { requiredScope: "maintenance:approve", planHash: run?.planHash }
        );
      }
      return current;
    },
    async denyQueuedRunAuthorization(runId?: any, reasonCode: any = "maintenance_authorization_denied") : Promise<any> {
      await ensureStarted();
      const run: any = runs.get(String(runId || ""));
      if (!run || isTerminalRunStatus(run.status)) {
        return cloneRun(run);
      }
      run.status = "rejected";
      run.error = String(reasonCode || "maintenance_authorization_denied");
      run.completedAt = nowIso();
      await saveRun(run);
      await audit({
        action: "run.authorization_denied",
        runId: run.runId,
        status: run.status,
        risk: run.risk,
        actor: run.actor,
        details: { reasonCode: run.error }
      });
      await publish(EVENT_TYPES.runCompleted, { run: cloneRun(run) });
      executor.finishWaiter(run.runId, cloneRun(run));
      return cloneRun(run);
    },
    tickScheduler: scheduler.tickScheduler,
    toolRegistry
  };
}
