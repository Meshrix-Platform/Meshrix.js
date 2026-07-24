import crypto from "node:crypto";
import { redactReportText } from "./sensitive-report-scan.mjs";

export const ALERT_LIFECYCLE_EVENTS = Object.freeze([
  "condition_matched",
  "acknowledge",
  "resolve",
  "suppress",
  "notification_failed",
  "archive"
]);

export const ALERT_LIFECYCLE_STATES = Object.freeze([
  "rule_loaded",
  "firing",
  "acknowledged",
  "resolved",
  "suppressed",
  "notification_failed",
  "archived"
]);

export const ALERT_SEVERITIES = Object.freeze(["info", "warning", "critical"]);

const SAFE_REASON_CODES = new Set([
  "condition_matched",
  "operator_acknowledged",
  "condition_recovered",
  "operator_suppressed",
  "notification_delivery_failed",
  "retention_archived"
]);

function text(value = "") {
  return String(value || "").trim();
}

export function stableAlertReference(value = "") {
  const normalized = text(value);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function normalizeAlertReason(value = "") {
  const reason = text(value);
  return SAFE_REASON_CODES.has(reason) ? reason : "condition_matched";
}

export function sanitizeAlertText(value = "", maxLength = 260) {
  return redactReportText(text(value)).slice(0, maxLength);
}

export function normalizeAlertSignal(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const alertId = text(source.alertId);
  const ruleId = text(source.ruleId);
  if (!alertId || !/^[A-Za-z0-9._:-]{1,160}$/u.test(alertId)) {
    const error = new Error("Alert signal has an invalid alertId.");
    error.code = "alert_id_invalid";
    throw error;
  }
  if (!ruleId || !/^[A-Za-z0-9._:-]{1,96}$/u.test(ruleId)) {
    const error = new Error("Alert signal has an invalid ruleId.");
    error.code = "alert_rule_invalid";
    throw error;
  }
  const severity = ALERT_SEVERITIES.includes(source.severity) ? source.severity : "warning";
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
