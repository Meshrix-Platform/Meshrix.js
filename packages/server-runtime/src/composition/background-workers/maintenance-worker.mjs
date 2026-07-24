import { createMaintenanceAgentService } from "#meshrix/agents/maintenance/index";
import { createOperationPermissionStore } from "#meshrix/capabilities/operation-permission-core/store";
import { createJobManager } from "../../jobs/jobs/job-manager.mjs";
import { createProtocolEventRuntime } from "../../events/protocol-event-runtime.mjs";
import { createProtocolEventBus } from "#meshrix/protocols/pubsub/event-bus";
import { createMaintenanceWorkQueueProvider } from "../maintenance-work-queue-provider.mjs";
import { createQueueApplicationPort } from "../queue-application-port.mjs";
import {
  createServerRuntime,
  bindOperationDispatcher,
  loadSettings,
  loadDiscoveryConfig
} from "#meshrix/product-api";

class MaintenanceWorkerCloseError extends Error {
  constructor(code) {
    super("Maintenance worker resource shutdown did not complete cleanly.");
    this.name = "MaintenanceWorkerCloseError";
    this.code = code;
  }
}

export async function createMaintenanceWorkerRuntime({
  userDataPath,
  operationLockManager: injectedOperationLockManager = null
}) {
  let protocolEventBus = null;
  let protocolEventRuntime = null;
  let runtime = null;
  let jobManager = null;
  let operationPermissionStore = null;
  let maintenanceAgent = null;
  let maintenanceWorkQueue = null;
  let queueApplicationPort = null;
  let closePromise = null;

  function closeOwnedResources() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const ownerFailures = [];
      try {
        if (queueApplicationPort) await queueApplicationPort.stop();
        if (maintenanceAgent) await maintenanceAgent.close();
        if (maintenanceWorkQueue) await maintenanceWorkQueue.close();
        if (queueApplicationPort) await queueApplicationPort.close();
        if (!maintenanceAgent) operationPermissionStore?.close?.();
      } catch {
        ownerFailures.push(true);
      }
      try {
        await jobManager?.close?.();
      } catch {
        ownerFailures.push(true);
      }
      if (ownerFailures.length > 0) {
        throw new MaintenanceWorkerCloseError("maintenance_worker_shutdown_dependencies");
      }

      const dependencyFailures = [];
      for (const close of [
        () => runtime?.close?.(),
        () => protocolEventRuntime?.close?.()
      ]) {
        try {
          await close();
        } catch {
          dependencyFailures.push(true);
        }
      }
      if (dependencyFailures.length > 0) {
        throw new MaintenanceWorkerCloseError("maintenance_worker_shutdown_resources");
      }
    })().catch((error) => {
      closePromise = null;
      throw error;
    });
    return closePromise;
  }

  try {
    protocolEventRuntime = await createProtocolEventRuntime({
      userDataPath,
      createEventBus: createProtocolEventBus
    });
    protocolEventBus = protocolEventRuntime.protocolEventBus;
    runtime = await createServerRuntime({
      userDataPath,
      operationLockManager: injectedOperationLockManager
    });
    const operationConcurrencyScope = runtime.operationLockManager?.namespace || "server";
    const operationDispatcher = bindOperationDispatcher({
      lockManager: runtime.operationLockManager,
      concurrencyScope: operationConcurrencyScope
    });
    jobManager = createJobManager({
      userDataPath,
      processingEnabled: false,
      protocolEventBus
    });
    const discoveryState = await loadDiscoveryConfig(userDataPath).catch(() => ({}));
    operationPermissionStore = createOperationPermissionStore({ userDataPath });
    queueApplicationPort = await createQueueApplicationPort({ userDataPath });
    maintenanceWorkQueue = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () => maintenanceAgent,
      capabilitySelected: true,
      autoStart: false,
      consumerEnabled: true,
      dispatchOnSubmit: false
    });
    maintenanceAgent = createMaintenanceAgentService({
      userDataPath,
      runtime,
      jobManager,
      protocolEventBus,
      loadRuntimeSettings: loadSettings,
      operationPermissionStore,
      operationDispatcher,
      operationConcurrencyScope,
      getDiscoveryState: () => discoveryState,
      getListenUrl: () => discoveryState.activeServiceUrl || discoveryState.listenUrl || "",
      workQueuePort: maintenanceWorkQueue,
      schedulerEnabled: false
    });
    await maintenanceAgent.start();
    queueApplicationPort.start();
    maintenanceWorkQueue.start();

    return {
      mode: "active",
      async tick() {
        await jobManager.maintainHistory();
        await maintenanceAgent.tickScheduler();
        const summary = await maintenanceAgent.getConsoleSummary();
        return {
          status: "running",
          details: {
            mode: "external_maintenance_scheduler",
            enabled: summary.config?.enabled === true,
            activeRunId: summary.activeRunId || "",
            queuedRunIds: summary.queuedRunIds || [],
            pendingApprovalCount: summary.pendingApprovalCount || 0,
            nextRunAt: summary.nextRunAt || "",
            latestRunStatus: summary.latestRun?.status || ""
          }
        };
      },
      close: closeOwnedResources
    };
  } catch (error) {
    await closeOwnedResources().catch(() => {});
    throw error;
  }
}
