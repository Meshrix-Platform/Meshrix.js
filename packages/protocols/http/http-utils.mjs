import fs from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "#lico/client-strings";

// Re-export sendJson from foundation (canonical location)
export { sendJson } from "#lico/http-response";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"]
]);

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function parseBooleanFlag(value) {
  return value === "1" || value === "true" || value === "yes";
}

export function parseEntityTypes(searchParams) {
  return searchParams
    .getAll("entityType")
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function contentDispositionFileName(value) {
  const fallback = String(value || "download.bin")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/[\\/:*?<>|";\r\n]+/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return fallback || "download.bin";
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(String(value || "download.bin").replace(/[\r\n]/g, "_"))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDispositionHeader(disposition = "attachment", fileName = "download.bin") {
  const safeDisposition = /^[A-Za-z][A-Za-z0-9!#$&+.^_`|~-]*$/.test(String(disposition || ""))
    ? String(disposition)
    : "attachment";
  const rawFileName = String(fileName || "download.bin").replace(/[\r\n]/g, "_");
  return `${safeDisposition}; filename="${contentDispositionFileName(rawFileName)}"; filename*=UTF-8''${encodeRfc5987Value(rawFileName)}`;
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MB
export const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS = 64;
export const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_TENANT = 96 * 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_TENANT = 32;
export const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_SUBJECT = 64 * 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_SUBJECT = 16;

function positiveSafeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function nonNegativeSafeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(Math.floor(parsed), Number.MAX_SAFE_INTEGER);
}

function requestBodyAdmissionError(code) {
  const error = new Error("HTTP 请求体资源暂时不可用，请稍后重试。");
  error.statusCode = 429;
  error.code = code;
  return error;
}

function requestBodyTooLargeError(maxBytes) {
  const error = new Error(`请求体过大，最大允许 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
  error.statusCode = 413;
  error.code = "request_body_too_large";
  return error;
}

/**
 * Creates one server-scoped request-body admission budget. Declared lengths reserve
 * only counters, never buffers; chunked or under-declared bodies account for bytes
 * incrementally. Every lease has O(1) acquire, account, and release operations.
 */
export function createRequestBodyAdmissionController({
  maxInFlightBytes = DEFAULT_MAX_IN_FLIGHT_BODY_BYTES,
  maxInFlightRequests = DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS,
  maxInFlightBytesPerTenant = DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_TENANT,
  maxInFlightRequestsPerTenant = DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_TENANT,
  maxInFlightBytesPerSubject = DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_SUBJECT,
  maxInFlightRequestsPerSubject = DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_SUBJECT
} = {}) {
  const globalByteLimit = positiveSafeInteger(
    maxInFlightBytes,
    DEFAULT_MAX_IN_FLIGHT_BODY_BYTES
  );
  const globalRequestLimit = positiveSafeInteger(
    maxInFlightRequests,
    DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS
  );
  const subjectByteLimit = Math.min(
    globalByteLimit,
    positiveSafeInteger(
      maxInFlightBytesPerSubject,
      DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_SUBJECT
    )
  );
  const subjectRequestLimit = Math.min(
    globalRequestLimit,
    positiveSafeInteger(
      maxInFlightRequestsPerSubject,
      DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_SUBJECT
    )
  );
  const tenantByteLimit = Math.min(
    globalByteLimit,
    positiveSafeInteger(
      maxInFlightBytesPerTenant,
      DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_TENANT
    )
  );
  const tenantRequestLimit = Math.min(
    globalRequestLimit,
    positiveSafeInteger(
      maxInFlightRequestsPerTenant,
      DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_TENANT
    )
  );
  const tenants = new Map();
  const subjects = new Map();
  let inFlightBytes = 0;
  let inFlightRequests = 0;

  function acquire({ tenantKey = "", subjectKey = "", contentLength = 0 } = {}) {
    const normalizedTenantKey = String(tenantKey || "").trim() || "anonymous";
    const normalizedSubjectKey = String(subjectKey || "").trim() || "anonymous";
    const subjectBudgetKey = `${normalizedTenantKey}\u0000${normalizedSubjectKey}`;
    const declaredBytes = nonNegativeSafeInteger(contentLength);
    const existingTenant = tenants.get(normalizedTenantKey);
    const tenantBytes = existingTenant?.bytes || 0;
    const tenantRequests = existingTenant?.requests || 0;
    const existingSubject = subjects.get(subjectBudgetKey);
    const subjectBytes = existingSubject?.bytes || 0;
    const subjectRequests = existingSubject?.requests || 0;

    if (inFlightRequests >= globalRequestLimit) {
      throw requestBodyAdmissionError("request_body_global_request_capacity_exceeded");
    }
    if (tenantRequests >= tenantRequestLimit) {
      throw requestBodyAdmissionError("request_body_tenant_request_capacity_exceeded");
    }
    if (subjectRequests >= subjectRequestLimit) {
      throw requestBodyAdmissionError("request_body_subject_request_capacity_exceeded");
    }
    if (declaredBytes > globalByteLimit - inFlightBytes) {
      throw requestBodyAdmissionError("request_body_global_byte_capacity_exceeded");
    }
    if (declaredBytes > tenantByteLimit - tenantBytes) {
      throw requestBodyAdmissionError("request_body_tenant_byte_capacity_exceeded");
    }
    if (declaredBytes > subjectByteLimit - subjectBytes) {
      throw requestBodyAdmissionError("request_body_subject_byte_capacity_exceeded");
    }

    const tenant = existingTenant || { bytes: 0, requests: 0 };
    tenant.bytes += declaredBytes;
    tenant.requests += 1;
    tenants.set(normalizedTenantKey, tenant);
    const subject = existingSubject || { bytes: 0, requests: 0 };
    subject.bytes += declaredBytes;
    subject.requests += 1;
    subjects.set(subjectBudgetKey, subject);
    inFlightBytes += declaredBytes;
    inFlightRequests += 1;

    let consumedBytes = 0;
    let reservedBytes = declaredBytes;
    let released = false;

    return Object.freeze({
      accountBytes(value) {
        if (released) {
          throw new Error("HTTP request body admission lease is already released.");
        }
        const additionalBytes = nonNegativeSafeInteger(value);
        const nextConsumedBytes = consumedBytes + additionalBytes;
        if (!Number.isSafeInteger(nextConsumedBytes)) {
          throw requestBodyAdmissionError("request_body_global_byte_capacity_exceeded");
        }
        const extraReservation = Math.max(0, nextConsumedBytes - reservedBytes);
        if (extraReservation > globalByteLimit - inFlightBytes) {
          throw requestBodyAdmissionError("request_body_global_byte_capacity_exceeded");
        }
        if (extraReservation > tenantByteLimit - tenant.bytes) {
          throw requestBodyAdmissionError("request_body_tenant_byte_capacity_exceeded");
        }
        if (extraReservation > subjectByteLimit - subject.bytes) {
          throw requestBodyAdmissionError("request_body_subject_byte_capacity_exceeded");
        }
        consumedBytes = nextConsumedBytes;
        if (extraReservation > 0) {
          reservedBytes += extraReservation;
          inFlightBytes += extraReservation;
          tenant.bytes += extraReservation;
          subject.bytes += extraReservation;
        }
      },
      release() {
        if (released) {
          return;
        }
        released = true;
        inFlightBytes = Math.max(0, inFlightBytes - reservedBytes);
        inFlightRequests = Math.max(0, inFlightRequests - 1);
        tenant.bytes = Math.max(0, tenant.bytes - reservedBytes);
        tenant.requests = Math.max(0, tenant.requests - 1);
        if (tenant.bytes === 0 && tenant.requests === 0) {
          tenants.delete(normalizedTenantKey);
        }
        subject.bytes = Math.max(0, subject.bytes - reservedBytes);
        subject.requests = Math.max(0, subject.requests - 1);
        if (subject.bytes === 0 && subject.requests === 0) {
          subjects.delete(subjectBudgetKey);
        }
      }
    });
  }

  return Object.freeze({
    acquire,
    getUsage() {
      return Object.freeze({
        inFlightBytes,
        inFlightRequests,
        activeTenantCount: tenants.size,
        activeSubjectCount: subjects.size
      });
    }
  });
}

function normalizeReadRequestBodyOptions(maxBytesOrOptions) {
  if (maxBytesOrOptions && typeof maxBytesOrOptions === "object") {
    return {
      maxBytes: positiveSafeInteger(maxBytesOrOptions.maxBytes, DEFAULT_MAX_BODY_BYTES),
      admissionController: maxBytesOrOptions.admissionController || null,
      tenantKey: maxBytesOrOptions.tenantKey || "",
      subjectKey: maxBytesOrOptions.subjectKey || "",
      contentLength: nonNegativeSafeInteger(maxBytesOrOptions.contentLength)
    };
  }
  return {
    maxBytes: positiveSafeInteger(maxBytesOrOptions, DEFAULT_MAX_BODY_BYTES),
    admissionController: null,
    tenantKey: "",
    subjectKey: "",
    contentLength: 0
  };
}

export async function readRequestBody(request, maxBytesOrOptions = DEFAULT_MAX_BODY_BYTES) {
  const {
    maxBytes,
    admissionController,
    tenantKey,
    subjectKey,
    contentLength
  } = normalizeReadRequestBodyOptions(maxBytesOrOptions);
  const chunks = [];
  let total = 0;
  let admissionLease = null;

  try {
    if (contentLength > maxBytes) {
      throw requestBodyTooLargeError(maxBytes);
    }
    admissionLease = admissionController?.acquire?.({ tenantKey, subjectKey, contentLength }) || null;

    for await (const incomingChunk of request) {
      const chunk = Buffer.isBuffer(incomingChunk)
        ? incomingChunk
        : Buffer.from(incomingChunk);
      const nextTotal = total + chunk.length;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes) {
        throw requestBodyTooLargeError(maxBytes);
      }
      admissionLease?.accountBytes(chunk.length);
      total = nextTotal;
      chunks.push(chunk);
    }

    return Buffer.concat(chunks, total);
  } catch (error) {
    // Drain and discard after rejection so a reusable socket cannot retain unread data.
    request.resume?.();
    throw error;
  } finally {
    admissionLease?.release();
  }
}

export async function readJsonBody(request) {
  const raw = await readRequestBody(request);
  if (raw.length === 0) {
    return {};
  }

  return JSON.parse(raw.toString("utf8"));
}

export async function serveStaticFile(response, distPath, pathname) {
  if (!distPath) {
    return false;
  }

  const normalizedPath = pathname === "/" || pathname === "/console" ? "/index.html" : pathname;
  // M-5: use resolveWithin for reliable path-containment check instead of regex
  let filePath;
  try {
    const relative = path.normalize(normalizedPath).replace(/^[/\\]+/, "");
    filePath = resolveWithin(distPath, relative);
  } catch {
    // resolveWithin throws on path traversal attempts — treat as not found
    return false;
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error("Not a file");
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES.get(extension) || "application/octet-stream";
    const buffer = await fs.readFile(filePath);

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000"
    });
    response.end(buffer);
    return true;
  } catch {
    return false;
  }
}

export function defaultAdvertisedHost(host) {
  if (!host || host === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (host === "::") {
    return "::1";
  }

  return host;
}

export function formatUrlHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}
