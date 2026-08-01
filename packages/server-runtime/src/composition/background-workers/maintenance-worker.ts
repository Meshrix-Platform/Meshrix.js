import { createMaintenanceAgentService } from "#meshrix/agents/maintenance/index";
import { createOperationPermissionStore } from "#meshrix/capabilities/operation-permission-core/store";
import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { createJobManager } from "../../jobs/jobs/job-manager.ts";
import { createProtocolEventRuntime } from "../../events/protocol-event-runtime.ts";
import { createProtocolEventBus } from "#meshrix/protocols/pubsub/event-bus";
import { createMaintenanceWorkQueueProvider } from "../maintenance-work-queue-provider.ts";
import { createQueueApplicationPort } from "../queue-application-port.ts";
import {
  createServerRuntime,
  bindOperationDispatcher,
  loadSettings,
  loadDiscoveryConfig
} from "#meshrix/product-api";

class MaintenanceWorkerCloseError extends Error {
  code: any;
  name: any;
  constructor(code?: any) {
    super("Maintenance worker resource shutdown did not complete cleanly.");
    this.name = "MaintenanceWorkerCloseError";
    this.code = code;
  }
}

function eventRevision(databasePath?: any, tableName?: any) : any {
  if (!fs.existsSync(databasePath)) {
    return { revision: 0, updatedAt: "" };
  }
  const db: any = openSqliteDatabase(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row: any = db.prepare(
      tableName === "authorization_governance_events"
        ? "SELECT count(*) AS revision, max(created_at) AS updated_at FROM authorization_governance_events"
        : "SELECT count(*) AS revision, max(created_at) AS updated_at FROM tag_management_events"
    ).get();
    return {
      revision: Number(row?.revision || 0),
      updatedAt: String(row?.updated_at || "")
    };
  } catch {
    return { revision: 0, updatedAt: "" };
  } finally {
    db.close();
  }
}

export function createMaintenanceGovernanceRevisionReader(userDataPath?: any) : any {
  const authorizationPath: any = path.join(
    userDataPath,
    "security",
    "authorization",
    "authorization-governance.sqlite"
  );
  const tagPath: any = path.join(
    userDataPath,
    "security",
    "tag-management",
    "tag-management.sqlite"
  );
  return function readMaintenanceGovernanceRevision() : any {
    const authorization: any = eventRevision(
      authorizationPath,
      "authorization_governance_events"
    );
    const tags: any = eventRevision(tagPath, "tag_management_events");
    return {
      protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
      revision: authorization.revision + tags.revision,
      updatedAt: [authorization.updatedAt, tags.updatedAt].sort().pop() || ""
    };
  };
}

export async function createMaintenanceWorkerRuntime({
  userDataPath,
  operationLockManager: injectedOperationLockManager = null,
  getGovernancePolicyRevision: injectedGovernancePolicyRevision = null
}: Record<string, any>) : Promise<any> {
  const getGovernancePolicyRevision: any =
    injectedGovernancePolicyRevision ||
    createMaintenanceGovernanceRevisionReader(userDataPath);
  let protocolEventBus: any = null;
  let protocolEventRuntime: any = null;
  let runtime: any = null;
  let jobManager: any = null;
  let operationPermissionStore: any = null;
  let maintenanceAgent: any = null;
  let maintenanceWorkQueue: any = null;
  let queueApplicationPort: any = null;
  let closePromise: any = null;

  function closeOwnedResources() : any {
    if (closePromise) return closePromise;
    closePromise = (async () : Promise<any> => {
      const ownerFailures: any[] = [];
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

      const dependencyFailures: any[] = [];
      for (const close of [
        () : any => runtime?.close?.(),
        () : any => protocolEventRuntime?.close?.()
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
    })().catch((error?: any) : any => {
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
    const operationConcurrencyScope: any = runtime.operationLockManager?.namespace || "server";
    const operationDispatcher: any = bindOperationDispatcher({
      lockManager: runtime.operationLockManager,
      concurrencyScope: operationConcurrencyScope
    });
    jobManager = createJobManager({
      userDataPath,
      processingEnabled: false,
      protocolEventBus
    });
    const discoveryState: any = await loadDiscoveryConfig(userDataPath).catch(() : any => ({}));
    operationPermissionStore = createOperationPermissionStore({
      userDataPath,
      governancePolicyRevisionProvider: getGovernancePolicyRevision
    });
    queueApplicationPort = await createQueueApplicationPort({ userDataPath });
    maintenanceWorkQueue = await createMaintenanceWorkQueueProvider({
      queueApplicationPort,
      getMaintenanceAgent: () : any => maintenanceAgent,
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
      getGovernancePolicyRevision,
      operationDispatcher,
      operationConcurrencyScope,
      getDiscoveryState: () : any => discoveryState,
      getListenUrl: () : any => discoveryState.activeServiceUrl || discoveryState.listenUrl || "",
      workQueuePort: maintenanceWorkQueue,
      schedulerEnabled: false
    });
    await maintenanceAgent.start();
    queueApplicationPort.start();
    maintenanceWorkQueue.start();

    return {
      mode: "active",
      async tick() : Promise<any> {
        await jobManager.maintainHistory();
        await maintenanceAgent.tickScheduler();
        const summary: any = await maintenanceAgent.getConsoleSummary();
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
  } catch (error: any) {
    await closeOwnedResources().catch(() : any => {});
    throw error;
  }
}
