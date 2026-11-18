import crypto from "node:crypto";
import { redactReportText } from "./sensitive-report-scan.ts";

export const ALERT_LIFECYCLE_EVENTS: readonly any[] = Object.freeze([
  "condition_matched",
  "acknowledge",
  "resolve",
  "suppress",
  "notification_failed",
  "archive"
]);

export const ALERT_LIFECYCLE_STATES: readonly any[] = Object.freeze([
  "rule_loaded",
  "firing",
  "acknowledged",
  "resolved",
  "suppressed",
  "notification_failed",
  "archived"
]);

export const ALERT_SEVERITIES: readonly any[] = Object.freeze(["info", "warning", "critical"]);

const SAFE_REASON_CODES: any = new Set<any>([
  "condition_matched",
  "operator_acknowledged",
  "condition_recovered",
  "operator_suppressed",
  "notification_delivery_failed",
  "retention_archived"
]);

function text(value: any = "") : any {
  return String(value || "").trim();
}

export function stableAlertReference(value: any = "") : any {
  const normalized: any = text(value);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function normalizeAlertReason(value: any = "") : any {
  const reason: any = text(value);
  return SAFE_REASON_CODES.has(reason) ? reason : "condition_matched";
}

export function sanitizeAlertText(value: any = "", maxLength: any = 260) : any {
  return redactReportText(text(value)).slice(0, maxLength);
}

export function normalizeAlertSignal(input: Record<string, any> = {}) : any {
  const source: any = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const alertId: any = text(source.alertId);
  const ruleId: any = text(source.ruleId);
  if (!alertId || !/^[A-Za-z0-9._:-]{1,160}$/u.test(alertId)) {
    const error: Error & Record<string, any> = new Error("Alert signal has an invalid alertId.");
    error.code = "alert_id_invalid";
    throw error;
  }
  if (!ruleId || !/^[A-Za-z0-9._:-]{1,96}$/u.test(ruleId)) {
    const error: Error & Record<string, any> = new Error("Alert signal has an invalid ruleId.");
    error.code = "alert_rule_invalid";
    throw error;
  }
  const severity: any = ALERT_SEVERITIES.includes(source.severity) ? source.severity : "warning";
  return Object.freeze({
    alertId,
    ruleId,
    category: text(source.category || "runtime").replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 64),
    severity,
    title: sanitizeAlertText(source.title, 160),
    message: sanitizeAlertText(source.message, 260),
    source: text(source.source).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 64),
    role: text(source.role).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 64),
    status: text(source.status).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 64),
    resourceRef: stableAlertReference(source.resourceRef || source.queueId || source.alertId),
    ackRequired: source.ackRequired === true,
    tone: text(source.tone).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 32)
  });
}
