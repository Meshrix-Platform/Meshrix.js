import {
  assertNoSensitiveReportLeak,
  sanitizeSensitiveError,
  sensitiveReportFindings
} from "./sensitive-report-scan.mjs";

const EVIDENCE_REF_MAX_LENGTH = 240;

export function normalizeSafeEvidenceRef(value = "") {
  const text = String(value || "").trim().replaceAll("\\", "/");
  if (!text || text.length > EVIDENCE_REF_MAX_LENGTH) return "";
  if (/^[A-Za-z]:\//u.test(text) || text.startsWith("/") || text.startsWith("file:")) return "";
  if (/^https?:\/\//iu.test(text) || text.split("/").includes("..")) return "";
  if (/(?:\/Users\/|\/private\/|\/var\/folders\/|Bearer\s+\S+|gh[pousr]_|github_pat_|sk-)/u.test(text)) return "";
  return text;
}

export function safeEvidenceRefs(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeSafeEvidenceRef)
    .filter(Boolean))]
    .slice(0, 20);
}

function containsLocalPath(value = "") {
  return sensitiveReportFindings(value).includes("local_path");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeDiagnosticText(value = "") {
  const text = String(value || "").trim();
  if (!text || text.length > 260) {
    return "";
  }
  if (containsLocalPath(text) || /(?:Bearer\s+\S+|gh[pousr]_|github_pat_|sk-)/u.test(text)) {
    return "";
  }
  if (/^[A-Za-z]:\\/u.test(text)) {
    return "";
  }
  return text;
}

export function safeDiagnosticList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(safeDiagnosticText)
    .filter(Boolean))]
    .slice(0, 20);
}

export function extractEvidenceReportRemainingGates(report = {}) {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  return safeDiagnosticList([
    ...[].concat(record.remainingGates || []),
    ...[].concat(summary.remainingGates || []),
    ...[].concat(summary.diagnosticRemainingGaps || []),
    ...[].concat(record.diagnosticRemainingGaps || [])
  ]);
}

export function sanitizeError(error) {
  return sanitizeSensitiveError(error).replaceAll("[redacted-path]", "<local-path>");
}

export function assertNoLeak(value, label) {
  return assertNoSensitiveReportLeak(value, label);
}
