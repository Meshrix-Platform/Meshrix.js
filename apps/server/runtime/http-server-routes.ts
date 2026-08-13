import { randomBytes, randomUUID } from "node:crypto";
import { UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES } from "@meshrix/contracts/upstream-service-publishing";
import {
  createTraceContext,
  runWithTraceContext,
  setTraceContextOnRequest
} from "#meshrix/foundation/observability/trace-context";
import { handleMeshrixMcpHttpRequest } from "#meshrix/protocols/mcp/adapter/http-mcp-adapter";
import { inputFromRequest } from "#meshrix/server-runtime/composition/dispatch-operation";
import {
  createRequestBodyAdmissionController,
  readRequestBody,
  sendJson
} from "#meshrix/http-utils";
import {
  irreversibleSecurityDigest,
  summarizeError
} from "#meshrix/runtime-logger";
import { UPLOAD_SESSION_MAX_CHUNK_BYTES } from "#meshrix/server-runtime/state/upload-session-admission";
import { apiKeyUploadAuthSession } from "../../../packages/protocols/http/controllers/jobs-controller-access.ts";
import {
  handleUpstreamPayloadTransitRequest,
  isUpstreamPayloadTransitRoute
} from "#meshrix/protocols/http/controllers/upstream-payload-transit-controller";
import { handleStaticFallback } from "./http-server-static-handlers.ts";
import { handlePluginConsoleAssetRequest } from "./http-server-plugin-console-assets.ts";
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
} from "./http-server-middleware.ts";

export async function authorizeProxyRegisteredApiRequest({
  securityPermissions,
  request,
  operation,
  method,
  url,
  requestBody = Buffer.alloc(0),
  pathParams = {}
}: Record<string, any> = {}) : Promise<any> {
  const input: any = inputFromRequest({
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
  const authorization: any = await securityPermissions.authorizeOperation({
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

function requestBodyLimitForRoute(method?: any, pathname?: any) : any {
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
  return undefined;
}

export function apiKeyUploadOperation(method: any = "GET", pathname: any = "") : any {
  if (method === "POST" && pathname === "/api/upload-sessions") {
    return Object.freeze({ id: "uploads.create_session", requiredScopes: Object.freeze(["uploads:write"]) });
  }
  if (method === "GET" && /^\/api\/upload-sessions\/[^/]+$/u.test(pathname)) {
    return Object.freeze({ id: "uploads.get_session", requiredScopes: Object.freeze(["uploads:write"]) });
  }
  if (method === "PUT" && /^\/api\/upload-sessions\/[^/]+\/files\/[^/]+$/u.test(pathname)) {
    return Object.freeze({ id: "uploads.upload_chunk", requiredScopes: Object.freeze(["uploads:write"]) });
  }
  return null;
}

function apiKeyUploadAuthorizationValid(authorization: any, operation: any) : any {
  const context: any = authorization?.apiKeyAuthorization;
  const scopes: any[] = Array.isArray(context?.policy?.scopeIds) ? context.policy.scopeIds : [];
  const allowedTools: any[] = Array.isArray(context?.policy?.allowedTools) ? context.policy.allowedTools : [];
  return authorization?.handled === true &&
    authorization?.ok === true &&
    context?.credentialKind === "scoped_api_key" &&
    operation.requiredScopes.every((scope?: any) : any => scopes.includes(scope)) &&
    allowedTools.includes(operation.id);
}

export async function authorizeApiKeyUpload({
  request,
  requestBody,
  url,
  method,
  operation,
  toolSkillManagementProvider
}: Record<string, any>) : Promise<any> {
  const authorization: any = await toolSkillManagementProvider.authorizeRequest({
    request,
    requiredScopes: operation.requiredScopes,
    recordUse: false,
    requestBody,
    url,
    method
  });
  if (authorization?.handled !== true) return null;
  if (!apiKeyUploadAuthorizationValid(authorization, operation)) {
    return Object.freeze({
      ok: false,
      status: authorization?.ok === true ? 403 : Number(authorization?.status || 401),
      reasonCode: authorization?.ok === true ? "api_key_operation_denied" : String(authorization?.reasonCode || "api_key_invalid"),
      error: authorization?.ok === true ? "API key does not authorize this upload operation." : String(authorization?.error || "API key authorization failed.")
    });
  }
  const authSession: any = apiKeyUploadAuthSession(authorization.apiKeyAuthorization);
  if (!authSession) {
    return Object.freeze({ ok: false, status: 503, reasonCode: "api_key_authority_unavailable", error: "API key authorization context is unavailable." });
  }
  const initial: any = authorization.apiKeyAuthorization;
  const actor: any = authSession.user;
  return Object.freeze({
    ok: true,
    status: 200,
    reasonCode: "api_key_upload_authorized",
    credentialKind: "scoped_api_key",
    apiKeyAuthorization: initial,
    actor,
    authSession,
    revalidateAuthorization: async () : Promise<any> => {
      const current: any = await toolSkillManagementProvider.revalidateApiKeyAuthorization?.(initial);
      const next: any = current?.apiKeyAuthorization;
      if (current?.ok !== true ||
        next?.keyId !== initial.keyId ||
        next?.workloadPrincipalId !== initial.workloadPrincipalId ||
        next?.organizationNodeId !== initial.organizationNodeId ||
        next?.lifecycleRevision !== initial.lifecycleRevision ||
        next?.policyFingerprint !== initial.policyFingerprint) {
        return Object.freeze({
          ok: false,
          status: Number(current?.status || 403),
          reasonCode: String(current?.reasonCode || "api_key_revision_stale"),
          error: "API key authorization changed before the upload effect."
        });
      }
      return Object.freeze({ ok: true, actor, authSession });
    }
  });
}

function controllersForApiKeyUpload(controllers: any, authorization: any) : any {
  if (!authorization?.ok || !controllers?.system) return controllers;
  return Object.freeze({
    ...controllers,
    system: Object.freeze({
      ...controllers.system,
      verifyConsoleOrToolSkillExternalAuth: async () : Promise<any> => authorization
    })
  });
}

function isRoutineProbeNoise({ method, route, statusCode, completionStatus }: Record<string, any>) : any {
  return (method === "GET" || method === "HEAD") &&
    route === "/api/healthz" &&
    statusCode >= 200 &&
    statusCode < 500 &&
    completionStatus === "completed";
}

function completionLogLevel(statusCode?: any, durationMs?: any) : any {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  if (durationMs >= 1000) return "info";
  return "debug";
}

export function createHttpServerRequestHandler({
  activeApiOperations,
  getActiveApiOperations = () : any => activeApiOperations,
  consoleAuth,
  controllers,
  distPath,
  getDiscoveryState,
  getListenUrl,
  getOperationPermissionPlatform,
  ingressContract = null,
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
}: Record<string, any>) : any {
  const requestBodyAdmission: any = requestBodyAdmissionController ||
    createRequestBodyAdmissionController();
  const rateLimitLogState: any = new Map<any, any>();
  const rateLimitLogWindowMs: any = Math.max(10_000, Number(rateLimits?.windowMs || 0) || 60_000);
  const logRateLimit: any = (details?: any) : any => {
    const key: any = `${details.reason || "unknown"}\u0000${details.route || "/"}`;
    const now: any = Date.now();
    const previous: any = rateLimitLogState.get(key);
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
  return async function handleHttpServerRequest(request?: any, response?: any) : Promise<any> {
    const requestOperations: any = getActiveApiOperations();
    let admissionUrl: any = null;
    try {
      admissionUrl = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      admissionUrl = null;
    }
    const admissionMethod: any = String(request.method || "GET").toUpperCase();
    const admissionIsLight: any = ["GET", "HEAD", "OPTIONS"].includes(admissionMethod);
    const admissionIsUpload: any = admissionMethod === "PUT" && /^\/api\/upload-sessions\//u.test(admissionUrl?.pathname || "");
    const requestAbortController: any = lifecycle.beginRequest({
      workloadClass: admissionIsLight ? "light" : admissionIsUpload ? "stream" : "standard",
      cost: admissionIsLight ? 1 : admissionIsUpload ? 4 : 2
    });
    if (requestAbortController.signal.aborted) {
      response.statusCode = requestAbortController.signal.reason?.statusCode || 503;
      response.end();
      return;
    }
    let requestBodyAdmissionLease: any = null;
    Object.defineProperty(request, "__meshrixActiveRequestCount", {
      configurable: false,
      enumerable: false,
      get: () : any => lifecycle.getInFlightCount()
    });
    try {
    lifecycle.markSocketActive(request.socket);
    const ingressAdmission: any = ingressContract?.admit?.(request) || { ok: true };
    if (ingressAdmission.ok !== true) {
      sendJson(response, ingressAdmission.status || 403, {
        error: {
          code: ingressAdmission.code || "production_ingress_rejected"
        }
      });
      return;
    }
    const requestId: any = randomUUID();
    const startedAt: any = Date.now();
    const getResponseBytes: any = trackResponseBodyBytes(response);
    let requestBodyBytes: any = numericHeader(request.headers["content-length"]);

    const traceContext: any = createTraceContext({
      requestId,
      transport: "http",
      actor: { type: "http-request" }
    });
    setTraceContextOnRequest(request, traceContext);
    response.setHeader("X-Meshrix.js-Trace-Id", traceContext.traceId);
    request.__meshrixRequestId = requestId;
    let finished: any = false;
    let requestMetricRecorded: any = false;
    const recordRequestMetric: any = (completionStatus: any = "completed") : any => {
      if (requestMetricRecorded) {
        return;
      }
      requestMetricRecorded = true;
      try {
        const route: any = routeFromRequestUrl(request.url || "/");
        const statusCode: any = response.statusCode || 0;
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
      } catch (error: any) {
        runtimeLogger.warn("http.request_metric.failed", {
          traceId: traceContext.traceId,
          requestId,
          error: summarizeError(error)
        });
      }
    };
    response.once("finish", () : any => {
      finished = true;
      const responseBytes: any = getResponseBytes();
      const method: any = request.method || "GET";
      const route: any = routeFromRequestUrl(request.url || "/");
      const statusCode: any = response.statusCode || 0;
      const durationMs: any = Date.now() - startedAt;
      const completionStatus: any = "completed";
      if (!isRoutineProbeNoise({ method, route, statusCode, completionStatus })) {
        const level: any = completionLogLevel(statusCode, durationMs);
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
    response.once("close", () : any => {
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

      await runWithTraceContext(traceContext, async () : Promise<any> => {
        try {
          const isHttps: any = Boolean(request.socket?.encrypted);
          const scriptNonce: any = randomBytes(16).toString("base64");
          applySecurityHeaders(response, { isHttps, scriptNonce });
          const method: any = request.method || "GET";
          const url: any = new URL(request.url || "/", "http://127.0.0.1");
          const isLoginRequest: any = method === "POST" && url.pathname === "/api/auth/login";
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
          let requestBody: any = Buffer.alloc(0);

          const clientIp: any = normalizeClientIp(request);
          const ipRateLimit: any = ipRateLimiter.shouldAllow(`ip:${clientIp}`);
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
            const loginRateLimit: any = loginRateLimiter.shouldAllow(`login-ip:${clientIp}`);
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

          const subjectKey: any = resolveRequestSubjectKey(request, consoleAuth);
          const subjectRateLimit: any = subjectRateLimiter.shouldAllow(subjectKey);
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

          const tenantKey: any = resolveRequestTenantKey(request, consoleAuth);
          const tenantRateLimit: any = tenantRateLimiter.shouldAllow(tenantKey);
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
            onRequestBytes: (value?: any) : any => {
              requestBodyBytes = Number(value || 0);
            }
          })) {
            return;
          }

          if (method === "GET" || method === "HEAD") {
            requestBody = Buffer.alloc(0);
          } else {
            const maxBytes: any = requestBodyLimitForRoute(method, url.pathname);
            const binaryBody: any = method === "PUT" && /^\/api\/upload-sessions\/[^/]+\/files\/[^/]+$/u.test(url.pathname);
            if (Number.isSafeInteger(maxBytes) && maxBytes > 0 && requestBodyBytes > maxBytes) {
              throw Object.assign(new Error("HTTP request body exceeds the route limit."), {
                code: "request_body_too_large",
                statusCode: 413
              });
            }
            requestBodyAdmissionLease = requestBodyAdmission.acquire({
              tenantKey,
              subjectKey,
              contentLength: requestBodyBytes,
              retainedMultiplier: binaryBody ? 2 : 3
            });
            requestBody = await readRequestBody(request, {
              admissionController: requestBodyAdmission,
              admissionLease: requestBodyAdmissionLease,
              contentLength: requestBodyBytes,
              maxBytes,
              tenantKey,
              subjectKey
            });
          }
          requestBodyBytes = requestBody.length;

          const uploadOperation: any = apiKeyUploadOperation(method, url.pathname);
          const apiKeyUploadAuthorization: any = uploadOperation
            ? await authorizeApiKeyUpload({
                request,
                requestBody,
                url,
                method,
                operation: uploadOperation,
                toolSkillManagementProvider
              })
            : null;
          if (apiKeyUploadAuthorization?.ok === false) {
            sendJson(response, apiKeyUploadAuthorization.status || 403, {
              error: {
                code: apiKeyUploadAuthorization.reasonCode,
                message: apiKeyUploadAuthorization.error
              }
            });
            return;
          }

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

          const discoveryState: any = getDiscoveryState();
          if (
            await handleMeshrixMcpHttpRequest({
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
              authorizeOperation: (input?: any) : any => securityPermissions.authorizeOperation(input),
              verifyProcessIdentity: (input?: any) : any => securityPermissions.verifyProcessIdentity(input),
              operationAuditStore,
              concurrencyScope: operationConcurrencyScope,
              signal: requestAbortController.signal,
              logger: runtimeLogger
            });
            return;
          }

          const proxyDecision: any = registeredCoreProvider.findProxyRegisteredApiRequest({
            method,
            pathname: url.pathname,
            discoveryState,
            operations: requestOperations
          });
          if (proxyDecision) {
            const proxyOperation: any = proxyDecision.operation;
            const proxyAuthorization: any = await authorizeProxyRegisteredApiRequest({
              securityPermissions,
              request,
              operation: proxyOperation,
              method,
              url,
              requestBody,
              pathParams: proxyDecision.pathParams || {}
            });
            if (!proxyAuthorization.ok) {
              const authorization: any = proxyAuthorization.authorization || {};
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
              logger: runtimeLogger
            });
            return;
          }

          const handled: any = await registeredCoreProvider.dispatchRegisteredHttpOperation({
            operations: requestOperations,
            controllers: controllersForApiKeyUpload(controllers, apiKeyUploadAuthorization),
            method,
            url,
            request,
            response,
            requestBody,
            authorizeOperation: (input?: any) : any => securityPermissions.authorizeOperation(input),
            verifyProcessIdentity: (input?: any) : any => securityPermissions.verifyProcessIdentity(input),
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
        } catch (error: any) {
          const statusCode: any = typeof error?.statusCode === "number" ? error.statusCode : 500;
          runtimeLogger.error("http.request.failed", {
            traceId: traceContext.traceId,
            requestId,
            method: request.method || "GET",
            route: (() : any => {
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
      requestBodyAdmissionLease?.release();
      lifecycle.markSocketIdle(request.socket);
      lifecycle.endRequest(requestAbortController);
    }
  };
}
