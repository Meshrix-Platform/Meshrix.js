import fs from "node:fs/promises";
import path from "node:path";
import {
  composeUnifiedSystemStatus,
  unifiedRegistrationForProcess
} from "../unified-registration-core/unified-registration.ts";
import {
  AGENT_WORKER_SUPPORTED_PROVIDERS,
  BACKGROUND_PROCESS_DEFINITIONS,
  BACKGROUND_PROCESS_SCHEMA_VERSION,
  IMPORT_PARSE_ACTIVE_STATUSES,
  MAINTENANCE_ACTIVE_STATUSES,
  SAFE_PATH_SEGMENT_PATTERN,
  SERVER_PROCESS_DEFINITIONS,
  isRoleEnabledByFeatures
} from "./background-process-definitions.ts";

export {
  BACKGROUND_PROCESS_DEFINITIONS,
  BACKGROUND_PROCESS_SCHEMA_VERSION
} from "./background-process-definitions.ts";

// Dependencies injected by composition root (server-runtime).
// Foundation must not statically import from runtime packages.
// Callers must call setBackgroundProcessDeps() before using exported functions.
let _deps: Record<string, any> = {
  atomicWriteJson: null,
  queueStateMutation: null,
  stateFileKey: null,
  loadSettings: null,
};

export function setBackgroundProcessDeps(deps?: any) : any {
  if (deps) {
    _deps = { ..._deps, ...deps };
  }
}

function atomicWriteJson(filePath?: any, payload?: any) : any {
  if (!_deps.atomicWriteJson) throw new Error("background-process-status: atomicWriteJson not wired");
  return _deps.atomicWriteJson(filePath, payload);
}
function queueStateMutation(key?: any, fn?: any) : any {
  if (!_deps.queueStateMutation) throw new Error("background-process-status: queueStateMutation not wired");
  return _deps.queueStateMutation(key, fn);
}
function stateFileKey(filePath?: any) : any {
  if (!_deps.stateFileKey) throw new Error("background-process-status: stateFileKey not wired");
  return _deps.stateFileKey(filePath);
}
async function loadSettings(userDataPath?: any, opts?: any) : Promise<any> {
  if (!_deps.loadSettings) throw new Error("background-process-status: loadSettings not wired");
  return _deps.loadSettings(userDataPath, opts);
}

function nowIso() : any {
  return new Date().toISOString();
}

function stringValue(value?: any) : any {
  return String(value || "").trim();
}

function safePathSegment(value?: any, label: any = "path segment") : any {
  const text: any = stringValue(value);
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

export function backgroundStateDirectory(userDataPath?: any) : any {
  return path.join(userDataPath, "background");
}

export function backgroundStatePath(userDataPath?: any) : any {
  return path.join(backgroundStateDirectory(userDataPath), "processes.json");
}

function systemInspectionStatePath(userDataPath?: any) : any {
  return path.join(backgroundStateDirectory(userDataPath), "monitor-alerts-state.json");
}

function importJobsRootPath(userDataPath?: any) : any {
  return path.join(userDataPath, "jobs");
}

function maintenanceAgentConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, "maintenance-agent.json");
}

function maintenanceAgentRunsPath(userDataPath?: any) : any {
  return path.join(userDataPath, "maintenance-agent-runs.jsonl");
}

function importJobMetaPath(userDataPath?: any, jobId?: any) : any {
  return path.join(importJobsRootPath(userDataPath), safePathSegment(jobId, "job id"), "meta.json");
}

export async function inspectImportParseWorkerDemand(userDataPath?: any) : Promise<any> {
  const jobsRootPath: any = importJobsRootPath(userDataPath);
  const demand: Record<string, any> = {
    kind: "import_parse_job",
    active: false,
    activeCount: 0,
    queuedCount: 0,
    runningCount: 0,
    activeJobIds: [],
    jobsRootPath,
    checkedAt: nowIso()
  };
  try {
    await fs.mkdir(jobsRootPath, { recursive: true });
    const entries: any = await fs.readdir(jobsRootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const meta: any = JSON.parse(await fs.readFile(importJobMetaPath(userDataPath, entry.name), "utf8"));
        const status: any = String(meta.status || "").trim();
        if (!IMPORT_PARSE_ACTIVE_STATUSES.has(status)) {
          continue;
        }
        const jobId: any = String(meta.id || entry.name || "").trim();
        demand.activeJobIds.push(jobId);
        if (status === "queued") {
          demand.queuedCount += 1;
        } else if (status === "running") {
          demand.runningCount += 1;
        }
      } catch {
        // Ignore malformed historical job entries.
      }
    }
  } catch (error: any) {
    demand.error = error instanceof Error ? error.message : String(error);
  }
  demand.activeCount = demand.queuedCount + demand.runningCount;
  demand.active = demand.activeCount > 0;
  demand.activeJobIds = demand.activeJobIds.filter(Boolean).sort();
  return demand;
}

async function readLatestMaintenanceRuns(userDataPath?: any) : Promise<any> {
  let content: any = "";
  try {
    content = await fs.readFile(maintenanceAgentRunsPath(userDataPath), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const latest: any = new Map<any, any>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed: any = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: any = JSON.parse(trimmed);
      const run: any = parsed?.run;
      if (run?.runId) {
        latest.set(run.runId, run);
      }
    } catch {
      // Ignore malformed historical run snapshots.
    }
  }
  return [...latest.values()];
}

export async function inspectMaintenanceWorkerDemand(userDataPath?: any) : Promise<any> {
  const configPath: any = maintenanceAgentConfigPath(userDataPath);
  const runsPath: any = maintenanceAgentRunsPath(userDataPath);
  const demand: Record<string, any> = {
    kind: "maintenance_agent",
    active: false,
    configPath,
    runsPath,
    enabled: false,
    enabledScheduleCount: 0,
    activeRunCount: 0,
    queuedRunCount: 0,
    runningRunCount: 0,
    activeRunIds: [],
    checkedAt: nowIso()
  };
  try {
    const parsed: any = JSON.parse(await fs.readFile(configPath, "utf8"));
    demand.enabled = parsed?.enabled === true;
    const schedules: any = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
    demand.enabledScheduleCount = schedules.filter((schedule?: any) : any => schedule?.enabled === true).length;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      demand.error = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    for (const run of await readLatestMaintenanceRuns(userDataPath)) {
      const status: any = String(run.status || "").trim();
      if (!MAINTENANCE_ACTIVE_STATUSES.has(status)) {
        continue;
      }
      demand.activeRunIds.push(String(run.runId || "").trim());
      if (status === "queued") {
        demand.queuedRunCount += 1;
      } else if (status === "running") {
        demand.runningRunCount += 1;
      }
    }
  } catch (error: any) {
    demand.error = demand.error || (error instanceof Error ? error.message : String(error));
  }
  demand.activeRunCount = demand.queuedRunCount + demand.runningRunCount;
  demand.activeRunIds = demand.activeRunIds.filter(Boolean).sort();
  demand.active = (demand.enabled && demand.enabledScheduleCount > 0) || demand.activeRunCount > 0;
  return demand;
}

function agentEntryUid(entry: Record<string, any> = {}) : any {
  return stringValue(entry.uid || entry.instanceId || entry.alias);
}

function inspectAgentEntryAvailability(settings: Record<string, any> = {}, entry: Record<string, any> = {}) : any {
  const provider: any = stringValue(entry.provider);
  const model: any = stringValue(entry.model || entry.engine);
  const hasModel: any = Boolean(model);
  if (!AGENT_WORKER_SUPPORTED_PROVIDERS.has(provider)) {
    return {
      status: "unsupported",
      selectable: false,
      reason: "该智能体来源尚未接入服务端调用链路。"
    };
  }
  void settings;
  const hasUrl: any = Boolean(stringValue(entry.url || entry.baseUrl));
  const timeoutMs: any = Number(entry.timeoutMs || 0);
  const credentialConfigured: any = Boolean(
    entry.apiKeyConfigured ||
    entry.tokenConfigured ||
    stringValue(entry.apiKey || entry.token)
  );
  const credentialReady: any = provider === "local-model" || credentialConfigured;
  const headerReady: any = !credentialConfigured || Boolean(stringValue(entry.tokenHeader));
  if (!hasModel || !hasUrl || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !credentialReady || !headerReady) {
    return {
      status: "unconfigured",
      selectable: false,
      reason: "缺少模型、调用地址、超时或凭据配置。"
    };
  }
  return { status: "available", selectable: true, reason: "" };
}

export async function inspectAgentWorkerDemand(userDataPath?: any) : Promise<any> {
  const demand: Record<string, any> = {
    kind: "agent_runtime",
    active: false,
    reason: "not_configured",
    configured: false,
    connected: false,
    modelCount: 0,
    availableModelCount: 0,
    unavailableModelCount: 0,
    unsupportedModelCount: 0,
    activeTaskCount: 0,
    availableAgentIds: [],
    unavailableAgentIds: [],
    unsupportedAgentIds: [],
    checkedAt: nowIso()
  };
  try {
    const settings: any = await loadSettings(userDataPath, { redactSecrets: false });
    const entries: any = Array.isArray(settings.modelLibraryAgents) ? settings.modelLibraryAgents : [];
    demand.modelCount = entries.length;
    demand.configured = entries.length > 0;
    for (const entry of entries) {
      const uid: any = agentEntryUid(entry);
      const availability: any = inspectAgentEntryAvailability(settings, entry);
      if (availability.status === "available") {
        demand.availableModelCount += 1;
        demand.availableAgentIds.push(uid);
        continue;
      }
      if (availability.status === "unsupported") {
        demand.unsupportedModelCount += 1;
        demand.unsupportedAgentIds.push(uid);
      } else {
        demand.unavailableModelCount += 1;
        demand.unavailableAgentIds.push(uid);
      }
    }
    demand.connected = demand.availableModelCount > 0;
    demand.reason = !demand.configured
      ? "not_configured"
      : demand.connected
        ? "idle"
        : "not_connected";
  } catch (error: any) {
    demand.reason = "inspection_failed";
    demand.error = error instanceof Error ? error.message : String(error);
  }
  demand.availableAgentIds = demand.availableAgentIds.filter(Boolean).sort();
  demand.unavailableAgentIds = demand.unavailableAgentIds.filter(Boolean).sort();
  demand.unsupportedAgentIds = demand.unsupportedAgentIds.filter(Boolean).sort();
  return demand;
}

export function statusForInactiveDemand(demand: Record<string, any> = {}) : any {
  const reason: any = stringValue(demand.reason);
  if (reason === "not_configured" || reason === "not_connected" || reason === "inspection_failed") {
    return reason;
  }
  return "standby";
}

export function normalizeBackgroundRoleList(value?: any) : any {
  const requested: any = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item?: any) : any => item.trim())
        .filter(Boolean);
  const known: any = new Set<any>(BACKGROUND_PROCESS_DEFINITIONS.map((item?: any) : any => item.role));
  const roles: any = requested.length
    ? requested.filter((item?: any) : any => known.has(item))
    : BACKGROUND_PROCESS_DEFINITIONS.map((item?: any) : any => item.role);
  return [...new Set<any>(roles)].filter(isRoleEnabledByFeatures);
}

export function backgroundDefinitionForRole(role?: any) : any {
  return [...BACKGROUND_PROCESS_DEFINITIONS, ...SERVER_PROCESS_DEFINITIONS].find((item?: any) : any => item.role === role) || {
    role,
    label: role,
    description: "",
    processType: "service",
    responsibility: "",
    services: [],
    features: [],
    monitors: [],
    alerts: []
  };
}

export async function writeBackgroundProcessState(userDataPath?: any, state?: any) : Promise<any> {
  const filePath: any = backgroundStatePath(userDataPath);
  const payload: Record<string, any> = {
    schemaVersion: BACKGROUND_PROCESS_SCHEMA_VERSION,
    updatedAt: nowIso(),
    ...state
  };
  return queueStateMutation(stateFileKey(filePath), async () : Promise<any> => {
    await atomicWriteJson(filePath, payload);
    return payload;
  });
}

async function readStateFile(userDataPath?: any) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(backgroundStatePath(userDataPath), "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isPidAlive(pid?: any) : any {
  const numericPid: any = Number(pid || 0);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function withRuntimeStatus(processRecord?: any, nowMs?: any) : any {
  const lastHeartbeatAt: any = String(processRecord.lastHeartbeatAt || "");
  const heartbeatMs: any = Date.parse(lastHeartbeatAt);
  const startedAtMs: any = Date.parse(String(processRecord.startedAt || ""));
  const withinStartupGrace: any =
    Number.isFinite(startedAtMs) && nowMs - startedAtMs <= 15000;
  const heartbeatAgeMs: any = Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
  const alive: any = isPidAlive(processRecord.pid);
  const stale: any = !withinStartupGrace && (heartbeatAgeMs === null || heartbeatAgeMs > 15000);
  const desired: any = processRecord.desired !== false;
  let status: any = String(processRecord.status || "unknown");
  if (desired && (!alive || stale)) {
    status = alive ? "stale" : "stopped";
  }
  return {
    ...processRecord,
    alive,
    stale,
    status,
    heartbeatAgeMs
  };
}

function demandForRole(role?: any, demandByRole: Record<string, any> = {}) : any {
  if (role === "import-worker") {
    return demandByRole.importWorker || null;
  }
  if (role === "maintenance-worker") {
    return demandByRole.maintenanceWorker || null;
  }
  if (role === "agent-worker") {
    return demandByRole.agentWorker || null;
  }
  return null;
}

function desiredForRole(role?: any, demandByRole: Record<string, any> = {}) : any {
  const demand: any = demandForRole(role, demandByRole);
  return demand ? demand.active : true;
}

function attachDemandDetails(processRecord?: any, role?: any, demandByRole: Record<string, any> = {}) : any {
  const demand: any = demandForRole(role, demandByRole);
  if (!demand) {
    return processRecord;
  }
  return {
    ...processRecord,
    details: {
      ...(processRecord.details || {}),
      demand
    }
  };
}

function processRecordForDefinition(definition?: any, existing: Record<string, any> = {}, demandByRole: Record<string, any> = {}) : any {
  const desired: any = desiredForRole(definition.role, demandByRole);
  const alive: any = isPidAlive(existing.pid);
  const inactiveStatus: any = statusForInactiveDemand(demandForRole(definition.role, demandByRole) || {});
  const status: any = desired
    ? String(existing.status || "missing")
    : alive
      ? String(existing.status || inactiveStatus)
      : inactiveStatus;
  return attachDemandDetails(
    {
      ...definition,
      restartCount: 0,
      ...existing,
      desired,
      status,
      pid: desired || alive ? Number(existing.pid || 0) : 0,
      stale: desired ? existing.stale : false
    },
    definition.role,
    demandByRole
  );
}

function serverMainProcess(nowMs?: any) : any {
  const definition: any = backgroundDefinitionForRole("server-main");
  return withRuntimeStatus(
    {
      ...definition,
      desired: true,
      pid: process.pid,
      alive: true,
      stale: false,
      status: "running",
      mode: "node-service",
      startedAt: new Date(nowMs - Math.round(process.uptime() * 1000)).toISOString(),
      lastHeartbeatAt: nowIso(),
      restartCount: 0,
      lastExit: null,
      details: {
        nodeVersion: process.version,
        platform: process.platform,
        cwd: process.cwd()
      },
      error: ""
    },
    nowMs
  );
}

function backgroundSupervisorProcess(supervisor?: any, nowMs?: any, stateUpdatedAt: any = "") : any {
  const definition: any = backgroundDefinitionForRole("background-supervisor");
  const alive: any = isPidAlive(supervisor?.pid);
  return withRuntimeStatus(
    {
      ...definition,
      desired: true,
      pid: Number(supervisor?.pid || 0),
      alive,
      stale: !alive,
      status: alive ? "running" : "stopped",
      mode: "node-daemon",
      startedAt: supervisor?.startedAt || "",
      lastHeartbeatAt: stateUpdatedAt || supervisor?.updatedAt || supervisor?.startedAt || "",
      restartCount: 0,
      lastExit: null,
      details: {
        intervalMs: supervisor?.intervalMs || 0,
        restartDelayMs: supervisor?.restartDelayMs || 0,
        roles: supervisor?.roles || []
      },
      error: ""
    },
    nowMs
  );
}

function attachProcessRegistration(processItem?: any) : any {
  return {
    ...processItem,
    unifiedRegistration: unifiedRegistrationForProcess(processItem)
  };
}

function buildProcessSystemStatus(processes?: any, updatedAt: any = "") : any {
  return composeUnifiedSystemStatus(
    processes.map((item?: any) : any => item.unifiedRegistration || unifiedRegistrationForProcess(item)),
    {
      source: "background-process-status",
      updatedAt: updatedAt || nowIso()
    }
  );
}

export async function getBackgroundProcessStatus(userDataPath?: any) : Promise<any> {
  const state: any = await readStateFile(userDataPath);
  const nowMs: any = Date.now();
  const definitions: any = BACKGROUND_PROCESS_DEFINITIONS;
  const demandByRole: Record<string, any> = {
    importWorker: await inspectImportParseWorkerDemand(userDataPath),
    maintenanceWorker: await inspectMaintenanceWorkerDemand(userDataPath),
    agentWorker: await inspectAgentWorkerDemand(userDataPath)
  };
  if (!state) {
    const supervisor: Record<string, any> = {
      pid: 0,
      alive: false,
      status: "stopped"
    };
    const processes: any = [
      serverMainProcess(nowMs),
      backgroundSupervisorProcess(supervisor, nowMs),
      ...definitions.map((definition?: any) : any => attachDemandDetails({
        ...definition,
        desired: desiredForRole(definition.role, demandByRole),
        pid: 0,
        alive: false,
        stale: desiredForRole(definition.role, demandByRole),
        status: desiredForRole(definition.role, demandByRole)
          ? "missing"
          : statusForInactiveDemand(demandForRole(definition.role, demandByRole) || {}),
        restartCount: 0,
        heartbeatAgeMs: null
      }, definition.role, demandByRole)),
      await getSystemInspectionProcess(userDataPath, nowMs)
    ].map(attachProcessRegistration);
    return {
      schemaVersion: BACKGROUND_PROCESS_SCHEMA_VERSION,
      ok: false,
      status: "unavailable",
      updatedAt: "",
      statePath: backgroundStatePath(userDataPath),
      supervisor,
      processes,
      systemStatus: buildProcessSystemStatus(processes)
    };
  }

  const supervisor: Record<string, any> = {
    ...(state.supervisor || {}),
    alive: isPidAlive(state.supervisor?.pid),
    status: isPidAlive(state.supervisor?.pid) ? "running" : "stopped"
  };
  const byRole: any = new Map<any, any>((state.processes || []).map((item?: any) : any => [item.role, item]));
  const processes: any = definitions.map((definition?: any) : any =>
    withRuntimeStatus(
      processRecordForDefinition(definition, byRole.get(definition.role) || {}, demandByRole),
      nowMs
    )
  );
  processes.unshift(backgroundSupervisorProcess(supervisor, nowMs, state.updatedAt || ""));
  processes.unshift(serverMainProcess(nowMs));
  processes.push(await getSystemInspectionProcess(userDataPath, nowMs));
  const registeredProcesses: any = processes.map(attachProcessRegistration);
  const failedCount: any = registeredProcesses.filter((item?: any) : any =>
    item.desired && !["running", "standby"].includes(item.status)
  ).length;
  return {
    ...state,
    ok: supervisor.alive && failedCount === 0,
    status: supervisor.alive
      ? failedCount === 0
        ? "healthy"
        : "degraded"
      : "supervisor_stopped",
    statePath: backgroundStatePath(userDataPath),
    supervisor,
    processes: registeredProcesses,
    systemStatus: buildProcessSystemStatus(registeredProcesses, state.updatedAt || "")
  };
}

async function getSystemInspectionProcess(userDataPath?: any, nowMs?: any) : Promise<any> {
  let state: any = null;
  try {
    state = JSON.parse(await fs.readFile(systemInspectionStatePath(userDataPath), "utf8"));
  } catch {
    state = null;
  }
  const daemon: any = state?.inspectionDaemon || {};
  const definition: any = backgroundDefinitionForRole("system-inspection");
  return withRuntimeStatus(
    {
      ...definition,
      role: "system-inspection",
      desired: true,
      pid: Number(daemon.pid || 0),
      status: state ? "running" : "missing",
      mode: "system-js",
      startedAt: "",
      lastHeartbeatAt: state?.updatedAt || "",
      restartCount: 0,
      lastExit: null,
      details: {
        alertStatus: state?.status || "unknown",
        activeCount: state?.summary?.activeCount || 0,
        criticalCount: state?.summary?.criticalCount || 0,
        warningCount: state?.summary?.warningCount || 0,
        shellConfigPath: state?.shellConfigPath || "",
        statePath: state?.statePath || systemInspectionStatePath(userDataPath)
      },
      error: ""
    },
    nowMs
  );
}
