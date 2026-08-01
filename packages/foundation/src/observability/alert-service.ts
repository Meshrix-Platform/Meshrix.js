import {
  createStateMachine,
  loadBuiltinDefinition
} from "../workflow/state-machine/index.ts";
import {
  ALERT_LIFECYCLE_EVENTS,
  normalizeAlertReason,
  normalizeAlertSignal
} from "./alert-contract.ts";
import {
  OBSERVABILITY_BUDGETS,
  throwIfObservabilityAborted
} from "./observability-budgets.ts";

const alertMachine: any = createStateMachine(loadBuiltinDefinition("alert.lifecycle"));
const EVENT_REASONS: Readonly<Record<string, any>> = Object.freeze({
  condition_matched: "condition_matched",
  acknowledge: "operator_acknowledged",
  resolve: "condition_recovered",
  suppress: "operator_suppressed",
  notification_failed: "notification_delivery_failed",
  archive: "retention_archived"
});

export class AlertLifecycleError extends Error {
  code: any;
  name: any;
  reasonCode: any;
  transitionResult: any;
  constructor(result: Record<string, any> = {}) {
    super(result.message || "Alert lifecycle transition was rejected.");
    this.name = "AlertLifecycleError";
    this.code = result.errorCode || "ALERT_LIFECYCLE_INVALID_TRANSITION";
    this.reasonCode = this.code;
    this.transitionResult = result;
  }
}

function nowIso(now?: any) : any {
  return typeof now === "function" ? now() : new Date().toISOString();
}

export function createAlertRecord(signal?: any, { now }: Record<string, any> = {}) : any {
  const normalized: any = normalizeAlertSignal(signal);
  const timestamp: any = nowIso(now);
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

export function transitionAlertRecord(record?: any, event?: any, {
  actor = "system",
  reason = "",
  now,
  signal
}: Record<string, any> = {}) : any {
  throwIfObservabilityAborted(signal);
  if (!ALERT_LIFECYCLE_EVENTS.includes(event)) {
    const error: Error & Record<string, any> = new Error("Alert lifecycle event is not supported.");
    error.code = "ALERT_LIFECYCLE_UNKNOWN_EVENT";
    throw error;
  }
  const current: any = record?.lifecycleStatus || "rule_loaded";
  const timestamp: any = nowIso(now);
  const result: any = alertMachine.transition({
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
  const history: any = [
    ...(Array.isArray(record?.lifecycleHistory) ? record.lifecycleHistory : []),
    Object.freeze({
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      eventType: result.eventType,
      timestamp
    })
  ].slice(-OBSERVABILITY_BUDGETS.maxAlertTransitionHistory);
  const active: any = !["resolved", "suppressed", "archived"].includes(result.toStatus);
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

export function activateAlertRecord(signal?: any, previous: any = null, options: Record<string, any> = {}) : any {
  const base: any = previous
    ? Object.freeze({ ...previous, ...normalizeAlertSignal(signal), firstSeenAt: previous.firstSeenAt })
    : createAlertRecord(signal, options);
  if (["acknowledged", "notification_failed"].includes(base.lifecycleStatus)) {
    return Object.freeze({ ...base, active: true, lastSeenAt: nowIso(options.now) });
  }
  return transitionAlertRecord(base, "condition_matched", options);
}

export function alertLifecycleDefinition() : any {
  return alertMachine.definition;
}
