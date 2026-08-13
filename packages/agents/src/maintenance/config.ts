import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJsonThroughState,
  mutateState,
  waitForStateIdle
} from "@meshrix/foundation/storage/state-coordinator";

export const MAINTENANCE_AGENT_SCHEMA_VERSION: any = "v0.0.1:platform:maintenance-agent-schema-1";
export const MAINTENANCE_AGENT_RISKS: any[] = [
  "read_only",
  "safe_write",
  "repair_write",
  "destructive"
];

export const AUTO_APPROVE_RISKS: any[] = ["read_only", "safe_write"];

export const MAINTENANCE_RUNBOOK_CATALOG: Record<string, any> = {
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

export const EMPTY_MAINTENANCE_AGENT_CONFIG: Record<string, any> = {
  schemaVersion: MAINTENANCE_AGENT_SCHEMA_VERSION,
  enabled: false,
  plannerMode: "",
  autoApproveRisk: "",
  workloadGrantId: "",
  concurrency: {
    maxActiveRuns: 0
  },
  scheduler: {
    tickSeconds: 0
  },
  schedules: []
};

export function getMaintenanceAgentConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, "maintenance-agent.json");
}

export function getMaintenanceAgentAuditPath(userDataPath?: any) : any {
  return path.join(userDataPath, "maintenance-agent-audit.jsonl");
}

export function getMaintenanceAgentRunsPath(userDataPath?: any) : any {
  return path.join(userDataPath, "maintenance-agent-runs.jsonl");
}

export function normalizeRisk(value?: any, fallback: any = "read_only") : any {
  const risk: any = String(value || "").trim();
  return MAINTENANCE_AGENT_RISKS.includes(risk) ? risk : fallback;
}

export function riskRank(value?: any) : any {
  const index: any = MAINTENANCE_AGENT_RISKS.indexOf(normalizeRisk(value));
  return index >= 0 ? index : 0;
}

export function maxRisk(...risks: any[]) : any {
  return risks
    .map((risk?: any) : any => normalizeRisk(risk))
    .sort((left?: any, right?: any) : any => riskRank(right) - riskRank(left))[0] || "read_only";
}

function asPlainObject(value?: any, fallback: Record<string, any> | null = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normalizePlannerMode(value?: any) : any {
  const mode: any = String(value || "").trim();
  return ["gateway", "fixed_runbook"].includes(mode)
    ? mode
    : EMPTY_MAINTENANCE_AGENT_CONFIG.plannerMode;
}

function normalizeAutoApproveRisk(value?: any) : any {
  const risk: any = normalizeRisk(value, EMPTY_MAINTENANCE_AGENT_CONFIG.autoApproveRisk);
  return AUTO_APPROVE_RISKS.includes(risk) ? risk : EMPTY_MAINTENANCE_AGENT_CONFIG.autoApproveRisk;
}

function normalizeWorkloadGrantId(value?: any) : any {
  const grantId: any = String(value || "").trim();
  return grantId.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(grantId)
    ? grantId
    : "";
}

function normalizePositiveInteger(value?: any, fallback?: any, { min = 1, max = 100000, allowZero = false }: Record<string, any> = {}) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (allowZero && parsed === 0) {
    return 0;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeSchedule(input?: any, fallback: Record<string, any> = {}) : any {
  const value: any = asPlainObject(input);
  const runbook: any = String(value.runbook || fallback.runbook || "").trim();
  const id: any = String(value.id || fallback.id || `schedule_${crypto.randomUUID()}`).trim();
  const intervalMinutes: any = normalizePositiveInteger(
    value.intervalMinutes ?? fallback.intervalMinutes,
    0,
    { min: 1, max: 525600, allowZero: true }
  );
  const normalizedRunbook: any = MAINTENANCE_RUNBOOK_CATALOG[runbook] ? runbook : "";
  return {
    id,
    label: String(value.label || fallback.label || id).trim(),
    enabled: value.enabled === true && Boolean(normalizedRunbook) && intervalMinutes > 0,
    runbook: normalizedRunbook,
    intervalMinutes,
    nextRunAt: String(value.nextRunAt || fallback.nextRunAt || "").trim()
  };
}

export function normalizeMaintenanceAgentConfig(input: Record<string, any> = {}) : any {
  const value: any = asPlainObject(input);
  const incomingSchedules: any = Array.isArray(value.schedules) ? value.schedules : [];
  const schedules: any = incomingSchedules.map((item?: any) : any => normalizeSchedule(item));

  return {
    schemaVersion: MAINTENANCE_AGENT_SCHEMA_VERSION,
    enabled: value.enabled === true,
    plannerMode: normalizePlannerMode(value.plannerMode),
    autoApproveRisk: normalizeAutoApproveRisk(value.autoApproveRisk),
    workloadGrantId: normalizeWorkloadGrantId(value.workloadGrantId),
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

async function readJsonIfExists(filePath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWriteJson(filePath?: any, value?: any) : Promise<any> {
  await atomicWriteJsonThroughState(filePath, value, {
    kind: "maintenance_agent.config.write"
  });
}

function maintenanceAgentConfigStateKey(userDataPath?: any) : any {
  return `maintenance-agent-config:${path.resolve(userDataPath)}`;
}

async function loadMaintenanceAgentConfigUnlocked(userDataPath?: any) : Promise<any> {
  const filePath: any = getMaintenanceAgentConfigPath(userDataPath);
  const parsed: any = await readJsonIfExists(filePath);
  return normalizeMaintenanceAgentConfig(parsed || EMPTY_MAINTENANCE_AGENT_CONFIG);
}

export async function loadMaintenanceAgentConfig(userDataPath?: any) : Promise<any> {
  await waitForStateIdle(maintenanceAgentConfigStateKey(userDataPath));
  return loadMaintenanceAgentConfigUnlocked(userDataPath);
}

async function saveMaintenanceAgentConfigUnlocked(userDataPath?: any, input: Record<string, any> = {}) : Promise<any> {
  const normalized: any = normalizeMaintenanceAgentConfig(input);
  await atomicWriteJson(getMaintenanceAgentConfigPath(userDataPath), normalized);
  return normalized;
}

export async function saveMaintenanceAgentConfig(userDataPath?: any, input: Record<string, any> = {}) : Promise<any> {
  return mutateState({
    key: maintenanceAgentConfigStateKey(userDataPath),
    kind: "maintenance_agent.config.save",
    metadata: { userDataPath },
    task: () : any => saveMaintenanceAgentConfigUnlocked(userDataPath, input)
  });
}

export function computeNextRunAt(schedule?: any, fromDate: any = new Date()) : any {
  const intervalMinutes: any = normalizePositiveInteger(schedule?.intervalMinutes, 0, {
    min: 1,
    max: 525600,
    allowZero: true
  });
  if (intervalMinutes <= 0) {
    throw new Error("Maintenance schedule intervalMinutes must be configured before execution.");
  }
  return new Date(fromDate.getTime() + intervalMinutes * 60 * 1000).toISOString();
}
