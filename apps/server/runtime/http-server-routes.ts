import { randomBytes, randomUUID } from "node:crypto";
import { UPSTREAM_PUBLISHING_MAX_COMMAND_BYTES } from "@meshrix/contracts/upstream-service-publishing";
import {
  createTraceContext,
  runWithTraceContext,
  setTraceContextOnRequest
} from "#meshrix/foundation/observability/trace-context";
import {
  buildMeshrixMcpDiscovery,
  mcpHandshake
} from "@meshrix/protocols/mcp/modern-downstream/discovery";
import {
  MCP_PROTOCOL_VERSION,
  evaluateMcpProtocolContract,
  mcpSubscriptionAckNotification,
  mcpSubscriptionIdFromRequest,
  parseMcpSubscriptionNotifications
} from "@meshrix/protocols/mcp/modern-downstream/protocol";
import { jsonRpcResult } from "@meshrix/protocols/mcp/modern-downstream/response";
import {
  acknowledgeConfiguredMcpCatalogConvergence,
  registerConfiguredMcpSubscription
} from "@meshrix/protocols/mcp/notifications";
import {
  MCP_CATALOG_ACKNOWLEDGE_METHOD,
  MCP_PROXY_SESSION_HEADER_LOWER,
  normalizeMcpProxySessionId,
  parseMcpCatalogAcknowledgement
} from "@meshrix/contracts/mcp-catalog-delivery";
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
import { handlePluginConsoleRequest } from "./http-server-plugin-console-sandbox.ts";
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

function classifiedRequestFailureReason(error?: any) : string {
  const existing = String(error?.reasonCode || error?.code || "").trim();
  if (/^[a-z0-9][a-z0-9._:-]*$/iu.test(existing)) return existing;
  const stack = String(error?.stack || "");
  const message = String(error?.message || "");
  if (/^[a-z0-9][a-z0-9_:-]*$/u.test(message)) {
    return message;
  }
  const origin = [
    ["upstream-gateway", "upstream_gateway"],
    ["universal-tag-policy", "tag_policy"],
    ["tag-management", "tag_management"],
    ["security-permissions-provider", "security_permissions"],
    ["authorization-engine", "authorization_engine"],
    ["operation-permission", "operation_permission"],
  ].find(([needle]) => stack.includes(needle))?.[1] || "request";
  const kind = error instanceof TypeError
    ? /is not a function/iu.test(message)
      ? "function_missing"
      : /Cannot read properties|undefined|null/iu.test(message)
        ? "property_missing"
        : "type_error"
    : /SQLITE|database/iu.test(message)
      ? "storage_error"
      : "runtime_error";
  return `${origin}_${kind}`;
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

function normalizedMcpOriginHost(value?: any) : any {
  const host: any = String(value || "").trim().toLowerCase();
  return host === "::1" || host === "[::1]" ? "localhost" : host.split(":")[0];
}

function isAllowedPlatformMcpOrigin(request?: any) : any {
  const origin: any = String(request?.headers?.origin || "").trim();
  if (!origin) return true;
  try {
    const parsed: any = new URL(origin);
    return new Set<any>(["localhost", "127.0.0.1", "host.orb.internal"])
      .has(normalizedMcpOriginHost(parsed.hostname));
  } catch {
    return false;
  }
}

function parseMcpRequestBody(requestBody?: any) : any {
  return JSON.parse(Buffer.from(requestBody || []).toString("utf8"));
}

function platformMcpSseFrame(payload?: any) : any {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The SSE connection state module keys cancellation, convergence and fencing on
 * the identity the operation-permission plane retires grants by, so a revoked
 * credential disconnects its live subscriptions.
 */
function platformMcpGrantId(authorization?: any) : any {
  if (authorization?.credentialKind === "scoped_api_key") {
    return String(
      authorization?.workloadPrincipalId ||
      authorization?.apiKeyAuthorization?.workloadPrincipalId ||
      authorization?.subject?.subjectId ||
      authorization?.apiKeyAuthorization?.subject?.subjectId ||
      ""
    );
  }
  return String(authorization?.grant?.id || "");
}

/**
 * A `subscriptions/listen` POST is answered as one SSE stream: the
 * acknowledgement frame is written above the adapter's authorized event
 * iterable, so the adapter keeps owning per-delivery re-authorization and the
 * frame byte budget while the connection keeps its partition scope and its
 * convergence deadline. When the client goes away, the response is closed and
 * the adapter's subscription is released.
 */
async function openPlatformMcpSubscriptionStream({
  request,
  response,
  requestBody,
  url,
  method,
  payload,
  result,
  toolSkillManagementProvider
}: Record<string, any>) : Promise<any> {
  const closeAdapter: any = () : any => {
    try {
      result.close?.();
    } catch {
      // The adapter subscription is already released.
    }
  };
  const parsedNotifications: any = parseMcpSubscriptionNotifications(payload?.params || {});
  const subscriptionId: any = mcpSubscriptionIdFromRequest(payload);
  const authorization: any = await toolSkillManagementProvider.authorizeMcpClientRequest({
    request,
    requiredScopes: [],
    recordUse: false,
    requestBody,
    url: url || new URL("/mcp", "http://127.0.0.1"),
    method
  });
  const partitionKeys: any = authorization?.ok === true &&
    typeof toolSkillManagementProvider.audiencePartitionKeys === "function"
    ? toolSkillManagementProvider.audiencePartitionKeys({ authorization })
    : [];
  const registration: any = registerConfiguredMcpSubscription({
    request,
    response,
    grantId: platformMcpGrantId(authorization),
    grant: authorization?.grant || null,
    privateOnly: true,
    partitionKeys,
    negotiatedCapabilities: parsedNotifications.ok ? parsedNotifications.methods : [],
    subscriptionId,
    proxySessionId: normalizeMcpProxySessionId(
      request?.headers?.[MCP_PROXY_SESSION_HEADER_LOWER]
    )
  });
  if (!registration?.ok || typeof registration.write !== "function") {
    closeAdapter();
    sendJson(response, registration?.status || 503, {
      jsonrpc: "2.0",
      id: payload?.id ?? null,
      error: {
        code: -32004,
        message: "MCP subscription capacity is unavailable.",
        data: {
          code: registration?.code || "mcp_subscription_registration_unavailable"
        }
      }
    });
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION
  });
  if (!registration.write(platformMcpSseFrame(mcpSubscriptionAckNotification({
    subscriptionId,
    notifications: parsedNotifications.ok ? parsedNotifications.notifications : {}
  })))) {
    registration.close?.();
    closeAdapter();
    return;
  }
  const scopedPartitionKeys: any = new Set<any>(
    (Array.isArray(partitionKeys) ? partitionKeys : [])
      .map((key?: any) : any => String(key || "").trim())
      .filter(Boolean)
  );
  let released: any = false;
  const releaseAdapter: any = () : any => {
    if (released) return;
    released = true;
    closeAdapter();
  };
  const onClientGone: any = () : any => {
    releaseAdapter();
    registration.close?.();
  };
  request?.once?.("close", onClientGone);
  response?.once?.("close", onClientGone);
  try {
    for await (const event of result.stream) {
      if (released) break;
      if (!event || typeof event !== "object") continue;
      const changedPartitions: any = Array.isArray(event?.params?.change?.affectedPartitions)
        ? event.params.change.affectedPartitions
            .map((key?: any) : any => String(key || "").trim())
            .filter(Boolean)
        : [];
      // A partition-scoped catalog change only reaches the audiences that
      // published it, and it names only their own partitions: the connection's
      // keys are that scope, exactly as they are for the notification bus.
      const scopedChangedPartitions: any = changedPartitions
        .filter((key?: any) : any => scopedPartitionKeys.has(key));
      if (changedPartitions.length > 0 && scopedChangedPartitions.length === 0) continue;
      const frame: any = changedPartitions.length > 0
        ? {
            ...event,
            params: {
              ...event.params,
              change: { ...event.params.change, affectedPartitions: scopedChangedPartitions }
            }
          }
        : event;
      if (!registration.write(platformMcpSseFrame(frame))) break;
    }
  } catch {
    // A broken downstream socket is a client disconnect, not an upstream fault.
  } finally {
    // The adapter subscription can end on its own when per-delivery
    // re-authorization revokes this caller. The SSE connection outlives it so
    // the client still converges on the catalog revision it was sent and can
    // acknowledge it; the connection itself is closed by the subscription
    // timeout, by revocation, or when the client goes away.
    releaseAdapter();
  }
}

async function handlePlatformMcpCatalogAcknowledgement({
  request,
  response,
  requestBody,
  url,
  method,
  payload,
  toolSkillManagementProvider
}: Record<string, any>) : Promise<any> {
  const protocol: any = evaluateMcpProtocolContract({ request, message: payload });
  if (!protocol.ok) {
    sendJson(response, protocol.httpStatus || 400, protocol.body);
    return true;
  }
  const authorization: any = await toolSkillManagementProvider.authorizeMcpClientRequest({
    request,
    requiredScopes: [],
    recordUse: false,
    requestBody,
    url,
    method
  });
  if (authorization?.ok !== true) {
    sendJson(response, authorization?.status || 401, {
      jsonrpc: "2.0",
      id: payload?.id ?? null,
      error: {
        code: -32001,
        message: "Catalog convergence acknowledgement requires authorization.",
        data: { code: "catalog_convergence_acknowledgement_unauthorized" }
      }
    });
    return true;
  }
  const { _meta: _acknowledgementMeta, ...acknowledgementParams } = payload?.params || {};
  const facts: any = parseMcpCatalogAcknowledgement(acknowledgementParams);
  if (!facts) {
    sendJson(response, 400, {
      jsonrpc: "2.0",
      id: payload?.id ?? null,
      error: {
        code: -32602,
        message: "Catalog convergence acknowledgement is invalid.",
        data: { code: "catalog_convergence_acknowledgement_invalid" }
      }
    });
    return true;
  }
  sendJson(response, 200, jsonRpcResult(payload?.id ?? null, acknowledgeConfiguredMcpCatalogConvergence({
    grantId: platformMcpGrantId(authorization),
    proxySessionId: normalizeMcpProxySessionId(
      request?.headers?.[MCP_PROXY_SESSION_HEADER_LOWER]
    ),
    sourceRevision: facts.sourceRevision,
    catalogRevision: facts.catalogRevision,
    audienceRevision: facts.audienceRevision,
    partitionKeys: facts.partitionKeys
  })));
  return true;
}

async function sendPlatformMcpAdapterResponse({
  request,
  response,
  requestBody,
  url,
  method,
  payload,
  result,
  toolSkillManagementProvider
}: Record<string, any>) : Promise<any> {
  if (result?.stream && typeof result.stream[Symbol.asyncIterator] === "function") {
    await openPlatformMcpSubscriptionStream({
      request,
      response,
      requestBody,
      url,
      method,
      payload,
      result,
      toolSkillManagementProvider
    });
    return;
  }
  const status: any = Number.isInteger(result?.status) ? result.status : 502;
  const headers: Record<string, any> = {
    "Cache-Control": "no-store"
  };
  for (const [key, value] of Object.entries(result?.headers || {})) {
    if (value !== undefined && value !== null) headers[key] = String(value);
  }
  if (result?.body === undefined) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(JSON.stringify(result.body));
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
  operationLockManager,
  operationProofSubstrate,
  pluginContributions,
  proxyApiRequest,
  rateLimits,
  registeredCoreProvider,
  runtimeLogger,
  securityPermissions,
  subjectRateLimiter,
  tenantRateLimiter,
  toolSkillManagementProvider,
  platformMcpGatewayAdapter,
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
    response.setHeader("X-Meshrix-Trace-Id", traceContext.traceId);
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

          if (await handlePluginConsoleRequest({
            request,
            response,
            requestBody,
            method,
            url,
            consoleAuth,
            pluginContributions,
            requestOperations,
            controllers,
            authorizeOperation: (input?: any) : any => securityPermissions.authorizeOperation(input),
            verifyProcessIdentity: (input?: any) : any => securityPermissions.verifyProcessIdentity(input),
            operationAuditStore,
            operationProofSubstrate,
            lockManager: operationLockManager,
            concurrencyScope: operationConcurrencyScope,
            signal: requestAbortController.signal,
            logger: runtimeLogger
          })) {
            return;
          }

          const discoveryState: any = getDiscoveryState();
          if (url.pathname === "/.well-known/meshrix/mcp.json" || url.pathname === "/api/mcp/discovery") {
            if (method !== "GET" && method !== "HEAD") {
              response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
              response.end();
              return;
            }
            sendJson(response, 200, buildMeshrixMcpDiscovery({
              listenUrl: getListenUrl(),
              discoveryState
            }));
            return;
          }

          if (url.pathname === "/api/mcp/handshake") {
            if (method !== "POST") {
              response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
              response.end();
              return;
            }
            try {
              const result: any = mcpHandshake({
                request,
                requestBody,
                listenUrl: getListenUrl(),
                discoveryState
              });
              sendJson(response, result.status, result.body);
            } catch {
              sendJson(response, 400, {
                ok: false,
                error: "MCP handshake body must be valid JSON."
              });
            }
            return;
          }

          if (url.pathname === "/mcp") {
            if (!platformMcpGatewayAdapter) {
              sendJson(response, 503, {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32004,
                  message: "MCP gateway adapter is unavailable."
                }
              });
              return;
            }
            if (!isAllowedPlatformMcpOrigin(request)) {
              sendJson(response, 403, {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32003,
                  message: "MCP request origin is not allowed."
                }
              });
              return;
            }
            if (method !== "POST") {
              response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
              response.end();
              return;
            }
            let payload: any;
            try {
              payload = parseMcpRequestBody(requestBody);
            } catch {
              runtimeLogger.warn("mcp.http.invalid_json", {
                requestId: request?.__meshrixRequestId || ""
              });
              sendJson(response, 400, {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32700,
                  message: "MCP request body must be valid JSON."
                }
              });
              return;
            }
            if (!Array.isArray(payload) && payload?.method === MCP_CATALOG_ACKNOWLEDGE_METHOD) {
              await handlePlatformMcpCatalogAcknowledgement({
                request,
                response,
                requestBody,
                url,
                method,
                payload,
                toolSkillManagementProvider
              });
              return;
            }
            const result: any = await platformMcpGatewayAdapter.handle({
              method,
              headers: request.headers,
              body: payload,
              rawRequest: request,
              requestBody,
              url,
              signal: requestAbortController.signal
            });
            await sendPlatformMcpAdapterResponse({
              request,
              response,
              requestBody,
              url,
              method,
              payload,
              result,
              toolSkillManagementProvider
            });
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
            await registeredCoreProvider.dispatchRegisteredHttpOperation({
              operations: requestOperations,
              controllers,
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
              logger: runtimeLogger,
              invokeOperation: async (invocation?: any) : Promise<any> => proxyApiRequest({
                request: invocation.request,
                response: invocation.response,
                requestBody: invocation.requestBody,
                targetBaseUrl: proxyDecision.targetBaseUrl,
                signal: invocation.signal,
                logger: runtimeLogger
              })
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
            error: {
              ...summarizeError(error),
              reasonCode: classifiedRequestFailureReason(error)
            }
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
