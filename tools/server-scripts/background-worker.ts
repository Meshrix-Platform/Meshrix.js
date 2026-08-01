#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createBackgroundWorkerRuntime } from "../../packages/server-runtime/src/composition/background-workers/registry.ts";
import {
  backgroundDefinitionForRole,
  normalizeBackgroundRoleList
} from "../../packages/foundation/src/observability/background-process-status.ts";
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

function send(message?: any) : any {
  if (typeof process.send !== "function") {
    return;
  }
  try {
    process.send(message);
  } catch {
    // Parent may be shutting down.
  }
}

const args: any = parseArgs(process.argv.slice(2));
const role: any = normalizeBackgroundRoleList(args.role || args.roles)[0] || "import-worker";
const userDataPath: any = path.resolve(
  String(
    args["data-dir"] ||
      process.env.MESHRIX_SERVER_DATA_DIR ||
      ServerConfig.getDataDir()
  )
);
const intervalMs: any = normalizePositiveInteger(args["interval-ms"], 2500, 500, 60000);
const definition: any = backgroundDefinitionForRole(role);
const logger: any = createRuntimeLogger({
  userDataPath,
  runtimeOptions: {
    cwd: projectRoot,
    logDir: args["log-dir"] || process.env.MESHRIX_LOG_DIR || ""
  },
  component: `background-worker-${role}`
});
setRuntimeLogger(logger);
let runtime: any = null;
let closing: any = false;
let timer: any = null;

async function heartbeat(extra: Record<string, any> = {}) : Promise<any> {
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

async function tick() : Promise<any> {
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
    const result: any = runtime && typeof runtime.tick === "function"
      ? await runtime.tick()
      : { status: "running" };
    logger.debug("background.worker.tick.completed", {
      role,
      result: summarizeForLog(result)
    });
    await heartbeat(result);
  } catch (error: any) {
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
      timer = setTimeout(() : any => {
        void tick();
      }, intervalMs);
    }
  }
}

async function shutdown(code: any = 0) : Promise<any> {
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

process.on("SIGINT", () : any => {
  void shutdown(0);
});

process.on("SIGTERM", () : any => {
  void shutdown(0);
});

process.on("uncaughtException", (error?: any) : any => {
  logger.error("background.worker.uncaught_exception", {
    role,
    error: summarizeError(error)
  });
  void heartbeat({
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  }).finally(() : any => {
    logger.close().finally(() : any => process.exit(1));
  });
});

process.on("unhandledRejection", (error?: any) : any => {
  logger.error("background.worker.unhandled_rejection", {
    role,
    error: summarizeError(error)
  });
  void heartbeat({
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  }).finally(() : any => {
    logger.close().finally(() : any => process.exit(1));
  });
});
