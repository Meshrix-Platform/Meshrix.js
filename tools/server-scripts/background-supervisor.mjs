#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  backgroundDefinitionForRole,
  getBackgroundProcessStatus,
  inspectAgentWorkerDemand,
  inspectImportParseWorkerDemand,
  inspectMaintenanceWorkerDemand,
  normalizeBackgroundRoleList,
  setBackgroundProcessDeps,
  statusForInactiveDemand,
  writeBackgroundProcessState
} from "../../packages/foundation/src/observability/background-process-status.mjs";
import { recoverSystemInspection } from "../../packages/server-runtime/src/composition/devops/supervisor-recovery.mjs";
import {
  atomicWriteJson,
  queueStateMutation,
  stateFileKey
} from "#meshrix/state-coordinator";
import { loadSettings } from "#meshrix/settings";
import {
  createRuntimeLogger,
  setRuntimeLogger,
  summarizeError,
  summarizeForLog
} from "#meshrix/runtime-logger";
import { ServerConfig } from "#meshrix/server-config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const packagedWorkerEntryPath = path.join(projectRoot, "server", "scripts", "background-worker.mjs");
const sourceWorkerEntryPath = path.join(projectRoot, "tools", "server-scripts", "background-worker.mjs");
const workerEntryPath = fs.existsSync(packagedWorkerEntryPath)
  ? packagedWorkerEntryPath
  : sourceWorkerEntryPath;

setBackgroundProcessDeps({
  atomicWriteJson,
  queueStateMutation,
  stateFileKey,
  loadSettings,
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function normalizePositiveInteger(value, fallback, min = 1, max = 3600) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function nowIso() {
  return new Date().toISOString();
}

function processRecordForRole(role, patch = {}) {
  const definition = backgroundDefinitionForRole(role);
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

const args = parseArgs(process.argv.slice(2));
const userDataPath = path.resolve(
  String(
    args["data-dir"] ||
      process.env.MESHRIX_SERVER_DATA_DIR ||
      ServerConfig.getDataDir()
  )
);
const roles = normalizeBackgroundRoleList(args.roles || args.role);
const intervalMs = normalizePositiveInteger(args["interval-ms"], 2500, 500, 60000);
const restartDelayMs = normalizePositiveInteger(args["restart-delay-ms"], 1500, 200, 60000);
const systemInspectionRecoveryCooldownMs = normalizePositiveInteger(
  args["system-inspection-recovery-cooldown-ms"],
  30000,
  1000,
  3600000
);
const systemInspectionRecoveryStartupWaitMs = normalizePositiveInteger(
  args["system-inspection-recovery-startup-wait-ms"],
  1200,
  0,
  60000
);
const logger = createRuntimeLogger({
  userDataPath,
  runtimeOptions: {
    cwd: projectRoot,
    logDir: args["log-dir"] || process.env.MESHRIX_LOG_DIR || ""
  },
  component: "background-supervisor"
});
setRuntimeLogger(logger);
const children = new Map();
const records = new Map(roles.map((role) => [role, processRecordForRole(role)]));
const suppressRestartRoles = new Set();
let closing = false;
let stateTimer = null;
let lastSystemInspectionRecoveryAt = 0;
let lastSystemInspectionRecovery = null;

function serializeState() {
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
    processes: roles.map((role) => records.get(role) || processRecordForRole(role))
  };
}

async function persistState() {
  logger.debug("background.supervisor.state.persist.requested", {
    roles,
    childCount: children.size
  });
  await writeBackgroundProcessState(userDataPath, serializeState());
  logger.debug("background.supervisor.state.persisted", {
    roles,
    records: summarizeForLog(roles.map((role) => records.get(role) || processRecordForRole(role)))
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recoverSystemInspectionIfNeeded(reason = "interval") {
  if (closing) {
    return {
      ok: false,
      attempted: false,
      reason: "closing",
      checkedAt: nowIso()
    };
  }
  const backgroundStatus = await getBackgroundProcessStatus(userDataPath);
  const inspectionProcess = (backgroundStatus.processes || []).find((item) => item.role === "system-inspection");
  if (inspectionProcess?.alive && inspectionProcess.status === "running") {
    return {
      ok: true,
      attempted: false,
      reason: "already_running",
      checkedAt: nowIso()
    };
  }
  const nowMs = Date.now();
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

function isOnDemandRole(role) {
  return role === "import-worker" ||
    role === "maintenance-worker" ||
    role === "agent-worker";
}

async function inspectRoleDemand(role) {
  if (role === "import-worker") {
    return inspectImportParseWorkerDemand(userDataPath);
  }
  if (role === "maintenance-worker") {
    return inspectMaintenanceWorkerDemand(userDataPath);
  }
  if (role === "agent-worker") {
    return inspectAgentWorkerDemand(userDataPath);
  }
  return {
    kind: "always_on",
    active: true,
    checkedAt: nowIso()
  };
}

function recordIdleRole(role, demand = {}, patch = {}) {
  const previous = records.get(role) || processRecordForRole(role);
  const child = children.get(role);
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

function updateRoleDemand(role, demand = {}) {
  const previous = records.get(role) || processRecordForRole(role);
  records.set(role, {
    ...previous,
    desired: true,
    details: {
      ...(previous.details || {}),
      demand
    }
  });
}

function spawnRole(role) {
  if (closing) {
    logger.debug("background.supervisor.spawn.skipped", {
      role,
      reason: "closing"
    });
    return;
  }
  const previous = records.get(role) || processRecordForRole(role);
  logger.info("background.supervisor.spawn.requested", {
    role,
    intervalMs,
    restartDelayMs,
    restartCount: previous.restartCount || 0
  });
  const child = spawn(process.execPath, [
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
  const record = processRecordForRole(role, {
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

  child.on("message", (message) => {
    if (!message || message.type !== "heartbeat") {
      logger.warn("background.supervisor.child_message.ignored", {
        role,
        message: summarizeForLog(message || {})
      });
      return;
    }
    const payload = message.payload || {};
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

  child.once("exit", (code, signal) => {
    const current = records.get(role) || processRecordForRole(role);
    const restartSuppressed = suppressRestartRoles.delete(role);
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
      setTimeout(() => {
        void reconcileRole(role)
          .then(() => persistState())
          .catch((error) => {
            logger.error("background.supervisor.restart_reconcile.failed", {
              role,
              error: summarizeError(error)
            });
          });
      }, restartDelayMs).unref?.();
    }
  });

  child.once("error", (error) => {
    const current = records.get(role) || processRecordForRole(role);
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

async function reconcileRole(role) {
  if (!isOnDemandRole(role)) {
    if (!children.has(role)) {
      spawnRole(role);
    }
    return;
  }
  const demand = await inspectRoleDemand(role);
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
  const child = children.get(role);
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
  } catch (error) {
    logger.warn("background.supervisor.on_demand.stop_idle.failed", {
      role,
      pid: child.pid || 0,
      error: summarizeError(error)
    });
    suppressRestartRoles.delete(role);
  }
}

async function reconcileRoles(reason = "interval") {
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

async function shutdown(code = 0) {
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
  setTimeout(() => {
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
    logger.close().finally(() => process.exit(code));
  }, 3000).unref?.();
}

const startedAt = nowIso();
logger.info("background.supervisor.starting", {
  roles,
  userDataPath,
  intervalMs,
  restartDelayMs,
  pid: process.pid
});
await reconcileRoles("startup");
stateTimer = setInterval(() => {
  void reconcileRoles("interval").catch((error) => {
    logger.error("background.supervisor.reconcile.failed", {
      error: summarizeError(error)
    });
  });
}, intervalMs);
await persistState();

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("uncaughtException", (error) => {
  logger.error("background.supervisor.uncaught_exception", {
    error: summarizeError(error)
  });
  records.set("supervisor", processRecordForRole("supervisor", {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    lastHeartbeatAt: nowIso()
  }));
  void persistState().finally(() => logger.close().finally(() => process.exit(1)));
});

process.on("unhandledRejection", (error) => {
  logger.error("background.supervisor.unhandled_rejection", {
    error: summarizeError(error)
  });
  records.set("supervisor", processRecordForRole("supervisor", {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    lastHeartbeatAt: nowIso()
  }));
  void persistState().finally(() => logger.close().finally(() => process.exit(1)));
});
