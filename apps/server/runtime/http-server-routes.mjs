import { randomBytes, randomUUID } from "node:crypto";
import { UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES } from "@lico/contracts/upstream-service-publishing";
import {
  createTraceContext,
  runWithTraceContext,
  setTraceContextOnRequest
} from "#lico/foundation/observability/trace-context";
import {
  handleLicoMcpHttpRequest,
  MCP_LOCAL_AUTHORIZATION_MAX_BODY_BYTES
} from "#lico/protocols/mcp/adapter/http-mcp-adapter";
import { inputFromRequest } from "#lico/server-runtime/composition/dispatch-operation";
import {
  createRequestBodyAdmissionController,
  readRequestBody,
  sendJson
} from "#lico/http-utils";
import {
  irreversibleSecurityDigest,
  summarizeError
} from "#lico/runtime-logger";
import { UPLOAD_SESSION_MAX_CHUNK_BYTES } from "#lico/server-runtime/state/upload-session-admission";
import {
  handleUpstreamPayloadTransitRequest,
  isUpstreamPayloadTransitRoute
} from "#lico/protocols/http/controllers/upstream-payload-transit-controller";
import { handleStaticFallback } from "./http-server-static-handlers.mjs";
import { handlePluginConsoleAssetRequest } from "./http-server-plugin-console-assets.mjs";
import {
  applySecurityHeaders,
  metricTransportForRoute,
  normalizeClientIp,
  numericHeader,
  resolveRequestSubjectKey,
  resolveRequestTenantKey,
  routeFromRequestUrl,
  sendRateLimitResponse,
  trackResponseBodyBytes
} from "./http-server-middleware.mjs";

export async function authorizeProxyRegisteredApiRequest({
  securityPermissions,
  request,
  operation,
  method,
  url,
  requestBody = Buffer.alloc(0),
  pathParams = {}
} = {}) {
  const input = inputFromRequest({
    operation,
    requestBody,
    url,
    params: pathParams,
    applyHttpQuery: true
  });
  if (operation?.public === true) {
    return { ok: true, input, authorization: { ok: true } };
  }
  if (!securityPermissions || typeof securityPermissions.authorizeOperation !== "function") {
    return {
      ok: false,
      input,
      authorization: {
        ok: false,
        status: 503,
        error: "操作授权器未注册。"
      }
    };
  }
  const authorization = await securityPermissions.authorizeOperation({
    request,
    operation,
    method,
    url,
    input
  });
  return {
    ok: authorization?.ok === true,
    input,
    authorization
  };
}

function requestBodyLimitForRoute(method, pathname) {
  if (
    ["POST", "PUT", "DELETE"].includes(method) &&
    /^\/api\/gateway\/v1\/services(?:\/[^/]+(?:\/(?:disable|republish))?)?$/u.test(pathname)
  ) {
    return UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES;
  }
  if (
    method === "PUT" &&
    /^\/api\/upload-sessions\/[^/]+\/files\/[^/]+$/.test(pathname)
  ) {
    return UPLOAD_SESSION_MAX_CHUNK_BYTES;
  }
  if (pathname === "/api/mcp/local-grant/requests") {
    return MCP_LOCAL_AUTHORIZATION_MAX_BODY_BYTES;
  }
  return undefined;
}

function isRoutineProbeNoise({ method, route, statusCode, completionStatus }) {
  return (method === "GET" || method === "HEAD") &&
    route === "/api/healthz" &&
    statusCode >= 200 &&
    statusCode < 500 &&
    completionStatus === "completed";
}

function completionLogLevel(statusCode, durationMs) {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  if (durationMs >= 1000) return "info";
  return "debug";
}

export function createHttpServerRequestHandler({
  activeApiOperations,
  getActiveApiOperations = () => activeApiOperations,
  consoleAuth,
  controllers,
  distPath,
  getDiscoveryState,
  getListenUrl,
  getOperationPermissionPlatform,
  lifecycle,
  loginRateLimiter,
  operationAuditStore,
  operationConcurrencyScope,
  pluginContributions,
  proxyApiRequest,
  rateLimits,
  registeredCoreProvider,
  runtimeLogger,
  securityPermissions,
  subjectRateLimiter,
  tenantRateLimiter,
  toolSkillManagementProvider,
  upstreamGatewayRegistryForMcp,
  ipRateLimiter,
  requestBodyAdmissionController = null
}) {
  const requestBodyAdmission = requestBodyAdmissionController ||
    createRequestBodyAdmissionController();
  const rateLimitLogState = new Map();
  const rateLimitLogWindowMs = Math.max(10_000, Number(rateLimits?.windowMs || 0) || 60_000);
  const logRateLimit = (details) => {
    const key = `${details.reason || "unknown"}\u0000${details.route || "/"}`;
    const now = Date.now();
    const previous = rateLimitLogState.get(key);
    if (previous && now - previous.loggedAt < rateLimitLogWindowMs) {
      previous.suppressed += 1;
      return;
    }
    runtimeLogger.warn("http.request.rate_limited", {
      ...details,
      suppressedSinceLastLog: previous?.suppressed || 0
    });
    if (!previous && rateLimitLogState.size >= 256) {
      rateLimitLogState.delete(rateLimitLogState.keys().next().value);
    }
    rateLimitLogState.delete(key);
    rateLimitLogState.set(key, { loggedAt: now, suppressed: 0 });
  };
  return async function handleHttpServerRequest(request, response) {
    const requestOperations = getActiveApiOperations();
    const requestAbortController = lifecycle.beginRequest();
    if (requestAbortController.signal.aborted) {
      response.statusCode = 503;
      response.end();
      return;
    }
    Object.defineProperty(request, "__licoActiveRequestCount", {
      configurable: false,
      enumerable: false,
      get: () => lifecycle.getInFlightCount()
    });
    try {
    lifecycle.markSocketActive(request.socket);
    const requestId = randomUUID();
    const startedAt = Date.now();
    const getResponseBytes = trackResponseBodyBytes(response);
    let requestBodyBytes = numericHeader(request.headers["content-length"]);

    const traceContext = createTraceContext({
      requestId,
      transport: "http",
      actor: { type: "http-request" }
    });
    setTraceContextOnRequest(request, traceContext);
    response.setHeader("X-LicoMesh-Trace-Id", traceContext.traceId);
    request.__licoRequestId = requestId;
    let finished = false;
    let requestMetricRecorded = false;
    const recordRequestMetric = (completionStatus = "completed") => {
      if (requestMetricRecorded) {
        return;
      }
      requestMetricRecorded = true;
      try {
        const route = routeFromRequestUrl(request.url || "/");
        const statusCode = response.statusCode || 0;
        if (isRoutineProbeNoise({
          method: request.method || "GET",
          route,
          statusCode,
          completionStatus
        })) {
          return;
        }
        getOperationPermissionPlatform()?.store?.appendHttpRequestMetric?.({
          traceId: traceContext.traceId,
          requestId,
          transport: metricTransportForRoute(route),
          method: request.method || "GET",
          route,
          statusCode,
          completionStatus,
          requestBytes: requestBodyBytes,
          responseBytes: getResponseBytes(),
          durationMs: Date.now() - startedAt,
          userAgent: request.headers["user-agent"]
            ? irreversibleSecurityDigest(request.headers["user-agent"], {
                namespace: "http-metric:user-agent"
              })
            : ""
        });
      } catch (error) {
        runtimeLogger.warn("http.request_metric.failed", {
          traceId: traceContext.traceId,
          requestId,
          error: summarizeError(error)
        });
      }
    };
    response.once("finish", () => {
      finished = true;
      const responseBytes = getResponseBytes();
      const method = request.method || "GET";
      const route = routeFromRequestUrl(request.url || "/");
      const statusCode = response.statusCode || 0;
      const durationMs = Date.now() - startedAt;
      const completionStatus = "completed";
      if (!isRoutineProbeNoise({ method, route, statusCode, completionStatus })) {
        const level = completionLogLevel(statusCode, durationMs);
        runtimeLogger[level]?.("http.request.completed", {
        traceId: traceContext.traceId,
        requestId,
        method,
        route,
        statusCode,
        requestBytes: requestBodyBytes,
        responseBytes,
        contentLength: response.getHeader("content-length") || "",
        durationMs
        });
      }
      recordRequestMetric(completionStatus);
    });
    response.once("close", () => {
      if (finished) {
        return;
      }
      if (!requestAbortController.signal.aborted) {
        requestAbortController.abort(new Error("HTTP request closed before completion."));
      }
      runtimeLogger.warn("http.request.closed", {
        traceId: traceContext.traceId,
        requestId,
        method: request.method || "GET",
        route: routeFromRequestUrl(request.url || "/"),
        statusCode: response.statusCode,
        requestBytes: requestBodyBytes,
        responseBytes: getResponseBytes(),
        durationMs: Date.now() - startedAt
      });
      recordRequestMetric("closed");
    });

      await runWithTraceContext(traceContext, async () => {
        try {
          const isHttps = Boolean(request.socket?.encrypted);
          const scriptNonce = randomBytes(16).toString("base64");
          applySecurityHeaders(response, { isHttps, scriptNonce });
          const method = request.method || "GET";
          const url = new URL(request.url || "/", "http://127.0.0.1");
          const isLoginRequest = method === "POST" && url.pathname === "/api/auth/login";
          if (url.pathname !== "/api/healthz") runtimeLogger.debug?.("http.request.started", {
            traceId: traceContext.traceId,
            requestId,
            method,
            route: url.pathname,
            query: {
              type: "query",
              count: url.searchParams.size,
              hash: irreversibleSecurityDigest([...url.searchParams.entries()], {
                namespace: "http-request:query"
              })
            },
            remoteAddress: request.socket?.remoteAddress
              ? irreversibleSecurityDigest(request.socket.remoteAddress, {
                  namespace: "http-request:remote-address"
                })
              : "",
            userAgent: request.headers["user-agent"]
              ? irreversibleSecurityDigest(request.headers["user-agent"], {
                  namespace: "http-request:user-agent"
                })
              : "",
            contentType: request.headers["content-type"] || "",
            contentLength: request.headers["content-length"] || ""
          });
          let requestBody = Buffer.alloc(0);

          const clientIp = normalizeClientIp(request);
          const ipRateLimit = ipRateLimiter.shouldAllow(`ip:${clientIp}`);
          if (!ipRateLimit.allowed) {
            logRateLimit({
              reason: "ip",
              requestId,
              actor: "anonymous",
              route: url.pathname,
              limit: ipRateLimit.limit,
              retryAfterSec: ipRateLimit.retryAfterSec
            });
            sendRateLimitResponse(response, {
              reason: "访问频率过高（IP 限流）。",
              limit: ipRateLimit.limit,
              resetAt: ipRateLimit.resetAt,
              retryAfterSec: ipRateLimit.retryAfterSec,
              windowMs: rateLimits.windowMs
            });
            return;
          }

          if (isLoginRequest) {
            const loginRateLimit = loginRateLimiter.shouldAllow(`login-ip:${clientIp}`);
            if (!loginRateLimit.allowed) {
              logRateLimit({
                reason: "login",
                requestId,
                route: url.pathname,
                limit: loginRateLimit.limit,
                retryAfterSec: loginRateLimit.retryAfterSec
              });
              sendRateLimitResponse(response, {
                reason: "登录尝试过于频繁（登录限流）。",
                limit: loginRateLimit.limit,
                resetAt: loginRateLimit.resetAt,
                retryAfterSec: loginRateLimit.retryAfterSec,
                windowMs: rateLimits.windowMs
              });
              return;
            }
          }

          const subjectKey = resolveRequestSubjectKey(request, consoleAuth);
          const subjectRateLimit = subjectRateLimiter.shouldAllow(subjectKey);
          if (!subjectRateLimit.allowed) {
            logRateLimit({
              reason: "subject",
              requestId,
              route: url.pathname,
              limit: subjectRateLimit.limit,
              retryAfterSec: subjectRateLimit.retryAfterSec
            });
            sendRateLimitResponse(response, {
              reason: "访问频率过高（主体限流）。",
              limit: subjectRateLimit.limit,
              resetAt: subjectRateLimit.resetAt,
              retryAfterSec: subjectRateLimit.retryAfterSec,
              windowMs: rateLimits.windowMs
            });
            return;
          }

          const tenantKey = resolveRequestTenantKey(request, consoleAuth);
          const tenantRateLimit = tenantRateLimiter.shouldAllow(tenantKey);
          if (!tenantRateLimit.allowed) {
            logRateLimit({
              reason: "tenant",
              requestId,
              route: url.pathname,
              limit: tenantRateLimit.limit,
              retryAfterSec: tenantRateLimit.retryAfterSec
            });
            sendRateLimitResponse(response, {
              reason: "租户访问频率过高，请稍后重试。",
              limit: tenantRateLimit.limit,
              resetAt: tenantRateLimit.resetAt,
              retryAfterSec: tenantRateLimit.retryAfterSec,
              windowMs: rateLimits.windowMs
            });
            return;
          }

          if (isUpstreamPayloadTransitRoute(method, url.pathname) && await handleUpstreamPayloadTransitRequest({
            request,
            response,
            method,
            url,
            operations: requestOperations,
            securityPermissions,
            toolSkillManagementProvider,
            upstreamGatewayRegistry: upstreamGatewayRegistryForMcp,
            signal: requestAbortController.signal,
            onRequestBytes: (value) => {
              requestBodyBytes = Number(value || 0);
            }
          })) {
            return;
          }

          requestBody =
            method === "GET" || method === "HEAD"
              ? Buffer.alloc(0)
              : await readRequestBody(request, {
                  admissionController: requestBodyAdmission,
                  contentLength: requestBodyBytes,
                  maxBytes: requestBodyLimitForRoute(method, url.pathname),
                  tenantKey,
                  subjectKey
                });
          requestBodyBytes = requestBody.length;

          if (await handlePluginConsoleAssetRequest({
            request,
            response,
            method,
            url,
            consoleAuth,
            pluginContributions
          })) {
            return;
          }

          const discoveryState = getDiscoveryState();
          if (
            await handleLicoMcpHttpRequest({
              request,
              response,
              requestBody,
              method,
              url,
              toolSkillManagementProvider,
              upstreamGatewayRegistry: upstreamGatewayRegistryForMcp,
              listenUrl: getListenUrl(),
              discoveryState,
              logger: runtimeLogger,
              signal: requestAbortController.signal
            })
          ) {
            return;
          }

          if (method === "POST" && url.pathname === "/api/rpc") {
            await registeredCoreProvider.dispatchRpcOperation({
              operations: requestOperations,
              controllers,
              request,
              response,
              requestBody,
              authorizeOperation: (input) => securityPermissions.authorizeOperation(input),
              verifyProcessIdentity: (input) => securityPermissions.verifyProcessIdentity(input),
              operationAuditStore,
              concurrencyScope: operationConcurrencyScope,
              signal: requestAbortController.signal,
              logger: runtimeLogger
            });
            return;
          }

          const proxyDecision = registeredCoreProvider.findProxyRegisteredApiRequest({
            method,
            pathname: url.pathname,
            discoveryState,
            operations: requestOperations
          });
          if (proxyDecision) {
            const proxyOperation = proxyDecision.operation;
            const proxyAuthorization = await authorizeProxyRegisteredApiRequest({
              securityPermissions,
              request,
              operation: proxyOperation,
              method,
              url,
              requestBody,
              pathParams: proxyDecision.pathParams || {}
            });
            if (!proxyAuthorization.ok) {
              const authorization = proxyAuthorization.authorization || {};
              runtimeLogger.warn("http.proxy.denied", {
                traceId: traceContext.traceId,
                requestId,
                operationId: proxyOperation.id,
                method,
                route: url.pathname,
                status: authorization.status || 403
              });
              sendJson(response, authorization.status || 403, {
                error: authorization.error || "权限不足。",
                bootstrap: authorization.bootstrap,
                traceId: traceContext.traceId
              });
              return;
            }
            await proxyApiRequest({
              request,
              response,
              requestBody,
              targetBaseUrl: proxyDecision.targetBaseUrl,
              discoveryState,
              logger: runtimeLogger
            });
            return;
          }

          const handled = await registeredCoreProvider.dispatchRegisteredHttpOperation({
            operations: requestOperations,
            controllers,
            method,
            url,
            request,
            response,
            requestBody,
            authorizeOperation: (input) => securityPermissions.authorizeOperation(input),
            verifyProcessIdentity: (input) => securityPermissions.verifyProcessIdentity(input),
            operationAuditStore,
            concurrencyScope: operationConcurrencyScope,
            signal: requestAbortController.signal,
            logger: runtimeLogger
          });
          if (handled) {
            return;
          }

          await handleStaticFallback({
            url,
            response,
            distPath,
            discoveryState,
            scriptNonce
          });
        } catch (error) {
          const statusCode = typeof error?.statusCode === "number" ? error.statusCode : 500;
          runtimeLogger.error("http.request.failed", {
            traceId: traceContext.traceId,
            requestId,
            method: request.method || "GET",
            route: (() => {
              try {
                return new URL(request.url || "/", "http://127.0.0.1").pathname;
              } catch {
                return request.url || "/";
              }
            })(),
            statusCode,
            durationMs: Date.now() - startedAt,
            error: summarizeError(error)
          });
          if (!response.headersSent) {
            sendJson(response, statusCode, {
              error: statusCode >= 500 ? "服务器处理请求失败。" : "请求处理失败。",
              traceId: traceContext.traceId
            });
          }
        }
      });
    } finally {
      lifecycle.markSocketIdle(request.socket);
      lifecycle.endRequest(requestAbortController);
    }
  };
}
