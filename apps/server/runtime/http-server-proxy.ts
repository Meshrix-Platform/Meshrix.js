import http from "node:http";
import https from "node:https";
import { summarizeError } from "#meshrix/runtime-logger";

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
  try {
    upstream = await new Promise((resolve?: any, reject?: any) : any => {
      const client: any = upstreamUrl.protocol === "https:" ? https : http;
      const upstreamRequest: any = client.request(
        upstreamUrl,
        {
          method: request.method || "GET",
          headers: Object.fromEntries(headers.entries()),
          timeout: 30_000
        },
        (upstreamResponse?: any) : any => {
          const MAX_PROXY_BYTES: any = 64 * 1024 * 1024;
          const chunks: any[] = [];
          let totalBytes: any = 0;
          let aborted: any = false;
          upstreamResponse.on("data", (chunk?: any) : any => {
            if (aborted) return;
            const buf: any = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
          upstreamResponse.on("end", () : any => {
            if (aborted) return;
            resolve({
              status: upstreamResponse.statusCode || 502,
              headers: upstreamResponse.headers,
              body: Buffer.concat(chunks)
            });
          });
        }
      );
      upstreamRequest.on("timeout", () : any => {
        upstreamRequest.destroy(new Error("上游服务请求超时。"));
      });
      upstreamRequest.on("error", reject);
      if (request.method !== "GET" && request.method !== "HEAD" && requestBody?.length) {
        upstreamRequest.write(requestBody);
      }
      upstreamRequest.end();
    });
  } catch (error: any) {
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
  response.writeHead(upstream.status, upstreamHeaders);
  response.end(upstream.body);
  logger?.info?.("http.proxy.completed", {
    requestId: request.__meshrixRequestId || "",
    method: request.method || "GET",
    route: upstreamUrl.pathname,
    statusCode: upstream.status,
    responseBytes: upstream.body?.length || 0,
    durationMs: Date.now() - startedAt
  });
}
