import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { summarizeError } from "#meshrix/runtime-logger";

const MAX_PROXY_RESPONSE_BYTES: any = 64 * 1024 * 1024;
const PROXY_RESPONSE_SCOPE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  global: 128 * 1024 * 1024,
  tenant: 96 * 1024 * 1024,
  subject: 64 * 1024 * 1024
});
const admittedProxyResponseBytes: any = new Map<any, any>();

function privateScopeKey(kind?: any, value?: any) : any {
  const normalized: any = String(value || "anonymous");
  return `${kind}:${createHash("sha256").update(normalized).digest("hex")}`;
}

function proxyResponseScopes(request?: any) : any {
  const runtimeAuthorization: any = request?.__meshrixOperationRuntimeAuthorization || {};
  const session: any = request?.__meshrixSession || {};
  return [
    { key: "global", limit: PROXY_RESPONSE_SCOPE_LIMITS.global },
    { key: privateScopeKey("tenant", runtimeAuthorization.tenantId || session.tenantId), limit: PROXY_RESPONSE_SCOPE_LIMITS.tenant },
    { key: privateScopeKey("subject", runtimeAuthorization.grantRef || session.userId), limit: PROXY_RESPONSE_SCOPE_LIMITS.subject }
  ];
}

function createProxyResponseLease(request?: any) : any {
  const scopes: any[] = proxyResponseScopes(request);
  let reserved: any = 0;
  let released: any = false;
  return Object.freeze({
    reserve(bytes?: any) : any {
      const increment: any = Math.max(0, Number(bytes || 0));
      if (!Number.isSafeInteger(increment) || reserved + increment > MAX_PROXY_RESPONSE_BYTES) {
        throw Object.assign(new Error("Forward proxy response exceeded its admission limit."), {
          code: "forward_proxy_response_limit_exceeded"
        });
      }
      if (scopes.some((scope?: any) : any => Number(admittedProxyResponseBytes.get(scope.key) || 0) + increment > scope.limit)) {
        throw Object.assign(new Error("Forward proxy response capacity is unavailable."), {
          code: "forward_proxy_response_capacity_exceeded"
        });
      }
      for (const scope of scopes) admittedProxyResponseBytes.set(
        scope.key,
        Number(admittedProxyResponseBytes.get(scope.key) || 0) + increment
      );
      reserved += increment;
    },
    release() : any {
      if (released) return;
      released = true;
      for (const scope of scopes) {
        const remaining: any = Math.max(0, Number(admittedProxyResponseBytes.get(scope.key) || 0) - reserved);
        if (remaining === 0) admittedProxyResponseBytes.delete(scope.key);
        else admittedProxyResponseBytes.set(scope.key, remaining);
      }
    },
    get reservedBytes() : any { return reserved; }
  });
}

export function resolveProxyUpstreamUrl({ requestUrl = "/", targetBaseUrl = "" }: Record<string, any> = {}) : any {
  const target: any = new URL(String(targetBaseUrl || ""));
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Forward proxy targetBaseUrl must use http or https.");
  }
  const localRequestUrl: any = new URL(String(requestUrl || "/"), "http://127.0.0.1");
  return new URL(`${localRequestUrl.pathname}${localRequestUrl.search}`, `${target.origin}/`);
}

export async function proxyApiRequest({
  request,
  response,
  requestBody,
  targetBaseUrl,
  signal = null,
  logger = null
}: Record<string, any>) : Promise<any> {
  const upstreamUrl: any = resolveProxyUpstreamUrl({ requestUrl: request.url || "/", targetBaseUrl });
  const startedAt: any = Date.now();
  logger?.info?.("http.proxy.started", {
    requestId: request.__meshrixRequestId || "",
    method: request.method || "GET",
    route: upstreamUrl.pathname,
    bodyBytes: requestBody?.length || 0
  });
  const headers: any = new Headers();
  const allowedRequestHeaders: any = new Set<any>([
    "accept",
    "content-type",
    "x-meshrix-csrf",
    "x-meshrix-safety-confirm",
    "x-meshrix-confirm"
  ]);

  for (const [name, value] of (Object.entries(request.headers || {}) as [string, any][])) {
    if (!value) {
      continue;
    }

    const lower: any = name.toLowerCase();
    if (!allowedRequestHeaders.has(lower)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    headers.set(name, value);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("content-length", String(requestBody?.length || 0));
  }

  let upstream: any;
  let upstreamRequest: any = null;
  let abortUpstream: any = null;
  try {
    upstream = await new Promise((resolve?: any, reject?: any) : any => {
      const client: any = upstreamUrl.protocol === "https:" ? https : http;
      upstreamRequest = client.request(
        upstreamUrl,
        {
          method: request.method || "GET",
          headers: Object.fromEntries(headers.entries()),
          timeout: 30_000
        },
        (upstreamResponse?: any) : any => resolve(upstreamResponse)
      );
      upstreamRequest.on("timeout", () : any => {
        upstreamRequest.destroy(new Error("上游服务请求超时。"));
      });
      upstreamRequest.on("error", reject);
      abortUpstream = () : any => upstreamRequest.destroy(Object.assign(new Error("Forward proxy request cancelled."), {
        code: "forward_proxy_cancelled"
      }));
      if (signal?.aborted) abortUpstream();
      else signal?.addEventListener?.("abort", abortUpstream, { once: true });
      if (request.method !== "GET" && request.method !== "HEAD" && requestBody?.length) {
        upstreamRequest.write(requestBody);
      }
      upstreamRequest.end();
    });
  } catch (error: any) {
    if (abortUpstream) signal?.removeEventListener?.("abort", abortUpstream);
    logger?.error?.("http.proxy.failed", {
      requestId: request.__meshrixRequestId || "",
      method: request.method || "GET",
      route: upstreamUrl.pathname,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error)
    });
    throw error;
  }
  const upstreamHeaders: Record<string, any> = {};
  const blockedResponseHeaders: any = new Set<any>([
    "connection",
    "content-length",
    "keep-alive",
    "location",
    "proxy-authenticate",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  for (const [name, value] of (Object.entries(upstream.headers || {}) as [string, any][])) {
    const lower: any = name.toLowerCase();
    if (blockedResponseHeaders.has(lower)) {
      continue;
    }

    upstreamHeaders[name] = value;
  }
  const lease: any = createProxyResponseLease(request);
  let responseBytes: any = 0;
  const declaredLengthText: any = Array.isArray(upstream.headers?.["content-length"])
    ? upstream.headers["content-length"][0]
    : upstream.headers?.["content-length"];
  const declaredLength: any = /^\d+$/u.test(String(declaredLengthText || ""))
    ? Number(declaredLengthText)
    : null;
  try {
    if (declaredLength !== null) lease.reserve(declaredLength);
    const responseShim: any = typeof response?.end === "function" && typeof response?.write !== "function" && typeof response?.on !== "function"
      ? Object.assign(new Transform({
        transform(chunk?: any, _encoding?: any, callback?: any) {
          callback(null, chunk);
        },
        flush(callback?: any) {
          response.end(Buffer.alloc(0));
          callback();
        }
      }), { writeHead: response.writeHead?.bind(response) })
      : response;
    responseShim.writeHead(upstream.statusCode || 502, upstreamHeaders);
    const meter: any = new Transform({
      transform(chunk?: any, _encoding?: any, callback?: any) {
        try {
          const bytes: any = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (declaredLength === null) lease.reserve(bytes.length);
          else if (responseBytes + bytes.length > declaredLength) {
            lease.reserve(responseBytes + bytes.length - Math.max(responseBytes, declaredLength));
          }
          responseBytes += bytes.length;
          callback(null, bytes);
        } catch (error: any) {
          callback(error);
        }
      }
    });
    await pipeline(upstream, meter, responseShim, signal ? { signal } : {});
  } finally {
    if (abortUpstream) signal?.removeEventListener?.("abort", abortUpstream);
    lease.release();
  }
  logger?.info?.("http.proxy.completed", {
    requestId: request.__meshrixRequestId || "",
    method: request.method || "GET",
    route: upstreamUrl.pathname,
    statusCode: upstream.statusCode || 502,
    responseBytes,
    durationMs: Date.now() - startedAt
  });
}
