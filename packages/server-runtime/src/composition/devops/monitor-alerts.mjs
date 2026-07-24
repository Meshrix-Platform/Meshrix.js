import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getBackgroundProcessStatus,
  setBackgroundProcessDeps
} from "../../../../foundation/src/observability/background-process-status.mjs";
import {
  activateAlertRecord,
  createAlertRecord,
  transitionAlertRecord
} from "../../../../foundation/src/observability/alert-service.mjs";
import {
  ALERT_LIFECYCLE_STATES,
  normalizeAlertSignal,
  stableAlertReference
} from "../../../../foundation/src/observability/alert-contract.mjs";
import { createBoundedMetricRegistry } from "../../../../foundation/src/observability/metric-registry.mjs";
import {
  normalizeObservabilityConfig,
  observabilityConfigForPersistence,
  unconfiguredObservabilityConfig
} from "../../../../foundation/src/observability/observability-config.mjs";
import {
  OBSERVABILITY_BUDGETS,
  ObservabilityBudgetError,
  startObservabilityBudgetObservation,
  throwIfObservabilityAborted
} from "../../../../foundation/src/observability/observability-budgets.mjs";
import { sanitizeSensitiveReport } from "../../../../foundation/src/observability/sensitive-report-scan.mjs";
import {
  composeUnifiedSystemStatus,
  unifiedRegistrationForAlert,
  unifiedRegistrationForMonitor
} from "../../../../foundation/src/unified-registration-core/unified-registration.mjs";
import {
  atomicWriteJson as runtimeAtomicWriteJson,
  queueStateMutation,
  stateFileKey
} from "../../state/state-coordinator.mjs";
import { loadSettings } from "../settings.mjs";

setBackgroundProcessDeps({
  atomicWriteJson: runtimeAtomicWriteJson,
  queueStateMutation,
  stateFileKey,
  loadSettings
});

const ALERT_DIR = "background";
const ALERT_CONFIG_FILE = "monitor-alerts.json";
const ALERT_SHELL_CONFIG_FILE = "monitor-alerts.sh.conf";
const ALERT_STATE_FILE = "monitor-alerts-state.json";

const RUNTIME_RULES = Object.freeze({
  supervisorStopped: Object.freeze({
    severity: "critical",
    title: "Background supervisor unavailable",
    message: "The background supervisor is not reporting a healthy state."
  }),
  processNotRunning: Object.freeze({
    severity: "critical",
    statuses: Object.freeze(["missing", "stopped", "failed", "exited"]),
    title: "Background process unavailable",
    message: "A required background process is not running."
  }),
  processStale: Object.freeze({
    severity: "warning",
    statuses: Object.freeze(["stale", "degraded"]),
    title: "Background process heartbeat stale",
    message: "A required background process has a stale heartbeat."
  }),
  processRestarted: Object.freeze({
    severity: "warning",
    restartCountThreshold: 1,
    title: "Background process restarted",
    message: "A required background process was restarted."
  }),
  queueInterrupted: Object.freeze({
    severity: "critical",
    title: "Work queue interrupted",
    message: "A canonical work queue item failed or expired."
  })
});

function nowIso() {
  return new Date().toISOString();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function fixedText(value = "", maxLength = 64) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, maxLength);
}

export function monitorAlertConfigPath(userDataPath) {
  return path.join(userDataPath, ALERT_DIR, ALERT_CONFIG_FILE);
}

export function monitorAlertShellConfigPath(userDataPath) {
  return path.join(userDataPath, ALERT_DIR, ALERT_SHELL_CONFIG_FILE);
}

export function monitorAlertStatePath(userDataPath) {
  return path.join(userDataPath, ALERT_DIR, ALERT_STATE_FILE);
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, value, { signal } = {}) {
  throwIfObservabilityAborted(signal);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    throwIfObservabilityAborted(signal);
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

function runtimeSettings(config) {
  const configured = config?.configurationState === "configured";
  const enabled = configured && config.enabled === true;
  const rules = {};
  for (const [ruleId, userRule] of Object.entries(asObject(config?.rules))) {
    const definition = RUNTIME_RULES[ruleId];
    if (!definition || userRule?.enabled !== true) continue;
    rules[ruleId] = Object.freeze({
      ...definition,
      ...userRule,
      statuses: Array.isArray(userRule.statuses) ? Object.freeze([...userRule.statuses]) : definition.statuses
    });
  }
  return Object.freeze({
    configurationState: configured ? "configured" : "unconfigured",
    enabled,
    intervalMs: config?.intervalMs ?? 5_000,
    heartbeatStaleMs: config?.heartbeatStaleMs ?? 15_000,
    historyLimit: Math.min(config?.historyLimit ?? OBSERVABILITY_BUDGETS.maxAlertHistory, OBSERVABILITY_BUDGETS.maxAlertHistory),
    supervisorRecovery: asObject(config?.supervisorRecovery),
    rules: Object.freeze(rules)
  });
}

export async function loadMonitorAlertConfig(userDataPath) {
  const stored = await readJsonIfExists(monitorAlertConfigPath(userDataPath), null);
  return stored === null ? unconfiguredObservabilityConfig() : normalizeObservabilityConfig(stored);
}

async function writeMonitorAlertShellConfig(userDataPath, config) {
  const filePath = monitorAlertShellConfigPath(userDataPath);
  if (config.configurationState !== "configured") {
    await fs.rm(filePath, { force: true });
    return;
  }
  const runtime = runtimeSettings(config);
  const processRule = runtime.rules.processNotRunning;
  const payload = [
    `ALERTS_CONFIGURED=1`,
    `ALERTS_ENABLED=${runtime.enabled ? "1" : "0"}`,
    `INTERVAL_SECONDS=${Math.max(1, Math.round(runtime.intervalMs / 1_000))}`,
    `HISTORY_LIMIT=${runtime.historyLimit}`,
    `PROCESS_NOT_RUNNING_ENABLED=${processRule ? "1" : "0"}`,
    ""
  ].join("\n");
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
}

export async function saveMonitorAlertConfig(userDataPath, input) {
  const normalized = normalizeObservabilityConfig(input);
  const persisted = observabilityConfigForPersistence(normalized);
  if (persisted === null) {
    await Promise.all([
      fs.rm(monitorAlertConfigPath(userDataPath), { force: true }),
      fs.rm(monitorAlertShellConfigPath(userDataPath), { force: true })
    ]);
    return unconfiguredObservabilityConfig();
  }
  await atomicWriteJson(monitorAlertConfigPath(userDataPath), persisted);
  await writeMonitorAlertShellConfig(userDataPath, normalized);
  return normalized;
}

function buildAlert({ alertId, ruleId, rule, source, role, status, resourceRef, ackRequired = false, tone = "" }) {
  return normalizeAlertSignal({
    alertId,
    ruleId,
    category: source === "work-queue-observation" ? "queue" : "runtime",
    severity: rule.severity,
    title: rule.title,
    message: rule.message,
    source,
    role,
    status,
    resourceRef,
    ackRequired,
    tone
  });
}

function attachAlertRegistration(alert) {
  return Object.freeze({ ...alert, unifiedRegistration: unifiedRegistrationForAlert(alert) });
}

function alertMap(state = {}) {
  return new Map([
    ...(Array.isArray(state.activeAlerts) ? state.activeAlerts : []),
    ...(Array.isArray(state.history) ? state.history : [])
  ].map((alert) => [String(alert.alertId || ""), alert]).filter(([id]) => id));
}

function mergeAlertHistory({ previous = {}, signals = [], limit, signal }) {
  const priorById = alertMap(previous);
  const nextActive = [];
  const currentIds = new Set();
  for (const candidate of signals) {
    throwIfObservabilityAborted(signal);
    if (currentIds.size >= OBSERVABILITY_BUDGETS.maxActiveAlerts) {
      throw new ObservabilityBudgetError("observability_active_alert_budget_exceeded");
    }
    currentIds.add(candidate.alertId);
    nextActive.push(activateAlertRecord(candidate, priorById.get(candidate.alertId), { signal }));
  }
  const nextHistory = [];
  for (const prior of priorById.values()) {
    throwIfObservabilityAborted(signal);
    if (currentIds.has(prior.alertId)) continue;
    let resolved = prior;
    if (["firing", "acknowledged", "notification_failed"].includes(prior.lifecycleStatus)) {
      resolved = transitionAlertRecord(prior, "resolve", { reason: "condition_recovered", signal });
    } else if (prior.lifecycleStatus === "suppressed") {
      resolved = transitionAlertRecord(prior, "archive", { reason: "retention_archived", signal });
    }
    nextHistory.push(resolved);
  }
  for (const active of nextActive) nextHistory.push(active);
  const history = [...new Map(nextHistory.map((alert) => [alert.alertId, alert])).values()]
    .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")))
    .slice(0, limit);
  return Object.freeze({
    active: Object.freeze(nextActive.filter((alert) => alert.active !== false)),
    history: Object.freeze(history)
  });
}

function evaluateWorkQueueAlerts({ workQueueObservation, config, signal }) {
  const rule = config.rules.queueInterrupted;
  if (!config.enabled || !rule || !workQueueObservation) return [];
  const alerts = [];
  const seen = new Set();
  for (const item of Array.isArray(workQueueObservation.items) ? workQueueObservation.items : []) {
    throwIfObservabilityAborted(signal);
    const workItemId = String(item?.workItemId || "");
    if (!workItemId || seen.has(workItemId) || item.observationStatus !== "interrupted") continue;
    seen.add(workItemId);
    const ref = stableAlertReference(workItemId);
    alerts.push(buildAlert({
      alertId: `monitor.queue.${ref}.interrupted`,
      ruleId: "queueInterrupted",
      rule,
      source: "work-queue-observation",
      role: fixedText(item.queueDefinitionId || "work_item"),
      status: "interrupted",
      resourceRef: ref
    }));
  }
  return alerts;
}

function evaluateAlerts({ backgroundStatus, workQueueObservation, config, signal }) {
  if (!config.enabled) return [];
  const alerts = [];
  const supervisorRule = config.rules.supervisorStopped;
  if (supervisorRule && !backgroundStatus?.supervisor?.alive) {
    alerts.push(buildAlert({
      alertId: "monitor.supervisor.stopped",
      ruleId: "supervisorStopped",
      rule: supervisorRule,
      source: "supervisor",
      role: "background-supervisor",
      status: fixedText(backgroundStatus?.supervisor?.status || "stopped"),
      resourceRef: "background-supervisor"
    }));
  }
  for (const processItem of Array.isArray(backgroundStatus?.processes) ? backgroundStatus.processes : []) {
    throwIfObservabilityAborted(signal);
    if (processItem?.desired === false) continue;
    const role = fixedText(processItem?.role || "background-process");
    const status = fixedText(processItem?.status || "unknown");
    const resourceRef = stableAlertReference(role);
    const notRunning = config.rules.processNotRunning;
    if (notRunning && (notRunning.statuses || []).includes(status)) {
      alerts.push(buildAlert({ alertId: `monitor.process.${role}.not_running`, ruleId: "processNotRunning", rule: notRunning, source: "background-process", role, status, resourceRef }));
    }
    const stale = config.rules.processStale;
    if (stale && (stale.statuses || []).includes(status)) {
      alerts.push(buildAlert({ alertId: `monitor.process.${role}.stale`, ruleId: "processStale", rule: stale, source: "background-process", role, status, resourceRef }));
    }
    const restarted = config.rules.processRestarted;
    if (restarted && Number(processItem?.restartCount || 0) >= restarted.restartCountThreshold) {
      alerts.push(buildAlert({ alertId: `monitor.process.${role}.restarted`, ruleId: "processRestarted", rule: restarted, source: "background-process", role, status: "restarted", resourceRef }));
    }
  }
  alerts.push(...evaluateWorkQueueAlerts({ workQueueObservation, config, signal }));
  if (alerts.length > OBSERVABILITY_BUDGETS.maxActiveAlerts) {
    throw new ObservabilityBudgetError("observability_active_alert_budget_exceeded");
  }
  return alerts;
}

async function loadState(userDataPath) {
  return asObject(await readJsonIfExists(monitorAlertStatePath(userDataPath), {}));
}

function workQueueObservationSummary(workQueueObservation) {
  const counts = {};
  for (const item of Array.isArray(workQueueObservation?.items) ? workQueueObservation.items : []) {
    const status = fixedText(item?.observationStatus || item?.state || "unknown");
    counts[status] = Number(counts[status] || 0) + 1;
  }
  return Object.freeze({
    observed: Boolean(workQueueObservation),
    itemCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    statusCounts: Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))))
  });
}

function inspectionSummary(value = {}) {
  const source = asObject(value);
  const recovery = asObject(source.supervisorRecovery);
  return Object.freeze({
    status: fixedText(source.status || "unknown"),
    runtime: fixedText(source.runtime || "node"),
    updatedAt: String(source.updatedAt || ""),
    supervisorRecovery: Object.freeze({
      ok: recovery.ok === true,
      attempted: recovery.attempted === true,
      reason: fixedText(recovery.reason || "")
    })
  });
}

function buildMonitorSystemStatus({ state, activeAlerts, config, updatedAt }) {
  const registrations = [
    unifiedRegistrationForMonitor({
      monitorId: "monitor-alerts",
      label: "Monitor alerts",
      source: "system-inspection",
      status: state.status,
      ok: state.ok,
      updatedAt,
      statePath: "",
      configPath: "",
      summary: state.summary,
      features: ["runtime-observation", "alert-lifecycle"],
      monitors: ["background-process", "work-queue"],
      alerts: Object.keys(config.rules)
    }),
    ...activeAlerts.map((alert) => unifiedRegistrationForAlert(alert))
  ].filter(Boolean);
  return composeUnifiedSystemStatus(registrations, { source: "monitor-alerts", updatedAt });
}

function publicState(state = {}) {
  return sanitizeSensitiveReport({
    schemaVersion: state.schemaVersion || "v0.0.1:observability:monitor-alert-state-1",
    ok: state.ok === true,
    status: fixedText(state.status || "unconfigured"),
    reason: fixedText(state.reason || "configuration_missing"),
    updatedAt: String(state.updatedAt || ""),
    config: state.config?.configurationState ? state.config : unconfiguredObservabilityConfig(),
    inspectionDaemon: inspectionSummary(state.inspectionDaemon),
    workQueueObservation: asObject(state.workQueueObservation),
    summary: asObject(state.summary),
    activeAlerts: (Array.isArray(state.activeAlerts) ? state.activeAlerts : []).map(attachAlertRegistration),
    history: (Array.isArray(state.history) ? state.history : []).map(attachAlertRegistration),
    systemStatus: asObject(state.systemStatus),
    budgetObservation: asObject(state.budgetObservation),
    metrics: asObject(state.metrics),
    budgets: Object.freeze({
      maxActiveAlerts: OBSERVABILITY_BUDGETS.maxActiveAlerts,
      maxAlertHistory: OBSERVABILITY_BUDGETS.maxAlertHistory,
      maxCycleDurationMs: OBSERVABILITY_BUDGETS.maxCycleDurationMs,
      maxCycleCpuMs: OBSERVABILITY_BUDGETS.maxCycleCpuMs,
      maxCycleRssDeltaBytes: OBSERVABILITY_BUDGETS.maxCycleRssDeltaBytes
    })
  });
}

async function runMonitorAlertCycleUnlocked(userDataPath, options = {}) {
  const signal = options.signal;
  throwIfObservabilityAborted(signal);
  const budget = startObservabilityBudgetObservation(options.budgetClock);
  const config = await loadMonitorAlertConfig(userDataPath);
  const runtime = runtimeSettings(config);
  const backgroundStatus = await getBackgroundProcessStatus(userDataPath);
  throwIfObservabilityAborted(signal);
  const workQueueObservation = typeof options.workQueueObservation?.inspect === "function"
    ? await options.workQueueObservation.inspect({ signal })
    : null;
  const previous = await loadState(userDataPath);
  const signals = evaluateAlerts({ backgroundStatus, workQueueObservation, config: runtime, signal });
  const merged = mergeAlertHistory({ previous, signals, limit: runtime.historyLimit, signal });
  const active = merged.active;
  const history = merged.history;
  const activeProblemCount = active.length;
  const summary = Object.freeze({
    activeCount: activeProblemCount,
    acknowledgedCount: active.filter((alert) => alert.lifecycleStatus === "acknowledged").length,
    notificationFailedCount: active.filter((alert) => alert.lifecycleStatus === "notification_failed").length,
    criticalCount: active.filter((alert) => alert.severity === "critical").length,
    warningCount: active.filter((alert) => alert.severity === "warning").length,
    historyCount: history.length
  });
  const updatedAt = nowIso();
  const state = {
    schemaVersion: "v0.0.1:observability:monitor-alert-state-1",
    ok: activeProblemCount === 0,
    status: runtime.configurationState === "unconfigured"
      ? "unconfigured"
      : !runtime.enabled
        ? "disabled"
        : activeProblemCount > 0
          ? "alerting"
          : "healthy",
    reason: runtime.configurationState === "unconfigured"
      ? "configuration_missing"
      : !runtime.enabled
        ? "monitor_disabled"
        : activeProblemCount > 0
          ? "active_alerts_present"
          : "monitor_healthy",
    updatedAt,
    config,
    inspectionDaemon: inspectionSummary(options.inspectionDaemon || previous.inspectionDaemon),
    workQueueObservation: workQueueObservationSummary(workQueueObservation),
    summary,
    activeAlerts: active,
    history
  };
  state.systemStatus = buildMonitorSystemStatus({ state, activeAlerts: active, config: runtime, updatedAt });
  state.budgetObservation = budget.finish({ signal });
  const metrics = createBoundedMetricRegistry({
    families: ["monitor_alert_cycle", "monitor_active_alerts"],
    statuses: ["unconfigured", "disabled", "alerting", "healthy", ...ALERT_LIFECYCLE_STATES],
    reasons: [
      "configuration_missing",
      "monitor_disabled",
      "active_alerts_present",
      "monitor_healthy",
      "condition_matched"
    ],
    stages: ["evaluate"],
    maxSeries: 16
  });
  metrics.record({
    family: "monitor_alert_cycle",
    status: state.status,
    reason: state.reason,
    stage: "evaluate",
    durationMs: state.budgetObservation.elapsedMs
  });
  for (const lifecycleStatus of ALERT_LIFECYCLE_STATES) {
    const count = active.filter((alert) => alert.lifecycleStatus === lifecycleStatus).length;
    if (count > 0) metrics.record({
      family: "monitor_active_alerts",
      status: lifecycleStatus,
      reason: "condition_matched",
      stage: "evaluate",
      count
    });
  }
  state.metrics = metrics.snapshot();
  const safeState = publicState(state);
  throwIfObservabilityAborted(signal);
  await atomicWriteJson(monitorAlertStatePath(userDataPath), safeState, { signal });
  return safeState;
}

export function runMonitorAlertCycle(userDataPath, options = {}) {
  return queueStateMutation(
    stateFileKey(monitorAlertStatePath(userDataPath)),
    () => runMonitorAlertCycleUnlocked(userDataPath, options)
  );
}

async function transitionMonitorAlertLifecycleUnlocked(userDataPath, alertId, event, options = {}) {
  const normalizedId = String(alertId || "").trim();
  if (!normalizedId) {
    const error = new Error("Alert id is required.");
    error.code = "alert_id_required";
    throw error;
  }
  const state = await loadState(userDataPath);
  const current = alertMap(state).get(normalizedId);
  if (!current) {
    const error = new Error("Alert was not found.");
    error.code = "alert_not_found";
    throw error;
  }
  const transitioned = transitionAlertRecord(current, event, {
    actor: fixedText(options.actor || "operator"),
    reason: options.reason || event,
    signal: options.signal
  });
  const activeById = new Map((Array.isArray(state.activeAlerts) ? state.activeAlerts : []).map((item) => [item.alertId, item]));
  const historyById = new Map((Array.isArray(state.history) ? state.history : []).map((item) => [item.alertId, item]));
  if (transitioned.active) activeById.set(normalizedId, transitioned);
  else activeById.delete(normalizedId);
  historyById.set(normalizedId, transitioned);
  const activeAlerts = [...activeById.values()];
  const history = [...historyById.values()]
    .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")))
    .slice(0, OBSERVABILITY_BUDGETS.maxAlertHistory);
  const next = {
    ...state,
    ok: activeAlerts.length === 0,
    status: activeAlerts.length > 0 ? "alerting" : "healthy",
    reason: activeAlerts.length > 0 ? "active_alerts_present" : "monitor_healthy",
    updatedAt: nowIso(),
    activeAlerts,
    history,
    summary: {
      ...asObject(state.summary),
      activeCount: activeAlerts.length,
      acknowledgedCount: activeAlerts.filter((alert) => alert.lifecycleStatus === "acknowledged").length,
      notificationFailedCount: activeAlerts.filter((alert) => alert.lifecycleStatus === "notification_failed").length,
      historyCount: history.length
    }
  };
  next.systemStatus = buildMonitorSystemStatus({
    state: next,
    activeAlerts,
    config: runtimeSettings(next.config || unconfiguredObservabilityConfig()),
    updatedAt: next.updatedAt
  });
  const safeState = publicState(next);
  await atomicWriteJson(monitorAlertStatePath(userDataPath), safeState, { signal: options.signal });
  return safeState;
}

export function transitionMonitorAlertLifecycle(userDataPath, alertId, event, options = {}) {
  return queueStateMutation(
    stateFileKey(monitorAlertStatePath(userDataPath)),
    () => transitionMonitorAlertLifecycleUnlocked(userDataPath, alertId, event, options)
  );
}

export async function acknowledgeMonitorAlert(userDataPath, alertId, options = {}) {
  return transitionMonitorAlertLifecycle(userDataPath, alertId, "acknowledge", {
    ...options,
    reason: "operator_acknowledged"
  });
}

export async function getMonitorAlertState(userDataPath, options = {}) {
  if (options.refresh !== false) return runMonitorAlertCycle(userDataPath, options);
  const state = await loadState(userDataPath);
  if (!state.schemaVersion) {
    return publicState({
      config: await loadMonitorAlertConfig(userDataPath),
      status: "unconfigured",
      reason: "configuration_missing",
      ok: true,
      activeAlerts: [],
      history: [],
      summary: { activeCount: 0, acknowledgedCount: 0, notificationFailedCount: 0, criticalCount: 0, warningCount: 0, historyCount: 0 }
    });
  }
  return publicState(state);
}
