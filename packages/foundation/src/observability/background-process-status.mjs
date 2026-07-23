import fs from "node:fs/promises";
import path from "node:path";
import {
  composeUnifiedSystemStatus,
  unifiedRegistrationForProcess
} from "../unified-registration-core/unified-registration.mjs";
import {
  AGENT_WORKER_SUPPORTED_PROVIDERS,
  BACKGROUND_PROCESS_DEFINITIONS,
  BACKGROUND_PROCESS_SCHEMA_VERSION,
  IMPORT_PARSE_ACTIVE_STATUSES,
  MAINTENANCE_ACTIVE_STATUSES,
  SAFE_PATH_SEGMENT_PATTERN,
  SERVER_PROCESS_DEFINITIONS,
  isRoleEnabledByFeatures
} from "./background-process-definitions.mjs";

export {
  BACKGROUND_PROCESS_DEFINITIONS,
  BACKGROUND_PROCESS_SCHEMA_VERSION
} from "./background-process-definitions.mjs";

// Dependencies injected by composition root (server-runtime).
// Foundation must not statically import from runtime packages.
// Callers must call setBackgroundProcessDeps() before using exported functions.
let _deps = {
  atomicWriteJson: null,
  queueStateMutation: null,
  stateFileKey: null,
  loadSettings: null,
};

export function setBackgroundProcessDeps(deps) {
  if (deps) {
    _deps = { ..._deps, ...deps };
  }
}

function atomicWriteJson(filePath, payload) {
  if (!_deps.atomicWriteJson) throw new Error("background-process-status: atomicWriteJson not wired");
  return _deps.atomicWriteJson(filePath, payload);
}
function queueStateMutation(key, fn) {
  if (!_deps.queueStateMutation) throw new Error("background-process-status: queueStateMutation not wired");
  return _deps.queueStateMutation(key, fn);
}
function stateFileKey(filePath) {
  if (!_deps.stateFileKey) throw new Error("background-process-status: stateFileKey not wired");
  return _deps.stateFileKey(filePath);
}
async function loadSettings(userDataPath, opts) {
  if (!_deps.loadSettings) throw new Error("background-process-status: loadSettings not wired");
  return _deps.loadSettings(userDataPath, opts);
}

function nowIso() {
  return new Date().toISOString();
}

function stringValue(value) {
  return String(value || "").trim();
}

function safePathSegment(value, label = "path segment") {
  const text = stringValue(value);
  if (!SAFE_PATH_SEGMENT_PATTERN.test(text) || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0")) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

export function backgroundStateDirectory(userDataPath) {
  return path.join(userDataPath, "background");
}

export function backgroundStatePath(userDataPath) {
  return path.join(backgroundStateDirectory(userDataPath), "processes.json");
}

function systemInspectionStatePath(userDataPath) {
  return path.join(backgroundStateDirectory(userDataPath), "monitor-alerts-state.json");
}

function importJobsRootPath(userDataPath) {
  return path.join(userDataPath, "jobs");
}

function maintenanceAgentConfigPath(userDataPath) {
  return path.join(userDataPath, "maintenance-agent.json");
}

function maintenanceAgentRunsPath(userDataPath) {
  return path.join(userDataPath, "maintenance-agent-runs.jsonl");
}

function importJobMetaPath(userDataPath, jobId) {
  return path.join(importJobsRootPath(userDataPath), safePathSegment(jobId, "job id"), "meta.json");
}

export async function inspectImportParseWorkerDemand(userDataPath) {
  const jobsRootPath = importJobsRootPath(userDataPath);
  const demand = {
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
    const entries = await fs.readdir(jobsRootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const meta = JSON.parse(await fs.readFile(importJobMetaPath(userDataPath, entry.name), "utf8"));
        const status = String(meta.status || "").trim();
        if (!IMPORT_PARSE_ACTIVE_STATUSES.has(status)) {
          continue;
        }
        const jobId = String(meta.id || entry.name || "").trim();
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
  } catch (error) {
    demand.error = error instanceof Error ? error.message : String(error);
  }
  demand.activeCount = demand.queuedCount + demand.runningCount;
  demand.active = demand.activeCount > 0;
  demand.activeJobIds = demand.activeJobIds.filter(Boolean).sort();
  return demand;
}

async function readLatestMaintenanceRuns(userDataPath) {
  let content = "";
  try {
    content = await fs.readFile(maintenanceAgentRunsPath(userDataPath), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const latest = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const run = parsed?.run;
      if (run?.runId) {
        latest.set(run.runId, run);
      }
    } catch {
      // Ignore malformed historical run snapshots.
    }
  }
  return [...latest.values()];
}

export async function inspectMaintenanceWorkerDemand(userDataPath) {
  const configPath = maintenanceAgentConfigPath(userDataPath);
  const runsPath = maintenanceAgentRunsPath(userDataPath);
  const demand = {
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
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    demand.enabled = parsed?.enabled === true;
    const schedules = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
    demand.enabledScheduleCount = schedules.filter((schedule) => schedule?.enabled === true).length;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      demand.error = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    for (const run of await readLatestMaintenanceRuns(userDataPath)) {
      const status = String(run.status || "").trim();
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
  } catch (error) {
    demand.error = demand.error || (error instanceof Error ? error.message : String(error));
  }
  demand.activeRunCount = demand.queuedRunCount + demand.runningRunCount;
  demand.activeRunIds = demand.activeRunIds.filter(Boolean).sort();
  demand.active = (demand.enabled && demand.enabledScheduleCount > 0) || demand.activeRunCount > 0;
  return demand;
}

function agentEntryUid(entry = {}) {
  return stringValue(entry.uid || entry.instanceId || entry.alias);
}

function inspectAgentEntryAvailability(settings = {}, entry = {}) {
  const provider = stringValue(entry.provider);
  const model = stringValue(entry.model || entry.engine);
  const hasModel = Boolean(model);
  if (!AGENT_WORKER_SUPPORTED_PROVIDERS.has(provider)) {
    return {
      status: "unsupported",
      selectable: false,
      reason: "该智能体来源尚未接入服务端调用链路。"
    };
  }
  void settings;
  const hasUrl = Boolean(stringValue(entry.url || entry.baseUrl));
  const timeoutMs = Number(entry.timeoutMs || 0);
  const credentialConfigured = Boolean(
    entry.apiKeyConfigured ||
    entry.tokenConfigured ||
    stringValue(entry.apiKey || entry.token)
  );
  const credentialReady = provider === "local-model" || credentialConfigured;
  const headerReady = !credentialConfigured || Boolean(stringValue(entry.tokenHeader));
  if (!hasModel || !hasUrl || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !credentialReady || !headerReady) {
    return {
      status: "unconfigured",
      selectable: false,
      reason: "缺少模型、调用地址、超时或凭据配置。"
    };
  }
  return { status: "available", selectable: true, reason: "" };
}

export async function inspectAgentWorkerDemand(userDataPath) {
  const demand = {
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
    const settings = await loadSettings(userDataPath, { redactSecrets: false });
    const entries = Array.isArray(settings.modelLibraryAgents) ? settings.modelLibraryAgents : [];
    demand.modelCount = entries.length;
    demand.configured = entries.length > 0;
    for (const entry of entries) {
      const uid = agentEntryUid(entry);
      const availability = inspectAgentEntryAvailability(settings, entry);
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
  } catch (error) {
    demand.reason = "inspection_failed";
    demand.error = error instanceof Error ? error.message : String(error);
  }
  demand.availableAgentIds = demand.availableAgentIds.filter(Boolean).sort();
  demand.unavailableAgentIds = demand.unavailableAgentIds.filter(Boolean).sort();
  demand.unsupportedAgentIds = demand.unsupportedAgentIds.filter(Boolean).sort();
  return demand;
}

export function statusForInactiveDemand(demand = {}) {
  const reason = stringValue(demand.reason);
  if (reason === "not_configured" || reason === "not_connected" || reason === "inspection_failed") {
    return reason;
  }
  return "standby";
}

export function normalizeBackgroundRoleList(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const known = new Set(BACKGROUND_PROCESS_DEFINITIONS.map((item) => item.role));
  const roles = requested.length
    ? requested.filter((item) => known.has(item))
    : BACKGROUND_PROCESS_DEFINITIONS.map((item) => item.role);
  return [...new Set(roles)].filter(isRoleEnabledByFeatures);
}

export function backgroundDefinitionForRole(role) {
  return [...BACKGROUND_PROCESS_DEFINITIONS, ...SERVER_PROCESS_DEFINITIONS].find((item) => item.role === role) || {
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

export async function writeBackgroundProcessState(userDataPath, state) {
  const filePath = backgroundStatePath(userDataPath);
  const payload = {
    schemaVersion: BACKGROUND_PROCESS_SCHEMA_VERSION,
    updatedAt: nowIso(),
    ...state
  };
  return queueStateMutation(stateFileKey(filePath), async () => {
    await atomicWriteJson(filePath, payload);
    return payload;
  });
}

async function readStateFile(userDataPath) {
  try {
    return JSON.parse(await fs.readFile(backgroundStatePath(userDataPath), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isPidAlive(pid) {
  const numericPid = Number(pid || 0);
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

function withRuntimeStatus(processRecord, nowMs) {
  const lastHeartbeatAt = String(processRecord.lastHeartbeatAt || "");
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  const startedAtMs = Date.parse(String(processRecord.startedAt || ""));
  const withinStartupGrace =
    Number.isFinite(startedAtMs) && nowMs - startedAtMs <= 15000;
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
  const alive = isPidAlive(processRecord.pid);
  const stale = !withinStartupGrace && (heartbeatAgeMs === null || heartbeatAgeMs > 15000);
  const desired = processRecord.desired !== false;
  let status = String(processRecord.status || "unknown");
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

function demandForRole(role, demandByRole = {}) {
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

function desiredForRole(role, demandByRole = {}) {
  const demand = demandForRole(role, demandByRole);
  return demand ? demand.active : true;
}

function attachDemandDetails(processRecord, role, demandByRole = {}) {
  const demand = demandForRole(role, demandByRole);
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

function processRecordForDefinition(definition, existing = {}, demandByRole = {}) {
  const desired = desiredForRole(definition.role, demandByRole);
  const alive = isPidAlive(existing.pid);
  const inactiveStatus = statusForInactiveDemand(demandForRole(definition.role, demandByRole) || {});
  const status = desired
    ? String(existing.status || "missing")
    : alive
      ? String(existing.status || inactiveStatus)
      : inactiveStatus;
  return attachDemandDetails(
    {
      ...definition,
      pid: 0,
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

function serverMainProcess(nowMs) {
  const definition = backgroundDefinitionForRole("server-main");
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

function backgroundSupervisorProcess(supervisor, nowMs, stateUpdatedAt = "") {
  const definition = backgroundDefinitionForRole("background-supervisor");
  const alive = isPidAlive(supervisor?.pid);
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

function attachProcessRegistration(processItem) {
  return {
    ...processItem,
    unifiedRegistration: unifiedRegistrationForProcess(processItem)
  };
}

function buildProcessSystemStatus(processes, updatedAt = "") {
  return composeUnifiedSystemStatus(
    processes.map((item) => item.unifiedRegistration || unifiedRegistrationForProcess(item)),
    {
      source: "background-process-status",
      updatedAt: updatedAt || nowIso()
    }
  );
}

export async function getBackgroundProcessStatus(userDataPath) {
  const state = await readStateFile(userDataPath);
  const nowMs = Date.now();
  const definitions = BACKGROUND_PROCESS_DEFINITIONS;
  const demandByRole = {
    importWorker: await inspectImportParseWorkerDemand(userDataPath),
    maintenanceWorker: await inspectMaintenanceWorkerDemand(userDataPath),
    agentWorker: await inspectAgentWorkerDemand(userDataPath)
  };
  if (!state) {
    const supervisor = {
      pid: 0,
      alive: false,
      status: "stopped"
    };
    const processes = [
      serverMainProcess(nowMs),
      backgroundSupervisorProcess(supervisor, nowMs),
      ...definitions.map((definition) => attachDemandDetails({
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

  const supervisor = {
    ...(state.supervisor || {}),
    alive: isPidAlive(state.supervisor?.pid),
    status: isPidAlive(state.supervisor?.pid) ? "running" : "stopped"
  };
  const byRole = new Map((state.processes || []).map((item) => [item.role, item]));
  const processes = definitions.map((definition) =>
    withRuntimeStatus(
      processRecordForDefinition(definition, byRole.get(definition.role) || {}, demandByRole),
      nowMs
    )
  );
  processes.unshift(backgroundSupervisorProcess(supervisor, nowMs, state.updatedAt || ""));
  processes.unshift(serverMainProcess(nowMs));
  processes.push(await getSystemInspectionProcess(userDataPath, nowMs));
  const registeredProcesses = processes.map(attachProcessRegistration);
  const failedCount = registeredProcesses.filter((item) =>
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

async function getSystemInspectionProcess(userDataPath, nowMs) {
  let state = null;
  try {
    state = JSON.parse(await fs.readFile(systemInspectionStatePath(userDataPath), "utf8"));
  } catch {
    state = null;
  }
  const daemon = state?.inspectionDaemon || {};
  const definition = backgroundDefinitionForRole("system-inspection");
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
