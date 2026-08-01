import { canonicalJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import { atomicWriteFile } from "../storage/state-coordinator.ts";
import { OBSERVABILITY_BUDGETS, ObservabilityBudgetError, throwIfObservabilityAborted } from "./observability-budgets.ts";

export const WINDOWS_LOCAL_PATH_PATTERN: any =
  /(?:^|[^A-Za-z0-9_])[A-Za-z]:\\{1,2}(?:Users|ProgramData|Program Files|Windows|Temp|tmp|[A-Za-z0-9_. -]+\\{1,2})/u;

const WINDOWS_LOCAL_PATH_REDACTION_PATTERN: any =
  /(^|[^A-Za-z0-9_])([A-Za-z]:\\{1,2}(?:Users|ProgramData|Program Files|Windows|Temp|tmp|[A-Za-z0-9_. -]+\\{1,2})[^\s"'`]*)/gu;

const POSIX_LOCAL_PATH_PATTERN_SOURCE: any = [
  "/",
  "(?:Users|home|private|var/folders|root|tmp|var/tmp)",
  "/"
].join("");

export const SENSITIVE_REPORT_PATTERNS: readonly any[] = Object.freeze([
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

function serialized(value?: any) : any {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function scanText(value?: any) : any {
  return serialized(value)
    .replace(/\bhttps?:\/\/[^\s"'\\]+/gu, "<public-url>")
    .replace(/\/(?:Users|home)\/<[^>]+>\/[^\s"'`]*/gu, "<local-path-placeholder>");
}

export function sensitiveReportFindings(value?: any) : any {
  const raw: any = serialized(value);
  const text: any = scanText(raw);
  return SENSITIVE_REPORT_PATTERNS
    .filter(([kind, pattern]: any[]) : any => pattern.test(
      kind.startsWith("url_") || kind === "private_endpoint" ? raw : text
    ))
    .map(([kind]: any[]) : any => kind);
}

export function containsSensitiveReportData(value?: any) : any {
  return sensitiveReportFindings(value).length > 0;
}

export function assertNoSensitiveReportLeak(value?: any, label: any = "report", { signal }: Record<string, any> = {}) : any {
  throwIfObservabilityAborted(signal);
  const text: any = serialized(value);
  if (Buffer.byteLength(text, "utf8") > OBSERVABILITY_BUDGETS.maxReportBytes) {
    throw new ObservabilityBudgetError("observability_report_bytes_exceeded");
  }
  const [finding] = sensitiveReportFindings(text);
  if (finding) {
    throw new Error(`${label} contains sensitive data: ${finding}`);
  }
  return true;
}

export function redactReportText(value: any = "", { dynamicNeedles = [] }: Record<string, any> = {}) : any {
  let text: any = String(value || "");
  for (const needle of dynamicNeedles) {
    if (needle) text = text.split(String(needle)).join("[redacted-path]");
  }
  text = text.split(/(\bhttps?:\/\/[^\s"'\\]+)/u).map((part?: any) : any => /^https?:\/\//u.test(part)
    ? SENSITIVE_REPORT_PATTERNS.some(([kind, pattern]: any[]) : any =>
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
  text = text.replace(/"(?:token|secret|password|authorization|apiKey|privateKey)"\s*:\s*"[^"]+"/giu, (entry?: any) : any => `${entry.slice(0, entry.indexOf(":"))}:"[redacted]"`);
  text = text.replace(/meshrix_[A-Za-z0-9_-]{12,}/gu, "meshrix_[redacted]");
  text = text.replace(/\bgrant_[a-z0-9]{6,}_[a-f0-9]{8,}\b/giu, "grant_[redacted]");
  text = text.replace(/\b(?:tool_exec|pending_op|delegated_mcp)_[A-Za-z0-9_-]{8,}\b/gu, "[redacted-runtime-id]");
  text = text.replace(/\btrace_[A-Fa-f0-9]{8,}\b/gu, "trace_[redacted]");
  text = text.replace(/(?:127\.0\.0\.1|localhost):\d+/gu, "[redacted-host]");
  return text;
}

function sanitizeValue(value: any, { depth, itemCounter, signal }: Record<string, any>) : any {
  throwIfObservabilityAborted(signal);
  if (depth > OBSERVABILITY_BUDGETS.maxScanDepth) return "[redacted-depth]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactReportText(value);
  itemCounter.count += 1;
  if (itemCounter.count > OBSERVABILITY_BUDGETS.maxScanItems) {
    throw new ObservabilityBudgetError("observability_scan_items_exceeded");
  }
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => sanitizeValue(item, { depth: depth + 1, itemCounter, signal }));
  }
  const output: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    const sensitiveKey: any = /token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key|credential/i.test(key);
    output[key] = sensitiveKey
      ? "[redacted]"
      : sanitizeValue(value[key], { depth: depth + 1, itemCounter, signal });
  }
  return output;
}

export function sanitizeSensitiveReport(value?: any, { signal }: Record<string, any> = {}) : any {
  const sanitized: any = sanitizeValue(value, { depth: 0, itemCounter: { count: 0 }, signal });
  assertNoSensitiveReportLeak(sanitized, "sanitized report", { signal });
  return sanitized;
}


export function reportPayloadDigest(value: Record<string, any> = {}) : any {
  const payload: any = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries((Object.entries(value) as [string, any][]).filter(([key]: any[]) : any => key !== "payloadDigest"))
    : value;
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

export function assertReportProvenance(report: Record<string, any> = {}, expected: Record<string, any> = {}) : any {
  for (const field of ["producer", "commandId", "sourceRevision", "payloadDigest"]) {
    if (!String(report?.[field] || "").trim()) {
      const error: Error & Record<string, any> = new Error(`Report provenance field ${field} is required.`);
      error.code = "observability_report_provenance_missing";
      error.field = field;
      throw error;
    }
  }
  for (const field of ["producer", "commandId", "sourceRevision"]) {
    if (expected[field] && report[field] !== expected[field]) {
      const error: Error & Record<string, any> = new Error(`Report provenance field ${field} does not match its producer contract.`);
      error.code = "observability_report_provenance_mismatch";
      error.field = field;
      throw error;
    }
  }
  if (report.payloadDigest !== reportPayloadDigest(report)) {
    const error: Error & Record<string, any> = new Error("Report payload digest does not match its content.");
    error.code = "observability_report_digest_mismatch";
    throw error;
  }
  return true;
}

export function finalizeSensitiveReport(value?: any, { signal, provenance = null }: Record<string, any> = {}) : any {
  const report: any = sanitizeSensitiveReport(value, { signal });
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

function reportContractError(code?: any, message?: any, field: any = "") : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  if (field) error.field = field;
  return error;
}

function assertReportPublicationContract(value?: any, { schemaVersion, verifier, provenance }: Record<string, any> = {}) : any {
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

export async function finalizeAndPublishSensitiveReport(value?: any, {
  filePath,
  schemaVersion,
  verifier,
  provenance,
  signal,
  checkpointDigest = "",
  requirements = []
}: Record<string, any> = {}) : Promise<any> {
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
  if (!Array.isArray(requirements) || requirements.length === 0 || requirements.some((item?: any) : any => !String(item || "").trim())) {
    throw reportContractError(
      "observability_report_requirements_invalid",
      "Report requirements must contain at least one non-empty requirement id.",
      "requirements"
    );
  }
  const inputBytes: any = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (inputBytes > OBSERVABILITY_BUDGETS.maxReportBytes) {
    throw new ObservabilityBudgetError("observability_report_bytes_exceeded");
  }
  const report: any = finalizeSensitiveReport({
    ...value,
    reportOwner: provenance.producer,
    requirements: [...new Set<any>(requirements.map(String))].sort(),
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
  const payload: any = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > OBSERVABILITY_BUDGETS.maxReportBytes) {
    throw new ObservabilityBudgetError("observability_report_bytes_exceeded");
  }
  throwIfObservabilityAborted(signal);
  await atomicWriteFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
  return report;
}

export function sanitizeSensitiveError(error?: any) : any {
  return redactReportText(String(error instanceof Error ? error.message : error)).slice(0, 1_000);
}
