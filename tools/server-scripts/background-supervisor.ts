#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  backgroundDefinitionForRole,
  getBackgroundProcessStatus,
  inspectImportParseWorkerDemand,
  normalizeBackgroundRoleList,
  setBackgroundProcessDeps,
  statusForInactiveDemand,
  writeBackgroundProcessState
} from "../../packages/foundation/src/observability/background-process-status.ts";
import { recoverSystemInspection } from "../../packages/server-runtime/src/composition/devops/supervisor-recovery.ts";
import {
  atomicWriteJson,
  queueStateMutation,
  stateFileKey
} from "#meshrix/state-coordinator";
import {
  createRuntimeLogger,
  setRuntimeLogger,
  summarizeError,
  summarizeForLog
} from "#meshrix/runtime-logger";
import { ServerConfig } from "#meshrix/server-config";

const __filename: any = fileURLToPath(import.meta.url);
const __dirname: any = path.dirname(__filename);
const projectRoot: any = path.resolve(__dirname, "../..");
const packagedWorkerEntryPath: any = path.join(projectRoot, "server", "scripts", "background-worker.ts");
const sourceWorkerEntryPath: any = path.join(projectRoot, "tools", "server-scripts", "background-worker.ts");
const workerEntryPath: any = fs.existsSync(packagedWorkerEntryPath)
  ? packagedWorkerEntryPath
  : sourceWorkerEntryPath;

setBackgroundProcessDeps({
  atomicWriteJson,
  queueStateMutation,
  stateFileKey,
});

function parseArgs(argv?: any) : any {
  const parsed: Record<string, any> = {};
  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key: any = item.slice(2);
    const next: any = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function normalizePositiveInteger(value?: any, fallback?: any, min: any = 1, max: any = 3600) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function nowIso() : any {
  return new Date().toISOString();
}

function processRecordForRole(role?: any, patch: Record<string, any> = {}) : any {
  const definition: any = backgroundDefinitionForRole(role);
  return {
    role,
    label: definition.label,
    description: definition.description,
    desired: true,
    pid: 0,
    status: "starting",
    startedAt: "",
    lastHeartbeatAt: "",
    restartCount: 0,
    lastExit: null,
    details: {},
    error: "",
    ...patch
  };
}

const args: any = parseArgs(process.argv.slice(2));
const userDataPath: any = path.resolve(
  String(
    args["data-dir"] ||
      process.env.MESHRIX_SERVER_DATA_DIR ||
      ServerConfig.getDataDir()
  )
);
const roles: any = normalizeBackgroundRoleList(args.roles || args.role);
const intervalMs: any = normalizePositiveInteger(args["interval-ms"], 2500, 500, 60000);
const restartDelayMs: any = normalizePositiveInteger(args["restart-delay-ms"], 1500, 200, 60000);
const systemInspectionRecoveryCooldownMs: any = normalizePositiveInteger(
  args["system-inspection-recovery-cooldown-ms"],
  30000,
  1000,
  3600000
);
const systemInspectionRecoveryStartupWaitMs: any = normalizePositiveInteger(
  args["system-inspection-recovery-startup-wait-ms"],
  1200,
  0,
  60000
);
const logger: any = createRuntimeLogger({
  userDataPath,
  runtimeOptions: {
    cwd: projectRoot,
    logDir: args["log-dir"] || process.env.MESHRIX_LOG_DIR || ""
  },
  component: "background-supervisor"
});
setRuntimeLogger(logger);
const children: any = new Map<any, any>();
const records: any = new Map<any, any>(roles.map((role?: any) : any => [role, processRecordForRole(role)]));
const suppressRestartRoles: any = new Set<any>();
let closing: any = false;
let stateTimer: any = null;
let lastSystemInspectionRecoveryAt: any = 0;
let lastSystemInspectionRecovery: any = null;

function serializeState() : any {
  return {
    supervisor: {
      pid: process.pid,
      startedAt,
      status: closing ? "stopping" : "running",
      intervalMs,
      restartDelayMs,
      systemInspectionRecovery: lastSystemInspectionRecovery,
      roles
    },
    processes: roles.map((role?: any) : any => records.get(role) || processRecordForRole(role))
  };
}

async function persistState() : Promise<any> {
  logger.debug("background.supervisor.state.persist.requested", {
    roles,
    childCount: children.size
  });
  await writeBackgroundProcessState(userDataPath, serializeState());
  logger.debug("background.supervisor.state.persisted", {
    roles,
    records: summarizeForLog(roles.map((role?: any) : any => records.get(role) || processRecordForRole(role)))
  });
}

async function sleep(ms?: any) : Promise<any> {
  await new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function recoverSystemInspectionIfNeeded(reason: any = "interval") : Promise<any> {
  if (closing) {
    return {
      ok: false,
      attempted: false,
      reason: "closing",
      checkedAt: nowIso()
    };
  }
  const backgroundStatus: any = await getBackgroundProcessStatus(userDataPath);
  const inspectionProcess: any = (backgroundStatus.processes || []).find((item?: any) : any => item.role === "system-inspection");
  if (inspectionProcess?.alive && inspectionProcess.status === "running") {
    return {
      ok: true,
      attempted: false,
      reason: "already_running",
      checkedAt: nowIso()
    };
  }
  const nowMs: any = Date.now();
  if (
    lastSystemInspectionRecoveryAt &&
    nowMs - lastSystemInspectionRecoveryAt < systemInspectionRecoveryCooldownMs
  ) {
    return {
      ...(lastSystemInspectionRecovery || {}),
      ok: false,
      attempted: false,
      reason: "cooldown",
      cooldownMs: systemInspectionRecoveryCooldownMs,
      checkedAt: nowIso()
    };
  }
  lastSystemInspectionRecoveryAt = nowMs;
  logger.warn("background.supervisor.system_inspection.recovery_requested", {
    reason,
    status: inspectionProcess?.status || "",
    pid: inspectionProcess?.pid || 0,
    alive: inspectionProcess?.alive === true
  });
  lastSystemInspectionRecovery = await recoverSystemInspection({
    backgroundStatus
  });
  logger.info("background.supervisor.system_inspection.recovery_completed", {
    reason,
    recovery: summarizeForLog(lastSystemInspectionRecovery)
  });
  if (lastSystemInspectionRecovery.ok) {
    await sleep(systemInspectionRecoveryStartupWaitMs);
  }
  return lastSystemInspectionRecovery;
}

function isOnDemandRole(role?: any) : any {
  return role === "import-worker";
}

async function inspectRoleDemand(role?: any) : Promise<any> {
  if (role === "import-worker") {
    return inspectImportParseWorkerDemand(userDataPath);
  }
  return {
    kind: "always_on",
    active: true,
    checkedAt: nowIso()
  };
}

function recordIdleRole(role?: any, demand: Record<string, any> = {}, patch: Record<string, any> = {}) : any {
  const previous: any = records.get(role) || processRecordForRole(role);
  const child: any = children.get(role);
  records.set(role, processRecordForRole(role, {
    ...previous,
    desired: false,
    status: child ? "stopping" : statusForInactiveDemand(demand),
    mode: "on-demand",
    pid: child?.pid || 0,
    lastHeartbeatAt: nowIso(),
    error: "",
    details: {
      ...(previous.details || {}),
      demand
    },
    ...patch
  }));
}

function updateRoleDemand(role?: any, demand: Record<string, any> = {}) : any {
  const previous: any = records.get(role) || processRecordForRole(role);
  records.set(role, {
    ...previous,
    desired: true,
    details: {
      ...(previous.details || {}),
      demand
    }
  });
}

function spawnRole(role?: any) : any {
  if (closing) {
    logger.debug("background.supervisor.spawn.skipped", {
      role,
      reason: "closing"
    });
    return;
  }
  const previous: any = records.get(role) || processRecordForRole(role);
  logger.info("background.supervisor.spawn.requested", {
    role,
    intervalMs,
    restartDelayMs,
    restartCount: previous.restartCount || 0
  });
  const child: any = spawn(process.execPath, [
    workerEntryPath,
    "--role",
    role,
    "--data-dir",
    userDataPath,
    "--interval-ms",
    String(intervalMs),
    "--log-dir",
    logger.logDir
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MESHRIX_BACKGROUND_WORKER_ROLE: role,
      MESHRIX_IMPORT_WORKER_EXTERNAL: role === "import-worker" ? "0" : process.env.MESHRIX_IMPORT_WORKER_EXTERNAL || ""
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  const record: any = processRecordForRole(role, {
    restartCount: previous.restartCount || 0,
    pid: child.pid || 0,
    status: "starting",
    startedAt: nowIso(),
    details: previous.details || {}
  });
  records.set(role, record);
  children.set(role, child);
  logger.info("background.supervisor.spawned", {
    role,
    pid: child.pid || 0
  });
  void persistState();

  child.on("message", (message?: any) : any => {
    if (!message || message.type !== "heartbeat") {
      logger.warn("background.supervisor.child_message.ignored", {
        role,
        message: summarizeForLog(message || {})
      });
      return;
    }
    const payload: any = message.payload || {};
    logger.debug("background.supervisor.child_heartbeat", {
      role,
      pid: child.pid || payload.pid || 0,
      status: payload.status || "",
      mode: payload.mode || "",
      details: summarizeForLog(payload.details || {}),
      error: payload.error || ""
    });
    records.set(role, {
      ...processRecordForRole(role),
      ...records.get(role),
      ...payload,
      pid: child.pid || payload.pid || 0,
      restartCount: records.get(role)?.restartCount || 0
    });
    void persistState();
  });

  child.once("exit", (code?: any, signal?: any) : any => {
    const current: any = records.get(role) || processRecordForRole(role);
    const restartSuppressed: any = suppressRestartRoles.delete(role);
    children.delete(role);
    logger.warn("background.supervisor.child_exited", {
      role,
      pid: child.pid || 0,
      code,
      signal,
      closing,
      restartSuppressed
    });
    records.set(role, {
      ...current,
      desired: restartSuppressed ? false : current.desired !== false,
      status: closing ? "stopped" : restartSuppressed ? "standby" : "exited",
      lastExit: {
        code,
        signal,
        at: nowIso()
      },
      pid: 0,
      restartCount: Number(current.restartCount || 0) + (closing || restartSuppressed ? 0 : 1)
    });
    void persistState();
    if (!closing && !restartSuppressed) {
      logger.info("background.supervisor.restart_scheduled", {
        role,
        restartDelayMs
      });
      setTimeout(() : any => {
        void reconcileRole(role)
          .then(() : any => persistState())
          .catch((error?: any) : any => {
            logger.error("background.supervisor.restart_reconcile.failed", {
              role,
              error: summarizeError(error)
            });
          });
      }, restartDelayMs).unref?.();
    }
  });

  child.once("error", (error?: any) : any => {
    const current: any = records.get(role) || processRecordForRole(role);
    logger.error("background.supervisor.child_error", {
      role,
      pid: child.pid || 0,
      error: summarizeError(error)
    });
    records.set(role, {
      ...current,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      lastHeartbeatAt: nowIso()
    });
    void persistState();
  });
}

async function reconcileRole(role?: any) : Promise<any> {
  if (!isOnDemandRole(role)) {
    if (!children.has(role)) {
      spawnRole(role);
    }
    return;
  }
  const demand: any = await inspectRoleDemand(role);
  if (demand.active) {
    updateRoleDemand(role, demand);
    if (!children.has(role)) {
      logger.info("background.supervisor.on_demand.spawn", {
        role,
        demand: summarizeForLog(demand)
      });
      spawnRole(role);
    }
    return;
  }
  const child: any = children.get(role);
  recordIdleRole(role, demand);
  if (!child) {
    return;
  }
  logger.info("background.supervisor.on_demand.stop_idle", {
    role,
    pid: child.pid || 0,
    demand: summarizeForLog(demand)
  });
  suppressRestartRoles.add(role);
  try {
    child.kill("SIGTERM");
  } catch (error: any) {
    logger.warn("background.supervisor.on_demand.stop_idle.failed", {
      role,
      pid: child.pid || 0,
      error: summarizeError(error)
    });
    suppressRestartRoles.delete(role);
  }
}

async function reconcileRoles(reason: any = "interval") : Promise<any> {
  logger.debug("background.supervisor.reconcile.started", {
    reason,
    roles
  });
  for (const role of roles) {
    await reconcileRole(role);
  }
  await recoverSystemInspectionIfNeeded(reason);
  await persistState();
}

async function shutdown(code: any = 0) : Promise<any> {
  logger.info("background.supervisor.shutdown.started", {
    code,
    childCount: children.size
  });
  closing = true;
  if (stateTimer) {
    clearInterval(stateTimer);
  }
  await persistState();
  for (const child of children.values()) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore shutdown races.
    }
  }
  setTimeout(() : any => {
    for (const child of children.values()) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore already exited workers.
      }
    }
    logger.info("background.supervisor.shutdown.completed", {
      code
    });
    logger.close().finally(() : any => process.exit(code));
  }, 3000).unref?.();
}

const startedAt: any = nowIso();
logger.info("background.supervisor.starting", {
  roles,
  userDataPath,
  intervalMs,
  restartDelayMs,
  pid: process.pid
});
await reconcileRoles("startup");
stateTimer = setInterval(() : any => {
  void reconcileRoles("interval").catch((error?: any) : any => {
    logger.error("background.supervisor.reconcile.failed", {
      error: summarizeError(error)
    });
  });
}, intervalMs);
await persistState();

process.on("SIGINT", () : any => {
  void shutdown(0);
});

process.on("SIGTERM", () : any => {
  void shutdown(0);
});

process.on("uncaughtException", (error?: any) : any => {
  logger.error("background.supervisor.uncaught_exception", {
    error: summarizeError(error)
  });
  records.set("supervisor", processRecordForRole("supervisor", {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    lastHeartbeatAt: nowIso()
  }));
  void persistState().finally(() : any => logger.close().finally(() : any => process.exit(1)));
});

process.on("unhandledRejection", (error?: any) : any => {
  logger.error("background.supervisor.unhandled_rejection", {
    error: summarizeError(error)
  });
  records.set("supervisor", processRecordForRole("supervisor", {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    lastHeartbeatAt: nowIso()
  }));
  void persistState().finally(() : any => logger.close().finally(() : any => process.exit(1)));
});
