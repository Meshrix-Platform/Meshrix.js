import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { resolveWithin } from "#meshrix/client-strings";

// Re-export sendJson from foundation (canonical location)
export { sendJson } from "#meshrix/http-response";

const CONTENT_TYPES: any = new Map<any, any>([
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

export function normalizeBaseUrl(value?: any) : any {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function parseBooleanFlag(value?: any) : any {
  return value === "1" || value === "true" || value === "yes";
}

export function parseEntityTypes(searchParams?: any) : any {
  return searchParams
    .getAll("entityType")
    .flatMap((value?: any) : any => String(value || "").split(","))
    .map((value?: any) : any => value.trim().toLowerCase())
    .filter(Boolean);
}

export function contentDispositionFileName(value?: any) : any {
  const fallback: any = String(value || "download.bin")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/[\\/:*?<>|";\r\n]+/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return fallback || "download.bin";
}

function encodeRfc5987Value(value?: any) : any {
  return encodeURIComponent(String(value || "download.bin").replace(/[\r\n]/g, "_"))
    .replace(/[!'()*]/g, (char?: any) : any => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDispositionHeader(disposition: any = "attachment", fileName: any = "download.bin") : any {
  const safeDisposition: any = /^[A-Za-z][A-Za-z0-9!#$&+.^_`|~-]*$/.test(String(disposition || ""))
    ? String(disposition)
    : "attachment";
  const rawFileName: any = String(fileName || "download.bin").replace(/[\r\n]/g, "_");
  return `${safeDisposition}; filename="${contentDispositionFileName(rawFileName)}"; filename*=UTF-8''${encodeRfc5987Value(rawFileName)}`;
}

export const DEFAULT_MAX_BODY_BYTES: any = 32 * 1024 * 1024; // 32 MB
export const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES: any = 128 * 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS: any = 64;
export const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_TENANT: any = 96 * 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_TENANT: any = 32;
export const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_SUBJECT: any = 64 * 1024 * 1024;
export const DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_SUBJECT: any = 16;

function positiveSafeInteger(value?: any, fallback?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function nonNegativeSafeInteger(value?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(Math.floor(parsed), Number.MAX_SAFE_INTEGER);
}

function requestBodyAdmissionError(code?: any) : any {
  const error: Error & Record<string, any> = new Error("HTTP 请求体资源暂时不可用，请稍后重试。");
  error.statusCode = 429;
  error.code = code;
  return error;
}

function requestBodyTooLargeError(maxBytes?: any) : any {
  const error: Error & Record<string, any> = new Error(`请求体过大，最大允许 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
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
}: Record<string, any> = {}) : any {
  const globalByteLimit: any = positiveSafeInteger(
    maxInFlightBytes,
    DEFAULT_MAX_IN_FLIGHT_BODY_BYTES
  );
  const globalRequestLimit: any = positiveSafeInteger(
    maxInFlightRequests,
    DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS
  );
  const subjectByteLimit: any = Math.min(
    globalByteLimit,
    positiveSafeInteger(
      maxInFlightBytesPerSubject,
      DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_SUBJECT
    )
  );
  const subjectRequestLimit: any = Math.min(
    globalRequestLimit,
    positiveSafeInteger(
      maxInFlightRequestsPerSubject,
      DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_SUBJECT
    )
  );
  const tenantByteLimit: any = Math.min(
    globalByteLimit,
    positiveSafeInteger(
      maxInFlightBytesPerTenant,
      DEFAULT_MAX_IN_FLIGHT_BODY_BYTES_PER_TENANT
    )
  );
  const tenantRequestLimit: any = Math.min(
    globalRequestLimit,
    positiveSafeInteger(
      maxInFlightRequestsPerTenant,
      DEFAULT_MAX_IN_FLIGHT_BODY_REQUESTS_PER_TENANT
    )
  );
  const tenants: any = new Map<any, any>();
  const subjects: any = new Map<any, any>();
  let inFlightBytes: any = 0;
  let inFlightRequests: any = 0;

  function acquire({ tenantKey = "", subjectKey = "", contentLength = 0, retainedMultiplier = 1 }: Record<string, any> = {}) : any {
    const normalizedTenantKey: any = String(tenantKey || "").trim() || "anonymous";
    const normalizedSubjectKey: any = String(subjectKey || "").trim() || "anonymous";
    const subjectBudgetKey: any = `${normalizedTenantKey}\u0000${normalizedSubjectKey}`;
    const multiplier: any = Math.max(1, Math.min(8, positiveSafeInteger(retainedMultiplier, 1)));
    const rawDeclaredBytes: any = nonNegativeSafeInteger(contentLength);
    const declaredBytes: any = rawDeclaredBytes > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
      ? Number.MAX_SAFE_INTEGER
      : rawDeclaredBytes * multiplier;
    const existingTenant: any = tenants.get(normalizedTenantKey);
    const tenantBytes: any = existingTenant?.bytes || 0;
    const tenantRequests: any = existingTenant?.requests || 0;
    const existingSubject: any = subjects.get(subjectBudgetKey);
    const subjectBytes: any = existingSubject?.bytes || 0;
    const subjectRequests: any = existingSubject?.requests || 0;

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

    const tenant: any = existingTenant || { bytes: 0, requests: 0 };
    tenant.bytes += declaredBytes;
    tenant.requests += 1;
    tenants.set(normalizedTenantKey, tenant);
    const subject: any = existingSubject || { bytes: 0, requests: 0 };
    subject.bytes += declaredBytes;
    subject.requests += 1;
    subjects.set(subjectBudgetKey, subject);
    inFlightBytes += declaredBytes;
    inFlightRequests += 1;

    let consumedBytes: any = 0;
    let reservedBytes: any = declaredBytes;
    let released: any = false;

    return Object.freeze({
      accountBytes(value?: any) : any {
        if (released) {
          throw new Error("HTTP request body admission lease is already released.");
        }
        const additionalBytes: any = nonNegativeSafeInteger(value);
        const nextConsumedBytes: any = consumedBytes + additionalBytes;
        if (!Number.isSafeInteger(nextConsumedBytes)) {
          throw requestBodyAdmissionError("request_body_global_byte_capacity_exceeded");
        }
        const retainedBytes: any = nextConsumedBytes > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
          ? Number.MAX_SAFE_INTEGER
          : nextConsumedBytes * multiplier;
        const extraReservation: any = Math.max(0, retainedBytes - reservedBytes);
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
      release() : any {
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
    getUsage() : any {
      return Object.freeze({
        inFlightBytes,
        inFlightRequests,
        activeTenantCount: tenants.size,
        activeSubjectCount: subjects.size
      });
    }
  });
}

function normalizeReadRequestBodyOptions(maxBytesOrOptions?: any) : any {
  if (maxBytesOrOptions && typeof maxBytesOrOptions === "object") {
    return {
      maxBytes: positiveSafeInteger(maxBytesOrOptions.maxBytes, DEFAULT_MAX_BODY_BYTES),
      admissionController: maxBytesOrOptions.admissionController || null,
      tenantKey: maxBytesOrOptions.tenantKey || "",
      subjectKey: maxBytesOrOptions.subjectKey || "",
      contentLength: nonNegativeSafeInteger(maxBytesOrOptions.contentLength),
      admissionLease: maxBytesOrOptions.admissionLease || null
    };
  }
  return {
    maxBytes: positiveSafeInteger(maxBytesOrOptions, DEFAULT_MAX_BODY_BYTES),
    admissionController: null,
    tenantKey: "",
    subjectKey: "",
    contentLength: 0,
    admissionLease: null
  };
}

export async function readRequestBody(request?: any, maxBytesOrOptions: any = DEFAULT_MAX_BODY_BYTES) : Promise<any> {
  const {
    maxBytes,
    admissionController,
    tenantKey,
    subjectKey,
    contentLength,
    admissionLease: suppliedAdmissionLease
  } = normalizeReadRequestBodyOptions(maxBytesOrOptions);
  const chunks: any[] = [];
  let total: any = 0;
  let admissionLease: any = null;
  let ownsAdmissionLease: any = false;

  try {
    if (contentLength > maxBytes) {
      throw requestBodyTooLargeError(maxBytes);
    }
    admissionLease = suppliedAdmissionLease || admissionController?.acquire?.({ tenantKey, subjectKey, contentLength }) || null;
    ownsAdmissionLease = Boolean(admissionLease && !suppliedAdmissionLease);

    for await (const incomingChunk of request) {
      const chunk: any = Buffer.isBuffer(incomingChunk)
        ? incomingChunk
        : Buffer.from(incomingChunk);
      const nextTotal: any = total + chunk.length;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes) {
        throw requestBodyTooLargeError(maxBytes);
      }
      admissionLease?.accountBytes(chunk.length);
      total = nextTotal;
      chunks.push(chunk);
    }

    return Buffer.concat(chunks, total);
  } catch (error: any) {
    // Drain and discard after rejection so a reusable socket cannot retain unread data.
    request.resume?.();
    throw error;
  } finally {
    if (ownsAdmissionLease) admissionLease?.release();
  }
}

export async function readJsonBody(request?: any) : Promise<any> {
  const raw: any = await readRequestBody(request);
  if (raw.length === 0) {
    return {};
  }

  return JSON.parse(raw.toString("utf8"));
}

export async function serveStaticFile(response?: any, distPath?: any, pathname?: any) : Promise<any> {
  if (!distPath) {
    return false;
  }

  const normalizedPath: any = pathname === "/" || pathname === "/console" ? "/index.html" : pathname;
  // M-5: use resolveWithin for reliable path-containment check instead of regex
  let filePath: any;
  try {
    const relative: any = path.normalize(normalizedPath).replace(/^[/\\]+/, "");
    filePath = resolveWithin(distPath, relative);
  } catch {
    // resolveWithin throws on path traversal attempts — treat as not found
    return false;
  }

  try {
    const stats: any = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error("Not a file");
    }

    const extension: any = path.extname(filePath).toLowerCase();
    const contentType: any = CONTENT_TYPES.get(extension) || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(stats.size),
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000"
    });
    await pipeline(createReadStream(filePath), response);
    return true;
  } catch (error: any) {
    if (response.headersSent) {
      response.destroy?.(error);
      return true;
    }
    return false;
  }
}

export function defaultAdvertisedHost(host?: any) : any {
  if (!host || host === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (host === "::") {
    return "::1";
  }

  return host;
}

export function formatUrlHost(host?: any) : any {
  return host.includes(":") ? `[${host}]` : host;
}
