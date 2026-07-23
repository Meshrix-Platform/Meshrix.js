import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJsonThroughState,
  mutateState,
  waitForStateIdle
} from "@lico/foundation/storage/state-coordinator";

export const MAINTENANCE_AGENT_SCHEMA_VERSION = "v0.0.1:platform:maintenance-agent-schema-1";
export const MAINTENANCE_AGENT_RISKS = [
  "read_only",
  "safe_write",
  "repair_write",
  "destructive"
];

export const AUTO_APPROVE_RISKS = ["read_only", "safe_write"];

export const MAINTENANCE_RUNBOOK_CATALOG = {
  health_smoke: {
    id: "health_smoke",
    label: "健康冒烟巡检",
    description: "健康、运行时、存储摘要和最近任务检查。",
    suggestedIntervalMinutes: 60
  },
  daily_storage_maintenance: {
    id: "daily_storage_maintenance",
    label: "每日存储维护",
    description: "健康冒烟巡检加服务端存储一致性诊断。",
    suggestedIntervalMinutes: 1440
  },
  failed_jobs_review: {
    id: "failed_jobs_review",
    label: "失败任务复盘",
    description: "扫描近期失败任务并生成可执行建议，不自动重跑任务。",
    suggestedIntervalMinutes: 1440
  }
};

export const EMPTY_MAINTENANCE_AGENT_CONFIG = {
  schemaVersion: MAINTENANCE_AGENT_SCHEMA_VERSION,
  enabled: false,
  plannerMode: "",
  autoApproveRisk: "",
  concurrency: {
    maxActiveRuns: 0
  },
  scheduler: {
    tickSeconds: 0
  },
  schedules: []
};

export function getMaintenanceAgentConfigPath(userDataPath) {
  return path.join(userDataPath, "maintenance-agent.json");
}

export function getMaintenanceAgentAuditPath(userDataPath) {
  return path.join(userDataPath, "maintenance-agent-audit.jsonl");
}

export function getMaintenanceAgentRunsPath(userDataPath) {
  return path.join(userDataPath, "maintenance-agent-runs.jsonl");
}

export function normalizeRisk(value, fallback = "read_only") {
  const risk = String(value || "").trim();
  return MAINTENANCE_AGENT_RISKS.includes(risk) ? risk : fallback;
}

export function riskRank(value) {
  const index = MAINTENANCE_AGENT_RISKS.indexOf(normalizeRisk(value));
  return index >= 0 ? index : 0;
}

export function maxRisk(...risks) {
  return risks
    .map((risk) => normalizeRisk(risk))
    .sort((left, right) => riskRank(right) - riskRank(left))[0] || "read_only";
}

function asPlainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizePlannerMode(value) {
  const mode = String(value || "").trim();
  return ["gateway", "fixed_runbook"].includes(mode)
    ? mode
    : EMPTY_MAINTENANCE_AGENT_CONFIG.plannerMode;
}

function normalizeAutoApproveRisk(value) {
  const risk = normalizeRisk(value, EMPTY_MAINTENANCE_AGENT_CONFIG.autoApproveRisk);
  return AUTO_APPROVE_RISKS.includes(risk) ? risk : EMPTY_MAINTENANCE_AGENT_CONFIG.autoApproveRisk;
}

function normalizePositiveInteger(value, fallback, { min = 1, max = 100000, allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (allowZero && parsed === 0) {
    return 0;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeSchedule(input, fallback = {}) {
  const value = asPlainObject(input);
  const runbook = String(value.runbook || fallback.runbook || "").trim();
  const id = String(value.id || fallback.id || `schedule_${crypto.randomUUID()}`).trim();
  const intervalMinutes = normalizePositiveInteger(
    value.intervalMinutes ?? fallback.intervalMinutes,
    0,
    { min: 1, max: 525600, allowZero: true }
  );
  const normalizedRunbook = MAINTENANCE_RUNBOOK_CATALOG[runbook] ? runbook : "";
  return {
    id,
    label: String(value.label || fallback.label || id).trim(),
    enabled: value.enabled === true && Boolean(normalizedRunbook) && intervalMinutes > 0,
    runbook: normalizedRunbook,
    intervalMinutes,
    nextRunAt: String(value.nextRunAt || fallback.nextRunAt || "").trim()
  };
}

export function normalizeMaintenanceAgentConfig(input = {}) {
  const value = asPlainObject(input);
  const incomingSchedules = Array.isArray(value.schedules) ? value.schedules : [];
  const schedules = incomingSchedules.map((item) => normalizeSchedule(item));

  return {
    schemaVersion: MAINTENANCE_AGENT_SCHEMA_VERSION,
    enabled: value.enabled === true,
    plannerMode: normalizePlannerMode(value.plannerMode),
    autoApproveRisk: normalizeAutoApproveRisk(value.autoApproveRisk),
    concurrency: {
      maxActiveRuns: normalizePositiveInteger(
        asPlainObject(value.concurrency).maxActiveRuns,
        0,
        { min: 1, max: 100, allowZero: true }
      )
    },
    scheduler: {
      tickSeconds: normalizePositiveInteger(
        asPlainObject(value.scheduler).tickSeconds,
        EMPTY_MAINTENANCE_AGENT_CONFIG.scheduler.tickSeconds,
        { min: 1, max: 3600, allowZero: true }
      )
    },
    schedules
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteJsonThroughState(filePath, value, {
    kind: "maintenance_agent.config.write"
  });
}

function maintenanceAgentConfigStateKey(userDataPath) {
  return `maintenance-agent-config:${path.resolve(userDataPath)}`;
}

async function loadMaintenanceAgentConfigUnlocked(userDataPath) {
  const filePath = getMaintenanceAgentConfigPath(userDataPath);
  const parsed = await readJsonIfExists(filePath);
  return normalizeMaintenanceAgentConfig(parsed || EMPTY_MAINTENANCE_AGENT_CONFIG);
}

export async function loadMaintenanceAgentConfig(userDataPath) {
  await waitForStateIdle(maintenanceAgentConfigStateKey(userDataPath));
  return loadMaintenanceAgentConfigUnlocked(userDataPath);
}

async function saveMaintenanceAgentConfigUnlocked(userDataPath, input = {}) {
  const normalized = normalizeMaintenanceAgentConfig(input);
  await atomicWriteJson(getMaintenanceAgentConfigPath(userDataPath), normalized);
  return normalized;
}

export async function saveMaintenanceAgentConfig(userDataPath, input = {}) {
  return mutateState({
    key: maintenanceAgentConfigStateKey(userDataPath),
    kind: "maintenance_agent.config.save",
    metadata: { userDataPath },
    task: () => saveMaintenanceAgentConfigUnlocked(userDataPath, input)
  });
}

export function computeNextRunAt(schedule, fromDate = new Date()) {
  const intervalMinutes = normalizePositiveInteger(schedule?.intervalMinutes, 0, {
    min: 1,
    max: 525600,
    allowZero: true
  });
  if (intervalMinutes <= 0) {
    throw new Error("Maintenance schedule intervalMinutes must be configured before execution.");
  }
  return new Date(fromDate.getTime() + intervalMinutes * 60 * 1000).toISOString();
}
