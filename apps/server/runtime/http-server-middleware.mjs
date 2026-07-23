import { clientIpFromRequest } from "@lico/foundation/security/trusted-client-ip";
import { sendJson } from "#lico/http-utils";

const DEFAULT_RATE_LIMIT_BUCKET_CAPACITY = 10_000;
const MAX_RATE_LIMIT_BUCKET_CAPACITY = 100_000;

export function applySecurityHeaders(response, { isHttps = false, scriptNonce = "" } = {}) {
  if (response.headersSent) {
    return;
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${scriptNonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ")
  );
  if (isHttps) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function responseChunkBytes(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === "function") {
    return 0;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return Buffer.byteLength(String(chunk), typeof encoding === "string" ? encoding : "utf8");
}

export function trackResponseBodyBytes(response) {
  let responseBytes = 0;
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  response.write = function writeWithMetrics(chunk, encoding, callback) {
    responseBytes += responseChunkBytes(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };
  response.end = function endWithMetrics(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      return originalEnd(chunk);
    }
    responseBytes += responseChunkBytes(chunk, encoding);
    if (typeof encoding === "function") {
      return originalEnd(chunk, encoding);
    }
    return originalEnd(chunk, encoding, callback);
  };
  return () => responseBytes;
}

export function parsePositiveInt(value, fallback) {
  const valueText = String(value || "").trim();
  const parsed = Number(valueText);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function resolveHttpTransportLimits(runtimeOptions = {}) {
  const requestTimeoutMs = parsePositiveInt(
    runtimeOptions.httpRequestTimeoutMs,
    parsePositiveInt(process.env.LICO_HTTP_REQUEST_TIMEOUT_MS, 300_000)
  );
  return Object.freeze({
    maxConnections: parsePositiveInt(
      runtimeOptions.httpMaxConnections,
      parsePositiveInt(process.env.LICO_HTTP_MAX_CONNECTIONS, 2_000)
    ),
    requestTimeoutMs,
    headersTimeoutMs: Math.min(
      requestTimeoutMs,
      parsePositiveInt(
        runtimeOptions.httpHeadersTimeoutMs,
        parsePositiveInt(process.env.LICO_HTTP_HEADERS_TIMEOUT_MS, 60_000)
      )
    ),
    keepAliveTimeoutMs: parsePositiveInt(
      runtimeOptions.httpKeepAliveTimeoutMs,
      parsePositiveInt(process.env.LICO_HTTP_KEEP_ALIVE_TIMEOUT_MS, 5_000)
    ),
    maxRequestsPerSocket: parsePositiveInt(
      runtimeOptions.httpMaxRequestsPerSocket,
      parsePositiveInt(process.env.LICO_HTTP_MAX_REQUESTS_PER_SOCKET, 1_000)
    ),
    maxHeadersCount: parsePositiveInt(
      runtimeOptions.httpMaxHeadersCount,
      parsePositiveInt(process.env.LICO_HTTP_MAX_HEADERS_COUNT, 100)
    )
  });
}

export function createFixedWindowRateLimiter({
  limit,
  windowMs,
  label,
  maxBuckets = DEFAULT_RATE_LIMIT_BUCKET_CAPACITY
}) {
  const max = Math.min(
    Number.MAX_SAFE_INTEGER - 1,
    Math.max(1, Math.floor(Number(limit) || 0))
  );
  const windowMsValue = Math.max(1_000, Math.floor(Number(windowMs) || 60_000));
  const bucketCapacity = Math.min(
    MAX_RATE_LIMIT_BUCKET_CAPACITY,
    Math.max(1, Math.floor(Number(maxBuckets) || DEFAULT_RATE_LIMIT_BUCKET_CAPACITY))
  );
  // Reserve one slot for a shared overflow bucket. Once every dedicated slot is
  // active, new identifiers share this bucket instead of evicting an active
  // record and bypassing the limit by continually rotating identifiers.
  const dedicatedBucketCapacity = Math.max(0, bucketCapacity - 1);
  const buckets = new Map();
  let expirationHead = null;
  let expirationTail = null;
  let expirationCount = 0;
  let lastObservedAt = 0;
  let overflowBucket = null;

  function currentTime() {
    lastObservedAt = Math.max(lastObservedAt, Date.now());
    return lastObservedAt;
  }

  function enqueueExpiration(record) {
    if (expirationTail) {
      expirationTail.nextExpiration = record;
    } else {
      expirationHead = record;
    }
    expirationTail = record;
    expirationCount += 1;
  }

  function pruneExpired(now) {
    while (expirationHead?.expiresAt <= now) {
      const expired = expirationHead;
      expirationHead = expired.nextExpiration;
      expired.nextExpiration = null;
      expirationCount -= 1;
      if (buckets.get(expired.key) === expired) {
        buckets.delete(expired.key);
      }
    }
    if (!expirationHead) {
      expirationTail = null;
    }
    if (overflowBucket?.expiresAt <= now) {
      overflowBucket = null;
    }
  }

  function createBucket(key, now) {
    return {
      count: 0,
      windowStart: now,
      expiresAt: now + windowMsValue,
      key,
      nextExpiration: null
    };
  }

  function resolveBucket(key, now) {
    pruneExpired(now);
    const existing = buckets.get(key);
    if (existing) {
      return { aggregated: false, record: existing };
    }
    if (buckets.size < dedicatedBucketCapacity) {
      const record = createBucket(key, now);
      buckets.set(key, record);
      enqueueExpiration(record);
      return { aggregated: false, record };
    }
    if (!overflowBucket) {
      overflowBucket = createBucket("aggregate-overflow", now);
    }
    return { aggregated: true, record: overflowBucket };
  }

  function shouldAllow(identifier) {
    const key = String(identifier || "").trim() || "default";
    const now = currentTime();
    const { aggregated, record } = resolveBucket(key, now);
    record.count = Math.min(max + 1, record.count + 1);
    if (record.count <= max) {
      return {
        allowed: true,
        allowedAt: record.count,
        aggregated,
        key,
        limit: max,
        remaining: max - record.count,
        resetAt: record.expiresAt
      };
    }

    return {
      allowed: false,
      aggregated,
      key,
      limit: max,
      remaining: 0,
      resetAt: record.expiresAt,
      retryAfterSec: Math.max(1, Math.ceil((record.expiresAt - now) / 1000))
    };
  }

  function getState() {
    pruneExpired(currentTime());
    const overflowActive = Boolean(overflowBucket);
    return {
      bucketCount: buckets.size + (overflowActive ? 1 : 0),
      dedicatedBucketCount: buckets.size,
      expirationCount,
      maxBuckets: bucketCapacity,
      overflowActive
    };
  }

  return {
    getState,
    maxBuckets: bucketCapacity,
    shouldAllow,
    windowMs: windowMsValue,
    label
  };
}

export function normalizeClientIp(request, {
  trustedProxies = process.env.LICO_TRUSTED_PROXIES || ""
} = {}) {
  return clientIpFromRequest(request, { unknown: "unknown", trustedProxies });
}

export function resolveRequestSubjectKey(request, consoleAuth = null) {
  if (consoleAuth && typeof consoleAuth.getSessionFromRequest === "function") {
    const session = consoleAuth.getSessionFromRequest(request);
    if (session?.user?.username) {
      return `subject:${session.user.username}`;
    }
  }

  return "subject:anonymous";
}

export function resolveRequestTenantKey(request, consoleAuth = null) {
  if (consoleAuth && typeof consoleAuth.getSessionFromRequest === "function") {
    const session = consoleAuth.getSessionFromRequest(request);
    const tenantId = String(session?.user?.tenantId || "").trim();
    if (tenantId) return `tenant:${tenantId}`;
    const username = String(session?.user?.username || "").trim();
    if (username) return `tenant-subject:${username}`;
  }
  return "tenant:anonymous";
}

export function sendRateLimitResponse(response, details = {}) {
  const {
    reason = "请求过于频繁",
    windowMs = 60_000,
    limit = 0,
    resetAt = Date.now() + windowMs,
    retryAfterSec = Math.max(1, Math.ceil(windowMs / 1000))
  } = details;
  response.setHeader("Retry-After", String(retryAfterSec));
  response.setHeader("X-RateLimit-Limit", String(limit));
  response.setHeader("X-RateLimit-Remaining", "0");
  response.setHeader("X-RateLimit-Reset", String(Math.floor(resetAt / 1000)));
  sendJson(response, 429, {
    error: reason,
    policy: "rate-limited"
  });
}

export function routeFromRequestUrl(value = "") {
  try {
    return new URL(value || "/", "http://127.0.0.1").pathname;
  } catch {
    return value || "/";
  }
}

export function metricTransportForRoute(route = "") {
  if (route === "/mcp" || route.startsWith("/api/mcp") || route === "/.well-known/lico/mcp.json") {
    return "mcp";
  }
  if (route.startsWith("/api/operation-permission/v1")) {
    return "operation-permission";
  }
  return "http";
}

export function numericHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function resolveHttpRateLimits(runtimeOptions = {}) {
  const httpRateLimitWindowMs = parsePositiveInt(
    runtimeOptions.httpRateLimitWindowMs,
    parsePositiveInt(process.env.LICO_HTTP_RATE_LIMIT_WINDOW_MS, 60_000)
  );
  return {
    ip: {
      limit: parsePositiveInt(
        runtimeOptions.httpRateLimitPerIpPerMinute,
        parsePositiveInt(process.env.LICO_HTTP_RATE_LIMIT_IP_PER_MINUTE, 1_200)
      )
    },
    subject: {
      limit: parsePositiveInt(
        runtimeOptions.httpRateLimitPerSubjectPerMinute,
        parsePositiveInt(process.env.LICO_HTTP_RATE_LIMIT_SUBJECT_PER_MINUTE, 1_000)
      )
    },
    tenant: {
      limit: parsePositiveInt(
        runtimeOptions.httpRateLimitPerTenantPerMinute,
        parsePositiveInt(process.env.LICO_HTTP_RATE_LIMIT_TENANT_PER_MINUTE, 4_000)
      )
    },
    login: {
      limit: parsePositiveInt(
        runtimeOptions.httpRateLimitLoginPerIpPerMinute,
        parsePositiveInt(process.env.LICO_HTTP_RATE_LIMIT_LOGIN_PER_MINUTE, 40)
      )
    },
    windowMs: Math.max(1_000, httpRateLimitWindowMs)
  };
}

function parseAllowPublicConsoleFlag(runtimeOptions = {}) {
  const value =
    runtimeOptions.allowPublicConsole ??
    process.env.LICO_ALLOW_PUBLIC_CONSOLE ??
    "";
  return value === true || ["1", "true", "yes"].includes(String(value).trim().toLowerCase());
}

function normalizeListenHost(host) {
  return String(host || "").trim().toLowerCase();
}

function isLoopbackListenHost(host) {
  const value = normalizeListenHost(host);
  return !value ||
    value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "[::1]";
}

export function assertSafeListenHost(host, runtimeOptions = {}) {
  if (isLoopbackListenHost(host) || parseAllowPublicConsoleFlag(runtimeOptions)) {
    return;
  }
  throw new Error(
    "服务端默认只允许监听本机回环地址。若确需暴露到局域网/公网，请显式设置 LICO_ALLOW_PUBLIC_CONSOLE=1 或 --allow-public-console，并确保前置网络访问控制已配置。"
  );
}
