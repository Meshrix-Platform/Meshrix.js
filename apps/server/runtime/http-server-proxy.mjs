import http from "node:http";
import https from "node:https";
import { summarizeError } from "#meshrix/runtime-logger";

function hostnameFromUrl(value = "") {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function originFromUrl(value = "") {
  try {
    return new URL(String(value || "")).origin.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHostname(hostname = "") {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.");
}

export function resolveProxyUpstreamUrl({ requestUrl = "/", targetBaseUrl = "" } = {}) {
  const target = new URL(String(targetBaseUrl || ""));
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Forward proxy targetBaseUrl must use http or https.");
  }
  const localRequestUrl = new URL(String(requestUrl || "/"), "http://127.0.0.1");
  return new URL(`${localRequestUrl.pathname}${localRequestUrl.search}`, `${target.origin}/`);
}

export function proxyShouldForwardCredentials({ targetBaseUrl = "", upstreamUrl = "", discoveryState = {} } = {}) {
  const targetHost = hostnameFromUrl(targetBaseUrl);
  const targetOrigin = originFromUrl(targetBaseUrl);
  if (!targetHost || !targetOrigin) {
    return false;
  }
  const upstreamOrigin = upstreamUrl ? originFromUrl(upstreamUrl) : targetOrigin;
  if (upstreamOrigin !== targetOrigin) {
    return false;
  }
  if (isLoopbackHostname(targetHost)) {
    return true;
  }
  if (!targetOrigin.startsWith("https://")) {
    return false;
  }
  const trustedOrigins = new Set([
    hostnameFromUrl(discoveryState.advertisedBaseUrl),
    hostnameFromUrl(discoveryState.bootstrapBaseUrl),
    hostnameFromUrl(discoveryState.activeServiceUrl)
  ].filter(Boolean));
  const trustedOriginValues = new Set([
    originFromUrl(discoveryState.advertisedBaseUrl),
    originFromUrl(discoveryState.bootstrapBaseUrl),
    originFromUrl(discoveryState.activeServiceUrl)
  ].filter(Boolean));
  return trustedOrigins.has(targetHost) && trustedOriginValues.has(targetOrigin);
}

export async function proxyApiRequest({
  request,
  response,
  requestBody,
  targetBaseUrl,
  discoveryState,
  logger = null
}) {
  const upstreamUrl = resolveProxyUpstreamUrl({ requestUrl: request.url || "/", targetBaseUrl });
  const startedAt = Date.now();
  logger?.info?.("http.proxy.started", {
    requestId: request.__licoRequestId || "",
    method: request.method || "GET",
    route: upstreamUrl.pathname,
    targetBaseUrl,
    serverId: discoveryState.serverId,
    activeServiceUrl: discoveryState.activeServiceUrl,
    bodyBytes: requestBody?.length || 0
  });
  const headers = new Headers();
  const allowedRequestHeaders = new Set([
    "accept",
    "authorization",
    "content-type",
    "cookie",
    "x-meshrix-csrf",
    "x-meshrix-safety-confirm",
    "x-meshrix-confirm",
    "x-meshrix-tool-token"
  ]);
  const credentialRequestHeaders = new Set([
    "authorization",
    "cookie",
    "x-meshrix-tool-token"
  ]);
  const forwardCredentials = proxyShouldForwardCredentials({
    targetBaseUrl,
    upstreamUrl: upstreamUrl.toString(),
    discoveryState
  });

  for (const [name, value] of Object.entries(request.headers || {})) {
    if (!value) {
      continue;
    }

    const lower = name.toLowerCase();
    if (!allowedRequestHeaders.has(lower)) {
      continue;
    }
    if (credentialRequestHeaders.has(lower) && !forwardCredentials) {
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

  headers.set("x-meshrix-forwarded-by", discoveryState.serverId);
  headers.set("x-meshrix-active-service", discoveryState.activeServiceUrl);
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("content-length", String(requestBody?.length || 0));
  }

  let upstream;
  try {
    upstream = await new Promise((resolve, reject) => {
      const client = upstreamUrl.protocol === "https:" ? https : http;
      const upstreamRequest = client.request(
        upstreamUrl,
        {
          method: request.method || "GET",
          headers: Object.fromEntries(headers.entries()),
          timeout: 30_000
        },
        (upstreamResponse) => {
          const MAX_PROXY_BYTES = 64 * 1024 * 1024;
          const chunks = [];
          let totalBytes = 0;
          let aborted = false;
          upstreamResponse.on("data", (chunk) => {
            if (aborted) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > MAX_PROXY_BYTES) {
              aborted = true;
              upstreamResponse.destroy();
              reject(new Error(
                `为保障系统最佳体验，上游响应体目前支持最大 ${MAX_PROXY_BYTES / 1024 / 1024} MB 的数据流转。`
              ));
              return;
            }
            chunks.push(buf);
          });
          upstreamResponse.on("end", () => {
            if (aborted) return;
            resolve({
              status: upstreamResponse.statusCode || 502,
              headers: upstreamResponse.headers,
              body: Buffer.concat(chunks)
            });
          });
        }
      );
      upstreamRequest.on("timeout", () => {
        upstreamRequest.destroy(new Error("上游服务请求超时。"));
      });
      upstreamRequest.on("error", reject);
      if (request.method !== "GET" && request.method !== "HEAD" && requestBody?.length) {
        upstreamRequest.write(requestBody);
      }
      upstreamRequest.end();
    });
  } catch (error) {
    logger?.error?.("http.proxy.failed", {
      requestId: request.__licoRequestId || "",
      method: request.method || "GET",
      route: upstreamUrl.pathname,
      targetBaseUrl,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error)
    });
    throw error;
  }
  const upstreamHeaders = {};
  const blockedResponseHeaders = new Set([
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  for (const [name, value] of Object.entries(upstream.headers || {})) {
    const lower = name.toLowerCase();
    if (blockedResponseHeaders.has(lower)) {
      continue;
    }

    upstreamHeaders[name] = value;
  }
  upstreamHeaders["x-meshrix-forwarded-by"] = discoveryState.serverId;
  upstreamHeaders["x-meshrix-active-service"] = discoveryState.activeServiceUrl;

  response.writeHead(upstream.status, upstreamHeaders);
  response.end(upstream.body);
  logger?.info?.("http.proxy.completed", {
    requestId: request.__licoRequestId || "",
    method: request.method || "GET",
    route: upstreamUrl.pathname,
    targetBaseUrl,
    statusCode: upstream.status,
    responseBytes: upstream.body?.length || 0,
    durationMs: Date.now() - startedAt
  });
}
