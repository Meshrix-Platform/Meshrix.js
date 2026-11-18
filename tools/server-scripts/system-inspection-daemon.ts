#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadMonitorAlertConfig,
  runMonitorAlertCycle
} from "../../packages/server-runtime/src/composition/devops/monitor-alerts.ts";
import { getBackgroundProcessStatus } from "../../packages/foundation/src/observability/background-process-status.ts";
import { recoverBackgroundSupervisor } from "../../packages/server-runtime/src/composition/devops/supervisor-recovery.ts";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = {};
  const readValue: any = (option?: any, index?: any) : any => {
    const value: any = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for system-inspection option: ${option}`);
    }
    return value;
  };
  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = argv[index];
    if (item === "--project-root") {
      if (args.projectRoot !== undefined) {
        throw new Error("Duplicate system-inspection option: --project-root");
      }
      args.projectRoot = readValue(item, index);
      index += 1;
    } else if (item === "--data-dir") {
      if (args.dataDir !== undefined) {
        throw new Error("Duplicate system-inspection option: --data-dir");
      }
      args.dataDir = readValue(item, index);
      index += 1;
    } else if (item === "--once") {
      if (args.once === true) {
        throw new Error("Duplicate system-inspection option: --once");
      }
      args.once = true;
    } else {
      throw new Error(`Unknown system-inspection option: ${item}`);
    }
  }
  return args;
}

function nowIso() : any {
  return new Date().toISOString();
}

function normalizeInteger(value?: any, fallback?: any, min?: any, max?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

const args: any = parseArgs(process.argv.slice(2));
const projectRoot: any =
  args.projectRoot ||
  path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataDir: any = path.resolve(
  String(args.dataDir || process.env.MESHRIX_SERVER_DATA_DIR || ServerConfig.getDataDir())
);
let lastSupervisorRecoveryAt: any = 0;
let lastSupervisorRecovery: any = null;

async function sleep(ms?: any) : Promise<any> {
  await new Promise((resolve?: any) : any => setTimeout(resolve, ms));
}

async function recoverSupervisorIfNeeded(config?: any) : Promise<any> {
  const recoveryConfig: any = config.supervisorRecovery || {};
  if (config.configurationState !== "configured" || recoveryConfig.enabled !== true) {
    return {
      ok: false,
      attempted: false,
      reason: config.configurationState === "configured" ? "disabled" : "configuration_missing",
      checkedAt: nowIso()
    };
  }
  const backgroundStatus: any = await getBackgroundProcessStatus(dataDir);
  if (backgroundStatus.supervisor?.alive) {
    return {
      ok: true,
      attempted: false,
      reason: "already_running",
      checkedAt: nowIso()
    };
  }
  const cooldownMs: any = normalizeInteger(recoveryConfig.cooldownMs, 30000, 1000, 3600000);
  const nowMs: any = Date.now();
  if (lastSupervisorRecoveryAt && nowMs - lastSupervisorRecoveryAt < cooldownMs) {
    return {
      ...(lastSupervisorRecovery || {}),
      ok: false,
      attempted: false,
      reason: "cooldown",
      cooldownMs,
      checkedAt: nowIso()
    };
  }
  lastSupervisorRecoveryAt = nowMs;
  lastSupervisorRecovery = await recoverBackgroundSupervisor({
    backgroundStatus,
    serviceLabel: "dev.meshrix.background-supervisor"
  });
  if (lastSupervisorRecovery.ok) {
    await sleep(normalizeInteger(recoveryConfig.startupWaitMs, 1200, 0, 60000));
  }
  return lastSupervisorRecovery;
}

async function runCycle() : Promise<any> {
  const config: any = await loadMonitorAlertConfig(dataDir);
  const supervisorRecovery: any = await recoverSupervisorIfNeeded(config);
  const state: any = await runMonitorAlertCycle(dataDir, {
    inspectionDaemon: {
      pid: process.pid,
      status: "running",
      updatedAt: nowIso(),
      supervisorRecovery,
      runtime: "node"
    }
  });
  return { config, state };
}

async function loop({ once = false }: Record<string, any> = {}) : Promise<any> {
  while (true) {
    let intervalMs: any = 5000;
    try {
      const { config } = await runCycle();
      intervalMs = normalizeInteger(config.intervalMs, 5000, 1000, 600000);
    } catch (error: any) {
      if (once) throw error;
      console.error(`[system-inspection] ${error?.stack || error?.message || error}`);
    }
    if (once) return;
    await sleep(intervalMs);
  }
}

await loop({ once: args.once === true });
