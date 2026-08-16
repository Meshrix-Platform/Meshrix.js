import crypto from "node:crypto";

export const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf|prompt|runtime[-_]?id|grant[-_]?id|pending[-_]?operation[-_]?id|relay[-_]?session[-_]?id|relay[-_]?turn[-_]?id|relay[-_]?mcp[-_]?id|source[-_]?path|local[-_]?path|dir[-_]?path|source[-_]?root|local[-_]?root|config[-_]?path|content[-_]?base64|file[-_]?content|raw[-_]?content|^content$/i;
const OPAQUE_BINDING_KEY_PATTERN =
  /^(secretBindingId|secretBindingIds|allowedSecretBindings|credentialBindingIds)$/i;
const SENSITIVE_VALUE_PATTERN =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
export const ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\[^\s"'<>]+|\\\\[^\s"'<>]+|\/[a-zA-Z][a-zA-Z0-9._-]*(?:\/[^\s"',<>]+)+)/g;
export const MAX_JSON_BYTES = 12 * 1024;

export class OperationAuditCapacityError extends Error {
  actual: number;
  readonly code = "operation_audit_capacity_exhausted";
  limit: number;
  reason: string;
  constructor(reason: string, limit: number, actual: number) {
    super(`Operation audit capacity is exhausted (${reason}).`);
    this.name = "OperationAuditCapacityError";
    this.code = "operation_audit_capacity_exhausted";
    this.reason = reason;
    this.limit = limit;
    this.actual = actual;
  }
}

export class OperationAuditIdRequiredError extends TypeError {
  readonly code = "operation_audit_id_required";
  constructor() {
    super("A non-empty auditId is required for idempotent audit append.");
    this.name = "OperationAuditIdRequiredError";
    this.code = "operation_audit_id_required";
  }
}

export class OperationAuditIdempotencyConflictError extends Error {
  auditId: string;
  readonly code = "operation_audit_idempotency_conflict";
  constructor(auditId = "") {
    super("The auditId is already bound to a different normalized audit record.");
    this.name = "OperationAuditIdempotencyConflictError";
    this.code = "operation_audit_idempotency_conflict";
    this.auditId = auditId;
  }
}

export function truncateOperationAuditJson<T>(value?: T): T | undefined | { redacted: true; reason: string; byteLength: number; sha256: string } {
  const text = JSON.stringify(value ?? {});
  if (Buffer.byteLength(text, "utf8") <= MAX_JSON_BYTES) return value;
  return {
    redacted: true,
    reason: "payload_too_large",
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: crypto.createHash("sha256").update(text).digest("hex")
  };
}

export function redactOperationAuditValue(value?: unknown, depth = 0): unknown {
  if (depth > 8) return "<redacted-depth>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(SENSITIVE_VALUE_PATTERN, (match) => {
        const prefix = match.match(/^\s*(api[-_]?key|token|secret|password)\s*[:=]/i)?.[0] || "";
        return prefix ? `${prefix}<redacted>` : "<redacted-secret>";
      })
      .replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
  }
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) {
    return {
      redacted: true,
      reason: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex")
    };
  }
  if (Array.isArray(value)) {
    return truncateOperationAuditJson(value.map((item) => redactOperationAuditValue(item, depth + 1)));
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) && !OPAQUE_BINDING_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactOperationAuditValue(nested, depth + 1);
  }
  return truncateOperationAuditJson(output);
}
