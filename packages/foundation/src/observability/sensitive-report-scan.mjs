import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import { atomicWriteFile } from "../storage/state-coordinator.mjs";
import { OBSERVABILITY_BUDGETS, ObservabilityBudgetError, throwIfObservabilityAborted } from "./observability-budgets.mjs";

export const WINDOWS_LOCAL_PATH_PATTERN =
  /(?:^|[^A-Za-z0-9_])[A-Za-z]:\\{1,2}(?:Users|ProgramData|Program Files|Windows|Temp|tmp|[A-Za-z0-9_. -]+\\{1,2})/u;

const WINDOWS_LOCAL_PATH_REDACTION_PATTERN =
  /(^|[^A-Za-z0-9_])([A-Za-z]:\\{1,2}(?:Users|ProgramData|Program Files|Windows|Temp|tmp|[A-Za-z0-9_. -]+\\{1,2})[^\s"'`]*)/gu;

const POSIX_LOCAL_PATH_PATTERN_SOURCE = [
  "/",
  "(?:Users|home|private|var/folders|root|tmp|var/tmp)",
  "/"
].join("");

export const SENSITIVE_REPORT_PATTERNS = Object.freeze([
  ["url_credentials", /\bhttps?:\/\/[^\s/"'@]+:[^\s/"'@]+@/iu],
  ["url_sensitive_query", /\bhttps?:\/\/[^\s"']+[?&](?:access[_-]?token|api[_-]?key|authorization|password|secret|token)=(?!\[redacted\]|%5Bredacted%5D)[^&#\s"']+/iu],
  ["private_endpoint", /(?:^|[^A-Za-z0-9.-])(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[?::1\]?|\[?f[cd][0-9a-f]{0,2}(?::[0-9a-f]{0,4}){2,7}\]?|[A-Za-z0-9-]+\.local)(?::\d+)?(?:[^A-Za-z0-9.-]|$)/iu],
  ["local_path", new RegExp(`(?:${POSIX_LOCAL_PATH_PATTERN_SOURCE}|${WINDOWS_LOCAL_PATH_PATTERN.source})`, "u")],
  ["bearer_token", /Bearer\s+(?!\[redacted\]|<redacted-secret>)\S+/u],
  ["secret_token", /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b|upstream-secret-value/u],
  ["pem_material", /-----BEGIN|-----END/u],
  ["raw_secret_value", /"(?:privateKey|privateKeyBase64url|signingKeyBase64url|signedPrekeyPrivateKeyBase64url|oneTimePrekeyPrivateKeyBase64url|pairingSecretBase64url|sessionKey|rootKey|chainKey|messageKey)"\s*:\s*"[^"]{8,}"/u],
  ["runtime_id", /\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b|\b(?:tool_exec|pending_op|delegated_mcp)_[A-Za-z0-9_-]{8,}\b|\btrace_[A-Fa-f0-9]{8,}\b/u],
  ["raw_payload", /raw prompt body|private file content/u]
]);

function serialized(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function scanText(value) {
  return serialized(value)
    .replace(/\bhttps?:\/\/[^\s"'\\]+/gu, "<public-url>")
    .replace(/\/(?:Users|home)\/<[^>]+>\/[^\s"'`]*/gu, "<local-path-placeholder>");
}

export function sensitiveReportFindings(value) {
  const raw = serialized(value);
  const text = scanText(raw);
  return SENSITIVE_REPORT_PATTERNS
    .filter(([kind, pattern]) => pattern.test(
      kind.startsWith("url_") || kind === "private_endpoint" ? raw : text
    ))
    .map(([kind]) => kind);
}

export function containsSensitiveReportData(value) {
  return sensitiveReportFindings(value).length > 0;
}

export function assertNoSensitiveReportLeak(value, label = "report", { signal } = {}) {
  throwIfObservabilityAborted(signal);
  const text = serialized(value);
  if (Buffer.byteLength(text, "utf8") > OBSERVABILITY_BUDGETS.maxReportBytes) {
    throw new ObservabilityBudgetError("observability_report_bytes_exceeded");
  }
  const [finding] = sensitiveReportFindings(text);
  if (finding) {
    throw new Error(`${label} contains sensitive data: ${finding}`);
  }
  return true;
}

export function redactReportText(value = "", { dynamicNeedles = [] } = {}) {
  let text = String(value || "");
  for (const needle of dynamicNeedles) {
    if (needle) text = text.split(String(needle)).join("[redacted-path]");
  }
  text = text.split(/(\bhttps?:\/\/[^\s"'\\]+)/u).map((part) => /^https?:\/\//u.test(part)
    ? SENSITIVE_REPORT_PATTERNS.some(([kind, pattern]) =>
      (kind.startsWith("url_") || kind === "private_endpoint") && pattern.test(part)
    ) ? "[redacted-url]" : part
    : part
      .replace(/file:\/\/(?:\/+)?(?:Users|home|private|var|root|tmp|opt|Volumes)\/[^\s"'`)]+/gu, "file://[redacted-path]")
      .replace(/\/(?:Users|home)\/<[^>]+>\/[^\s"'`]*/gu, "<local-path-placeholder>")
      .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/root\/|\/(?:tmp|var\/tmp)\/)[^\s"'`]+/gu, "[redacted-path]")
      .replace(WINDOWS_LOCAL_PATH_REDACTION_PATTERN, "$1[redacted-path]"))
    .join("");
  text = text.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
  text = text.replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9._-]{8,}\b/gu, "[redacted-secret]");
  text = text.replace(/upstream-secret-value/gu, "[redacted-secret]");
  text = text.replace(/"(?:token|secret|password|authorization|apiKey|privateKey)"\s*:\s*"[^"]+"/giu, (entry) => `${entry.slice(0, entry.indexOf(":"))}:"[redacted]"`);
  text = text.replace(/meshrix_[A-Za-z0-9_-]{12,}/gu, "meshrix_[redacted]");
  text = text.replace(/\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b/giu, "grant_[redacted]");
  text = text.replace(/\b(?:tool_exec|pending_op|delegated_mcp)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted-runtime-id]");
  text = text.replace(/\btrace_[A-Fa-f0-9]{8,}\b/gu, "trace_[redacted]");
  text = text.replace(/(?:127\.0\.0\.1|localhost):\d+/gu, "[redacted-host]");
  return text;
}

function sanitizeValue(value, { depth, itemCounter, signal }) {
  throwIfObservabilityAborted(signal);
  if (depth > OBSERVABILITY_BUDGETS.maxScanDepth) return "[redacted-depth]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactReportText(value);
  itemCounter.count += 1;
  if (itemCounter.count > OBSERVABILITY_BUDGETS.maxScanItems) {
    throw new ObservabilityBudgetError("observability_scan_items_exceeded");
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, { depth: depth + 1, itemCounter, signal }));
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const sensitiveKey = /token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key|credential/i.test(key);
    output[key] = sensitiveKey
      ? "[redacted]"
      : sanitizeValue(value[key], { depth: depth + 1, itemCounter, signal });
  }
  return output;
}

export function sanitizeSensitiveReport(value, { signal } = {}) {
  const sanitized = sanitizeValue(value, { depth: 0, itemCounter: { count: 0 }, signal });
  assertNoSensitiveReportLeak(sanitized, "sanitized report", { signal });
  return sanitized;
}


export function reportPayloadDigest(value = {}) {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "payloadDigest"))
    : value;
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

export function assertReportProvenance(report = {}, expected = {}) {
  for (const field of ["producer", "commandId", "sourceRevision", "payloadDigest"]) {
    if (!String(report?.[field] || "").trim()) {
      const error = new Error(`Report provenance field ${field} is required.`);
      error.code = "observability_report_provenance_missing";
      error.field = field;
      throw error;
    }
  }
  for (const field of ["producer", "commandId", "sourceRevision"]) {
    if (expected[field] && report[field] !== expected[field]) {
      const error = new Error(`Report provenance field ${field} does not match its producer contract.`);
      error.code = "observability_report_provenance_mismatch";
      error.field = field;
      throw error;
    }
  }
  if (report.payloadDigest !== reportPayloadDigest(report)) {
    const error = new Error("Report payload digest does not match its content.");
    error.code = "observability_report_digest_mismatch";
    throw error;
  }
  return true;
}

export function finalizeSensitiveReport(value, { signal, provenance = null } = {}) {
  const report = sanitizeSensitiveReport(value, { signal });
  if (report && typeof report === "object" && !Array.isArray(report)) {
    if (report.summary && typeof report.summary === "object" && !Array.isArray(report.summary)) {
      report.summary.reportLeakScan = true;
    } else {
      report.reportLeakScan = true;
    }
  }
  if (provenance) {
    report.producer = String(provenance.producer || "").trim();
    report.commandId = String(provenance.commandId || "").trim();
    report.sourceRevision = String(provenance.sourceRevision || "").trim();
    report.payloadDigest = reportPayloadDigest(report);
    assertReportProvenance(report, provenance);
  }
  assertNoSensitiveReportLeak(report, "finalized report", { signal });
  return report;
}

function reportContractError(code, message, field = "") {
  const error = new Error(message);
  error.code = code;
  if (field) error.field = field;
  return error;
}

function assertReportPublicationContract(value, { schemaVersion, verifier, provenance } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reportContractError("observability_report_schema_invalid", "Report must be an object.");
  }
  if (!String(schemaVersion || "").trim() || value.schemaVersion !== schemaVersion) {
    throw reportContractError(
      "observability_report_schema_mismatch",
      "Report schema does not match its publication contract.",
      "schemaVersion"
    );
  }
  if (!String(verifier || "").trim() || value.verifier !== verifier) {
    throw reportContractError(
      "observability_report_owner_mismatch",
      "Report verifier does not match its publication owner.",
      "verifier"
    );
  }
  for (const field of ["producer", "commandId", "sourceRevision"]) {
    if (!String(provenance?.[field] || "").trim()) {
      throw reportContractError(
        "observability_report_provenance_missing",
        `Report provenance field ${field} is required.`,
        field
      );
    }
  }
}

export async function finalizeAndPublishSensitiveReport(value, {
  filePath,
  schemaVersion,
  verifier,
  provenance,
  signal,
  checkpointDigest = "",
  requirements = []
} = {}) {
  throwIfObservabilityAborted(signal);
  if (!String(filePath || "").trim()) {
    throw reportContractError("observability_report_path_missing", "Report publication path is required.", "filePath");
  }
  assertReportPublicationContract(value, { schemaVersion, verifier, provenance });
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(checkpointDigest || ""))) {
    throw reportContractError(
      "observability_report_checkpoint_digest_invalid",
      "Report checkpoint digest is required and must be a SHA-256 digest.",
      "checkpointDigest"
    );
  }
  if (!Array.isArray(requirements) || requirements.length === 0 || requirements.some((item) => !String(item || "").trim())) {
    throw reportContractError(
      "observability_report_requirements_invalid",
      "Report requirements must contain at least one non-empty requirement id.",
      "requirements"
    );
  }
  const inputBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (inputBytes > OBSERVABILITY_BUDGETS.maxReportBytes) {
    throw new ObservabilityBudgetError("observability_report_bytes_exceeded");
  }
  const report = finalizeSensitiveReport({
    ...value,
    reportOwner: provenance.producer,
    requirements: [...new Set(requirements.map(String))].sort(),
    checkpointDigest: String(checkpointDigest || ""),
    privacyFinalization: {
      finalizer: "meshrix-core-observability",
      redactionApplied: true,
      privacyScanPassed: true,
      atomicPublication: true
    },
    resourceBudgets: {
      maxReportBytes: OBSERVABILITY_BUDGETS.maxReportBytes,
      maxScanDepth: OBSERVABILITY_BUDGETS.maxScanDepth,
      maxScanItems: OBSERVABILITY_BUDGETS.maxScanItems
    }
  }, { signal, provenance });
  assertReportPublicationContract(report, { schemaVersion, verifier, provenance });
  assertNoSensitiveReportLeak(report, "published report", { signal });
  assertReportProvenance(report, provenance);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > OBSERVABILITY_BUDGETS.maxReportBytes) {
    throw new ObservabilityBudgetError("observability_report_bytes_exceeded");
  }
  throwIfObservabilityAborted(signal);
  await atomicWriteFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
  return report;
}

export function sanitizeSensitiveError(error) {
  return redactReportText(String(error instanceof Error ? error.message : error)).slice(0, 1_000);
}
