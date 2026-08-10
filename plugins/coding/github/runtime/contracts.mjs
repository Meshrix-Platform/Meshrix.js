const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|token)/iu;
const SENSITIVE_VALUE = /(?:\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9_]+|\bgithub_pat_[A-Za-z0-9_]+|secret:\/\/)/iu;
const SAFE_ERROR_CODES = new Set([
  "coding_github_external_service_cancelled",
  "coding_github_external_service_denied",
  "coding_github_external_service_failed",
  "coding_github_external_service_rate_limited",
  "coding_github_external_service_response_invalid",
  "coding_github_external_service_timeout",
  "coding_github_external_service_unavailable"
]);

export function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function codingGithubError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function assertSafeString(value, label, schema) {
  if (typeof value !== "string") throw codingGithubError("coding_github_input_invalid");
  if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
    throw codingGithubError("coding_github_input_invalid");
  }
  if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
    throw codingGithubError("coding_github_input_invalid");
  }
  if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) {
    throw codingGithubError("coding_github_input_invalid");
  }
  if (SENSITIVE_VALUE.test(value)) {
    throw codingGithubError("coding_github_sensitive_input_rejected");
  }
  return String(value);
}

function validateValue(value, schema = {}, label = "input", depth = 0) {
  if (depth > 12) throw codingGithubError("coding_github_input_invalid");
  if (schema.enum) {
    if (!schema.enum.includes(value)) throw codingGithubError("coding_github_input_invalid");
    return value;
  }
  if (schema.type === "string") return assertSafeString(value, label, schema);
  if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) throw codingGithubError("coding_github_input_invalid");
    if (Number.isInteger(schema.minimum) && value < schema.minimum) throw codingGithubError("coding_github_input_invalid");
    if (Number.isInteger(schema.maximum) && value > schema.maximum) throw codingGithubError("coding_github_input_invalid");
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw codingGithubError("coding_github_input_invalid");
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw codingGithubError("coding_github_input_invalid");
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) throw codingGithubError("coding_github_input_invalid");
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw codingGithubError("coding_github_input_invalid");
    const projected = value.map((item, index) => validateValue(item, schema.items || {}, `${label}[${index}]`, depth + 1));
    if (schema.uniqueItems && new Set(projected.map((item) => JSON.stringify(item))).size !== projected.length) {
      throw codingGithubError("coding_github_input_invalid");
    }
    return projected;
  }
  if (schema.type === "object" || plainObject(value)) {
    if (!plainObject(value)) throw codingGithubError("coding_github_input_invalid");
    const properties = plainObject(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const field of required) {
      if (!Object.hasOwn(value, field)) throw codingGithubError("coding_github_input_invalid");
    }
    const output = {};
    const entries = Object.entries(value);
    if (entries.length > 128) throw codingGithubError("coding_github_input_invalid");
    for (const [field, item] of entries) {
      if (SENSITIVE_KEY.test(field)) throw codingGithubError("coding_github_sensitive_input_rejected");
      if (!Object.hasOwn(properties, field)) {
        if (schema.additionalProperties !== true) throw codingGithubError("coding_github_input_invalid");
        output[field] = projectJsonValue(item, { redact: false, depth: depth + 1 });
        continue;
      }
      output[field] = validateValue(item, properties[field], `${label}.${field}`, depth + 1);
    }
    return output;
  }
  if (schema.type === undefined) return projectJsonValue(value, { redact: false, depth: depth + 1 });
  throw codingGithubError("coding_github_input_invalid");
}

export function validateOperationInput(definition, input = {}) {
  if (!definition?.inputSchema) throw codingGithubError("coding_github_operation_not_registered", 404);
  const projected = validateValue(input, definition.inputSchema, definition.id);
  const serialized = JSON.stringify(projected);
  if (Buffer.byteLength(serialized, "utf8") > 262144) throw codingGithubError("coding_github_input_too_large", 413);
  return Object.freeze(projected);
}

export function assertCurrentGovernance(call = {}) {
  if (call?.auth?.authenticated !== true || call?.governance?.authorized !== true || call?.governance?.current !== true) {
    throw codingGithubError("coding_github_operation_denied", 403);
  }
}

export function projectJsonValue(value, { redact = true, depth = 0 } = {}) {
  if (depth > 12) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (redact && SENSITIVE_VALUE.test(value)) return "[redacted]";
    return value.length <= 32768 ? value : value.slice(0, 32768);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((entry) => projectJsonValue(entry, { redact, depth: depth + 1 }));
  }
  if (!plainObject(value)) return null;
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 128)) {
    if (redact && SENSITIVE_KEY.test(key)) continue;
    output[key] = projectJsonValue(entry, { redact, depth: depth + 1 });
  }
  return output;
}

function safeStatus(value, fallback = 502) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
}

function safePagination(value) {
  if (!plainObject(value)) return undefined;
  const pagination = {};
  if (typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 512) {
    pagination.nextCursor = value.nextCursor;
  }
  if (Number.isSafeInteger(value.page) && value.page >= 1 && value.page <= 10000) pagination.page = value.page;
  if (Number.isSafeInteger(value.perPage) && value.perPage >= 1 && value.perPage <= 100) pagination.perPage = value.perPage;
  return Object.keys(pagination).length > 0 ? Object.freeze(pagination) : undefined;
}

function safeRateLimit(value) {
  if (!plainObject(value)) return undefined;
  const rateLimit = {};
  if (Number.isSafeInteger(value.remaining) && value.remaining >= 0) rateLimit.remaining = value.remaining;
  if (typeof value.resetAt === "string" && value.resetAt.length <= 64 && Number.isFinite(Date.parse(value.resetAt))) {
    rateLimit.resetAt = new Date(value.resetAt).toISOString();
  }
  if (Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 3600000) {
    rateLimit.retryAfterMs = value.retryAfterMs;
  }
  return Object.keys(rateLimit).length > 0 ? Object.freeze(rateLimit) : undefined;
}

export function projectExternalServiceResponse(response) {
  if (!plainObject(response)) throw codingGithubError("coding_github_external_service_response_invalid", 502);
  const status = safeStatus(response.status, response.ok === false ? 502 : 200);
  if (response.ok !== true) {
    const sourceCode = String(response.error?.code || "");
    const code = SAFE_ERROR_CODES.has(sourceCode)
      ? sourceCode
      : status === 429
        ? "coding_github_external_service_rate_limited"
        : status === 403
          ? "coding_github_external_service_denied"
          : "coding_github_external_service_failed";
    throw codingGithubError(code, status >= 400 ? status : 502);
  }
  const data = projectJsonValue(response.data);
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > 1048576) {
    throw codingGithubError("coding_github_external_service_response_invalid", 502);
  }
  const pagination = safePagination(response.pagination);
  const rateLimit = safeRateLimit(response.rateLimit);
  const receiptRef = typeof response.receiptRef === "string" && /^[A-Za-z0-9_.:-]{1,256}$/u.test(response.receiptRef)
    ? response.receiptRef
    : undefined;
  return Object.freeze({
    ok: true,
    status,
    data,
    ...(pagination ? { pagination } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(receiptRef ? { receiptRef } : {})
  });
}

export function sanitizedHttpFailure(error) {
  const sourceCode = String(error?.code || "");
  const code = /^[a-z][a-z0-9_]{2,96}$/u.test(sourceCode) && sourceCode.startsWith("coding_github_")
    ? sourceCode
    : "coding_github_external_service_failed";
  const statusCode = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 502;
  return Object.freeze({
    statusCode,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: Object.freeze({ ok: false, error: Object.freeze({ code }) })
  });
}
