import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getBackgroundProcessStatus,
  setBackgroundProcessDeps
} from "#meshrix/foundation/observability/background-process-status";
import {
  activateAlertRecord,
  createAlertRecord,
  transitionAlertRecord
} from "#meshrix/foundation/observability/alert-service";
import {
  ALERT_LIFECYCLE_STATES,
  normalizeAlertSignal,
  stableAlertReference
} from "#meshrix/foundation/observability/alert-contract";
import { createBoundedMetricRegistry } from "#meshrix/foundation/observability/metric-registry";
import {
  normalizeObservabilityConfig,
  observabilityConfigForPersistence,
  unconfiguredObservabilityConfig
} from "#meshrix/foundation/observability/observability-config";
import {
  OBSERVABILITY_BUDGETS,
  ObservabilityBudgetError,
  startObservabilityBudgetObservation,
  throwIfObservabilityAborted
} from "#meshrix/foundation/observability/observability-budgets";
import { sanitizeSensitiveReport } from "#meshrix/foundation/observability/sensitive-report-scan";
import {
  composeUnifiedSystemStatus,
  unifiedRegistrationForAlert,
  unifiedRegistrationForMonitor
} from "#meshrix/foundation/unified-registration-core/unified-registration";
import {
  atomicWriteJson as runtimeAtomicWriteJson,
  queueStateMutation,
  stateFileKey
} from "../../state/state-coordinator.ts";
import { loadSettings } from "../settings.ts";

setBackgroundProcessDeps({
  atomicWriteJson: runtimeAtomicWriteJson,
  queueStateMutation,
  stateFileKey,
  loadSettings
});

const ALERT_DIR: any = "background";
const ALERT_CONFIG_FILE: any = "monitor-alerts.json";
const ALERT_SHELL_CONFIG_FILE: any = "monitor-alerts.sh.conf";
const ALERT_STATE_FILE: any = "monitor-alerts-state.json";

const RUNTIME_RULES: Readonly<Record<string, any>> = Object.freeze({
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

function nowIso() : any {
  return new Date().toISOString();
}

function asObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function fixedText(value: any = "", maxLength: any = 64) : any {
  return String(value || "").trim().replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, maxLength);
}

export function monitorAlertConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, ALERT_DIR, ALERT_CONFIG_FILE);
}

export function monitorAlertShellConfigPath(userDataPath?: any) : any {
  return path.join(userDataPath, ALERT_DIR, ALERT_SHELL_CONFIG_FILE);
}

export function monitorAlertStatePath(userDataPath?: any) : any {
  return path.join(userDataPath, ALERT_DIR, ALERT_STATE_FILE);
}

async function readJsonIfExists(filePath?: any, fallback: any = null) : Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath?: any, value?: any, { signal }: Record<string, any> = {}) : Promise<any> {
  throwIfObservabilityAborted(signal);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath: any = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    throwIfObservabilityAborted(signal);
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() : any => {});
  }
}

function runtimeSettings(config?: any) : any {
  const configured: any = config?.configurationState === "configured";
  const enabled: any = configured && config.enabled === true;
  const rules: Record<string, any> = {};
  for (const [ruleId, userRule] of (Object.entries(asObject(config?.rules)) as [string, any][])) {
    const definition: any = RUNTIME_RULES[ruleId];
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

export async function loadMonitorAlertConfig(userDataPath?: any) : Promise<any> {
  const stored: any = await readJsonIfExists(monitorAlertConfigPath(userDataPath), null);
  return stored === null ? unconfiguredObservabilityConfig() : normalizeObservabilityConfig(stored);
}

async function writeMonitorAlertShellConfig(userDataPath?: any, config?: any) : Promise<any> {
  const filePath: any = monitorAlertShellConfigPath(userDataPath);
  if (config.configurationState !== "configured") {
    await fs.rm(filePath, { force: true });
    return;
  }
  const runtime: any = runtimeSettings(config);
  const processRule: any = runtime.rules.processNotRunning;
  const payload: any = [
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

export async function saveMonitorAlertConfig(userDataPath?: any, input?: any) : Promise<any> {
  const normalized: any = normalizeObservabilityConfig(input);
  const persisted: any = observabilityConfigForPersistence(normalized);
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

function buildAlert({ alertId, ruleId, rule, source, role, status, resourceRef, ackRequired = false, tone = "" }: Record<string, any>) : any {
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

function attachAlertRegistration(alert?: any) : any {
  return Object.freeze({ ...alert, unifiedRegistration: unifiedRegistrationForAlert(alert) });
}

function alertMap(state: Record<string, any> = {}) : any {
  return new Map<any, any>([
    ...(Array.isArray(state.activeAlerts) ? state.activeAlerts : []),
    ...(Array.isArray(state.history) ? state.history : [])
  ].map((alert?: any) : any => [String(alert.alertId || ""), alert]).filter(([id]: any[]) : any => id));
}

function mergeAlertHistory({ previous = {}, signals = [], limit, signal }: Record<string, any>) : any {
  const priorById: any = alertMap(previous);
  const nextActive: any[] = [];
  const currentIds: any = new Set<any>();
  for (const candidate of signals) {
    throwIfObservabilityAborted(signal);
    if (currentIds.size >= OBSERVABILITY_BUDGETS.maxActiveAlerts) {
      throw new ObservabilityBudgetError("observability_active_alert_budget_exceeded");
    }
    currentIds.add(candidate.alertId);
    nextActive.push(activateAlertRecord(candidate, priorById.get(candidate.alertId), { signal }));
  }
  const nextHistory: any[] = [];
  for (const prior of priorById.values()) {
    throwIfObservabilityAborted(signal);
    if (currentIds.has(prior.alertId)) continue;
    let resolved: any = prior;
    if (["firing", "acknowledged", "notification_failed"].includes(prior.lifecycleStatus)) {
      resolved = transitionAlertRecord(prior, "resolve", { reason: "condition_recovered", signal });
    } else if (prior.lifecycleStatus === "suppressed") {
      resolved = transitionAlertRecord(prior, "archive", { reason: "retention_archived", signal });
    }
    nextHistory.push(resolved);
  }
  for (const active of nextActive) nextHistory.push(active);
  const history: any = [...new Map<any, any>(nextHistory.map((alert?: any) : any => [alert.alertId, alert])).values()]
    .sort((left?: any, right?: any) : any => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")))
    .slice(0, limit);
  return Object.freeze({
    active: Object.freeze(nextActive.filter((alert?: any) : any => alert.active !== false)),
    history: Object.freeze(history)
  });
}

function evaluateWorkQueueAlerts({ workQueueObservation, config, signal }: Record<string, any>) : any {
  const rule: any = config.rules.queueInterrupted;
  if (!config.enabled || !rule || !workQueueObservation) return [];
  const alerts: any[] = [];
  const seen: any = new Set<any>();
  for (const item of Array.isArray(workQueueObservation.items) ? workQueueObservation.items : []) {
    throwIfObservabilityAborted(signal);
    const workItemId: any = String(item?.workItemId || "");
    if (!workItemId || seen.has(workItemId) || item.observationStatus !== "interrupted") continue;
    seen.add(workItemId);
    const ref: any = stableAlertReference(workItemId);
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

function evaluateAlerts({ backgroundStatus, workQueueObservation, config, signal }: Record<string, any>) : any {
  if (!config.enabled) return [];
  const alerts: any[] = [];
  const supervisorRule: any = config.rules.supervisorStopped;
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
    const role: any = fixedText(processItem?.role || "background-process");
    const status: any = fixedText(processItem?.status || "unknown");
    const resourceRef: any = stableAlertReference(role);
    const notRunning: any = config.rules.processNotRunning;
    if (notRunning && (notRunning.statuses || []).includes(status)) {
      alerts.push(buildAlert({ alertId: `monitor.process.${role}.not_running`, ruleId: "processNotRunning", rule: notRunning, source: "background-process", role, status, resourceRef }));
    }
    const stale: any = config.rules.processStale;
    if (stale && (stale.statuses || []).includes(status)) {
      alerts.push(buildAlert({ alertId: `monitor.process.${role}.stale`, ruleId: "processStale", rule: stale, source: "background-process", role, status, resourceRef }));
    }
    const restarted: any = config.rules.processRestarted;
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

async function loadState(userDataPath?: any) : Promise<any> {
  return asObject(await readJsonIfExists(monitorAlertStatePath(userDataPath), {}));
}

function workQueueObservationSummary(workQueueObservation?: any) : any {
  const counts: Record<string, any> = {};
  for (const item of Array.isArray(workQueueObservation?.items) ? workQueueObservation.items : []) {
    const status: any = fixedText(item?.observationStatus || item?.state || "unknown");
    counts[status] = Number(counts[status] || 0) + 1;
  }
  return Object.freeze({
    observed: Boolean(workQueueObservation),
    itemCount: (Object.values(counts) as any[]).reduce((sum?: any, value?: any) : any => sum + value, 0),
    statusCounts: Object.freeze(Object.fromEntries((Object.entries(counts) as [string, any][]).sort(([left]: any[], [right]: any[]) : any => left.localeCompare(right))))
  });
}

function inspectionSummary(value: Record<string, any> = {}) : any {
  const source: any = asObject(value);
  const recovery: any = asObject(source.supervisorRecovery);
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

function buildMonitorSystemStatus({ state, activeAlerts, config, updatedAt }: Record<string, any>) : any {
  const registrations: any = [
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
    ...activeAlerts.map((alert?: any) : any => unifiedRegistrationForAlert(alert))
  ].filter(Boolean);
  return composeUnifiedSystemStatus(registrations, { source: "monitor-alerts", updatedAt });
}

function publicState(state: Record<string, any> = {}) : any {
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

async function runMonitorAlertCycleUnlocked(userDataPath?: any, options: Record<string, any> = {}) : Promise<any> {
  const signal: any = options.signal;
  throwIfObservabilityAborted(signal);
  const budget: any = startObservabilityBudgetObservation(options.budgetClock);
  const config: any = await loadMonitorAlertConfig(userDataPath);
  const runtime: any = runtimeSettings(config);
  const backgroundStatus: any = await getBackgroundProcessStatus(userDataPath);
  throwIfObservabilityAborted(signal);
  const workQueueObservation: any = typeof options.workQueueObservation?.inspect === "function"
    ? await options.workQueueObservation.inspect({ signal })
    : null;
  const previous: any = await loadState(userDataPath);
  const signals: any = evaluateAlerts({ backgroundStatus, workQueueObservation, config: runtime, signal });
  const merged: any = mergeAlertHistory({ previous, signals, limit: runtime.historyLimit, signal });
  const active: any = merged.active;
  const history: any = merged.history;
  const activeProblemCount: any = active.length;
  const summary: Readonly<Record<string, any>> = Object.freeze({
    activeCount: activeProblemCount,
    acknowledgedCount: active.filter((alert?: any) : any => alert.lifecycleStatus === "acknowledged").length,
    notificationFailedCount: active.filter((alert?: any) : any => alert.lifecycleStatus === "notification_failed").length,
    criticalCount: active.filter((alert?: any) : any => alert.severity === "critical").length,
    warningCount: active.filter((alert?: any) : any => alert.severity === "warning").length,
    historyCount: history.length
  });
  const updatedAt: any = nowIso();
  const state: Record<string, any> = {
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
  const metrics: any = createBoundedMetricRegistry({
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
    const count: any = active.filter((alert?: any) : any => alert.lifecycleStatus === lifecycleStatus).length;
    if (count > 0) metrics.record({
      family: "monitor_active_alerts",
      status: lifecycleStatus,
      reason: "condition_matched",
      stage: "evaluate",
      count
    });
  }
  state.metrics = metrics.snapshot();
  const safeState: any = publicState(state);
  throwIfObservabilityAborted(signal);
  await atomicWriteJson(monitorAlertStatePath(userDataPath), safeState, { signal });
  return safeState;
}

export function runMonitorAlertCycle(userDataPath?: any, options: Record<string, any> = {}) : any {
  return queueStateMutation(
    stateFileKey(monitorAlertStatePath(userDataPath)),
    () : any => runMonitorAlertCycleUnlocked(userDataPath, options)
  );
}

async function transitionMonitorAlertLifecycleUnlocked(userDataPath?: any, alertId?: any, event?: any, options: Record<string, any> = {}) : Promise<any> {
  const normalizedId: any = String(alertId || "").trim();
  if (!normalizedId) {
    const error: Error & Record<string, any> = new Error("Alert id is required.");
    error.code = "alert_id_required";
    throw error;
  }
  const state: any = await loadState(userDataPath);
  const current: any = alertMap(state).get(normalizedId);
  if (!current) {
    const error: Error & Record<string, any> = new Error("Alert was not found.");
    error.code = "alert_not_found";
    throw error;
  }
  const transitioned: any = transitionAlertRecord(current, event, {
    actor: fixedText(options.actor || "operator"),
    reason: options.reason || event,
    signal: options.signal
  });
  const activeById: any = new Map<any, any>((Array.isArray(state.activeAlerts) ? state.activeAlerts : []).map((item?: any) : any => [item.alertId, item]));
  const historyById: any = new Map<any, any>((Array.isArray(state.history) ? state.history : []).map((item?: any) : any => [item.alertId, item]));
  if (transitioned.active) activeById.set(normalizedId, transitioned);
  else activeById.delete(normalizedId);
  historyById.set(normalizedId, transitioned);
  const activeAlerts: any[] = [...activeById.values()];
  const history: any = [...historyById.values()]
    .sort((left?: any, right?: any) : any => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")))
    .slice(0, OBSERVABILITY_BUDGETS.maxAlertHistory);
  const next: Record<string, any> = {
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
      acknowledgedCount: activeAlerts.filter((alert?: any) : any => alert.lifecycleStatus === "acknowledged").length,
      notificationFailedCount: activeAlerts.filter((alert?: any) : any => alert.lifecycleStatus === "notification_failed").length,
      historyCount: history.length
    }
  };
  next.systemStatus = buildMonitorSystemStatus({
    state: next,
    activeAlerts,
    config: runtimeSettings(next.config || unconfiguredObservabilityConfig()),
    updatedAt: next.updatedAt
  });
  const safeState: any = publicState(next);
  await atomicWriteJson(monitorAlertStatePath(userDataPath), safeState, { signal: options.signal });
  return safeState;
}

export function transitionMonitorAlertLifecycle(userDataPath?: any, alertId?: any, event?: any, options: Record<string, any> = {}) : any {
  return queueStateMutation(
    stateFileKey(monitorAlertStatePath(userDataPath)),
    () : any => transitionMonitorAlertLifecycleUnlocked(userDataPath, alertId, event, options)
  );
}

export async function acknowledgeMonitorAlert(userDataPath?: any, alertId?: any, options: Record<string, any> = {}) : Promise<any> {
  return transitionMonitorAlertLifecycle(userDataPath, alertId, "acknowledge", {
    ...options,
    reason: "operator_acknowledged"
  });
}

export async function getMonitorAlertState(userDataPath?: any, options: Record<string, any> = {}) : Promise<any> {
  if (options.refresh !== false) return runMonitorAlertCycle(userDataPath, options);
  const state: any = await loadState(userDataPath);
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
