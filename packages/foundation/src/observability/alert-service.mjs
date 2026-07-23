import {
  createStateMachine,
  loadBuiltinDefinition
} from "../workflow/state-machine/index.mjs";
import {
  ALERT_LIFECYCLE_EVENTS,
  normalizeAlertReason,
  normalizeAlertSignal
} from "./alert-contract.mjs";
import {
  OBSERVABILITY_BUDGETS,
  throwIfObservabilityAborted
} from "./observability-budgets.mjs";

const alertMachine = createStateMachine(loadBuiltinDefinition("alert.lifecycle"));
const EVENT_REASONS = Object.freeze({
  condition_matched: "condition_matched",
  acknowledge: "operator_acknowledged",
  resolve: "condition_recovered",
  suppress: "operator_suppressed",
  notification_failed: "notification_delivery_failed",
  archive: "retention_archived"
});

export class AlertLifecycleError extends Error {
  constructor(result = {}) {
    super(result.message || "Alert lifecycle transition was rejected.");
    this.name = "AlertLifecycleError";
    this.code = result.errorCode || "ALERT_LIFECYCLE_INVALID_TRANSITION";
    this.reasonCode = this.code;
    this.transitionResult = result;
  }
}

function nowIso(now) {
  return typeof now === "function" ? now() : new Date().toISOString();
}

export function createAlertRecord(signal, { now } = {}) {
  const normalized = normalizeAlertSignal(signal);
  const timestamp = nowIso(now);
  return Object.freeze({
    ...normalized,
    lifecycleStatus: "rule_loaded",
    lifecycleRevision: 0,
    active: false,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    lifecycleHistory: Object.freeze([])
  });
}

export function transitionAlertRecord(record, event, {
  actor = "system",
  reason = "",
  now,
  signal
} = {}) {
  throwIfObservabilityAborted(signal);
  if (!ALERT_LIFECYCLE_EVENTS.includes(event)) {
    const error = new Error("Alert lifecycle event is not supported.");
    error.code = "ALERT_LIFECYCLE_UNKNOWN_EVENT";
    throw error;
  }
  const current = record?.lifecycleStatus || "rule_loaded";
  const timestamp = nowIso(now);
  const result = alertMachine.transition({
    entityId: record?.alertId || "alert",
    currentStatus: current
  }, event, {
    actor,
    reason: normalizeAlertReason(reason || EVENT_REASONS[event]),
    now: timestamp,
    metadata: {}
  });
  if (!result.ok) throw new AlertLifecycleError(result);
  if (result.idempotent) {
    return Object.freeze({
      ...record,
      lastSeenAt: event === "condition_matched" ? timestamp : record.lastSeenAt,
      lastLifecycleEvent: event,
      lastLifecycleEventIdempotent: true
    });
  }
  const history = [
    ...(Array.isArray(record?.lifecycleHistory) ? record.lifecycleHistory : []),
    Object.freeze({
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      eventType: result.eventType,
      timestamp
    })
  ].slice(-OBSERVABILITY_BUDGETS.maxAlertTransitionHistory);
  const active = !["resolved", "suppressed", "archived"].includes(result.toStatus);
  return Object.freeze({
    ...record,
    lifecycleStatus: result.toStatus,
    lifecycleRevision: Number(record?.lifecycleRevision || 0) + 1,
    active,
    lastSeenAt: event === "condition_matched" ? timestamp : record.lastSeenAt,
    acknowledgedAt: event === "acknowledge" ? timestamp : record?.acknowledgedAt || "",
    resolvedAt: event === "resolve" ? timestamp : record?.resolvedAt || "",
    suppressedAt: event === "suppress" ? timestamp : record?.suppressedAt || "",
    notificationFailedAt: event === "notification_failed" ? timestamp : record?.notificationFailedAt || "",
    archivedAt: event === "archive" ? timestamp : record?.archivedAt || "",
    lastLifecycleEvent: event,
    lastLifecycleEventIdempotent: false,
    lifecycleHistory: Object.freeze(history)
  });
}

export function activateAlertRecord(signal, previous = null, options = {}) {
  const base = previous
    ? Object.freeze({ ...previous, ...normalizeAlertSignal(signal), firstSeenAt: previous.firstSeenAt })
    : createAlertRecord(signal, options);
  if (["acknowledged", "notification_failed"].includes(base.lifecycleStatus)) {
    return Object.freeze({ ...base, active: true, lastSeenAt: nowIso(options.now) });
  }
  return transitionAlertRecord(base, "condition_matched", options);
}

export function alertLifecycleDefinition() {
  return alertMachine.definition;
}
