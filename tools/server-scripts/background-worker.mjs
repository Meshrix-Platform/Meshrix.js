#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createBackgroundWorkerRuntime } from "../../packages/server-runtime/src/composition/background-workers/registry.mjs";
import {
  backgroundDefinitionForRole,
  normalizeBackgroundRoleList
} from "../../packages/foundation/src/observability/background-process-status.mjs";
import {
  createRuntimeLogger,
  setRuntimeLogger,
  summarizeError,
  summarizeForLog
} from "#lico/runtime-logger";
import { ServerConfig } from "#lico/server-config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

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

function send(message) {
  if (typeof process.send !== "function") {
    return;
  }
  try {
    process.send(message);
  } catch {
    // Parent may be shutting down.
  }
}

const args = parseArgs(process.argv.slice(2));
const role = normalizeBackgroundRoleList(args.role || args.roles)[0] || "import-worker";
const userDataPath = path.resolve(
  String(
    args["data-dir"] ||
      process.env.LICO_SERVER_DATA_DIR ||
      ServerConfig.getDataDir()
  )
);
const intervalMs = normalizePositiveInteger(args["interval-ms"], 2500, 500, 60000);
const definition = backgroundDefinitionForRole(role);
const logger = createRuntimeLogger({
  userDataPath,
  runtimeOptions: {
    cwd: projectRoot,
    logDir: args["log-dir"] || process.env.LICO_LOG_DIR || ""
  },
  component: `background-worker-${role}`
});
setRuntimeLogger(logger);
let runtime = null;
let closing = false;
let timer = null;

async function heartbeat(extra = {}) {
  logger.debug("background.worker.heartbeat", {
    role,
    status: extra.status || "running",
    mode: runtime?.mode || "",
    details: summarizeForLog(extra.details || {}),
    error: extra.error || ""
  });
  send({
    type: "heartbeat",
    role,
    payload: {
      role,
      label: definition.label,
      description: definition.description,
      pid: process.pid,
      desired: true,
      status: extra.status || "running",
      mode: runtime?.mode || "",
      lastHeartbeatAt: nowIso(),
      details: extra.details || {},
      error: extra.error || ""
    }
  });
}

async function tick() {
  if (closing) {
    logger.debug("background.worker.tick.skipped", {
      role,
      reason: "closing"
    });
    return;
  }
  try {
    logger.debug("background.worker.tick.started", {
      role,
      mode: runtime?.mode || ""
    });
    const result = runtime && typeof runtime.tick === "function"
      ? await runtime.tick()
      : { status: "running" };
    logger.debug("background.worker.tick.completed", {
      role,
      result: summarizeForLog(result)
    });
    await heartbeat(result);
  } catch (error) {
    logger.error("background.worker.tick.failed", {
      role,
      error: summarizeError(error)
    });
    await heartbeat({
      status: "degraded",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (!closing) {
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  }
}

async function shutdown(code = 0) {
  logger.info("background.worker.shutdown.started", {
    role,
    code
  });
  closing = true;
  if (timer) {
    clearTimeout(timer);
  }
  try {
    await heartbeat({ status: "stopping" });
    if (runtime && typeof runtime.close === "function") {
      await runtime.close();
    }
    logger.info("background.worker.shutdown.completed", {
      role,
      code
    });
    await logger.close();
  } finally {
    process.exit(code);
  }
}

logger.info("background.worker.starting", {
  role,
  userDataPath,
  intervalMs,
  pid: process.pid
});
runtime = await createBackgroundWorkerRuntime({ role, userDataPath });
logger.info("background.worker.started", {
  role,
  mode: runtime.mode || "",
  pid: process.pid
});
await heartbeat({ status: runtime.mode === "standby" ? "standby" : "running" });
void tick();

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

process.on("uncaughtException", (error) => {
  logger.error("background.worker.uncaught_exception", {
    role,
    error: summarizeError(error)
  });
  void heartbeat({
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  }).finally(() => {
    logger.close().finally(() => process.exit(1));
  });
});

process.on("unhandledRejection", (error) => {
  logger.error("background.worker.unhandled_rejection", {
    role,
    error: summarizeError(error)
  });
  void heartbeat({
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  }).finally(() => {
    logger.close().finally(() => process.exit(1));
  });
});
