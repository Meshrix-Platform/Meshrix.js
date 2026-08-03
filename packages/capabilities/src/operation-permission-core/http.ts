import {
  getRuntimeLogger,
  summarizeError,
  summarizeForLog
} from "@meshrix/foundation/observability/runtime-logger";
import { sendJson } from "@meshrix/protocols/http/http-utils";
import { OPERATION_PERMISSION_API_PREFIX } from "./catalog.ts";
import {
  parseJsonBody,
  pathAfterPrefix,
  plainObject,
  publicOperationPermissionResponse,
  publicPendingOperationListResponse,
  sanitizeExternalToolContext
} from "./http-helpers.ts";

async function authorizeConsole({
  securityPermissions = null,
  request,
  method,
  url,
  requiredScopes = ["runtime:admin"],
  input = {}
}: Record<string, any>) : Promise<any> {
  if (!securityPermissions || typeof securityPermissions.authorizeOperation !== "function") {
    return {
      ok: false,
      status: 503,
      error: "Authorization engine is unavailable. Console operations cannot be processed.",
      bootstrap: { authorizationEngineAvailable: false }
    };
  }
  return securityPermissions.authorizeOperation({
    request,
    method,
    url,
    operation: {
      id: "operation_permission.http",
      requiredScopes,
      skipCsrf: false
    },
    input
  });
}

function sendAuthorizationDenied(response?: any, authorization?: any) : any {
  const code: any = authorization.status === 401
    ? "console_unauthenticated"
    : authorization.status === 503
      ? "authorization_engine_unavailable"
      : "console_forbidden";
  sendJson(response, authorization.status || 403, {
    schemaVersion: "v0.0.1:schema:definition-1",
    error: {
      code,
      message: authorization.error || "Permission denied.",
      details: {
        bootstrap: authorization.bootstrap
      }
    }
  });
}

export function createOperationPermissionHttpRouter({
  platform,
  securityPermissions = null,
  logger = getRuntimeLogger()
}: Record<string, any>) : any {
  function logRouter(level?: any, event?: any, details: Record<string, any> = {}) : any {
    if (!logger || typeof logger[level] !== "function") {
      return;
    }
    logger[level](event, details);
  }

  function hasSafetyConfirm(request?: any) : any {
    const value: any = String(
      request?.headers?.["x-meshrix-safety-confirm"] ||
        request?.headers?.["x-meshrix-confirm"] ||
        ""
    ).toLowerCase();
    return ["1", "true", "yes"].includes(value);
  }

  function requireSafetyConfirm(request?: any, response?: any) : any {
    if (hasSafetyConfirm(request)) {
      return true;
    }
    logRouter("warn", "operation_permission.http.confirmation_required", {
      requestId: request?.__meshrixRequestId || ""
    });
    sendJson(response, 403, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: {
        code: "confirmation_required",
        message: "Operation Permission grant changes require x-meshrix-safety-confirm: true."
      }
    });
    return false;
  }

  async function requireConsole(request?: any, response?: any, method?: any, url?: any, scopes: any = ["runtime:admin"], input: Record<string, any> = {}) : Promise<any> {
    const authorization: any = await authorizeConsole({
      securityPermissions,
      request,
      method,
      url,
      requiredScopes: scopes,
      input
    });
    if (!authorization.ok) {
      logRouter("warn", "operation_permission.http.denied", {
        requestId: request?.__meshrixRequestId || "",
        method,
        route: url.pathname,
        scopes,
        status: authorization.status || 403,
        error: authorization.error || ""
      });
      sendAuthorizationDenied(response, authorization);
      return null;
    }
    logRouter("debug", "operation_permission.http.authorized", {
      requestId: request?.__meshrixRequestId || "",
      method,
      route: url.pathname,
      scopes,
      userId: authorization.session?.user?.userId || "",
      roleId: authorization.session?.user?.roleId || ""
    });
    return authorization;
  }

  function resolvedByFromAuthorization(authorization: any = null) : any {
    const user: any = authorization?.session?.user || {};
    return String(user.userId || user.subjectId || user.username || user.roleId || "console").trim() || "console";
  }

  async function handleOperationPermissionHttpRequest({ request, response, requestBody, url, method, signal = null }: Record<string, any>) : Promise<any> {
    const isOperationPermissionRequest: any = url.pathname.startsWith(OPERATION_PERMISSION_API_PREFIX);
    if (!isOperationPermissionRequest) {
      return false;
    }
    const suffix: any = pathAfterPrefix(url.pathname);
    const normalizedMethod: any = String(method || "GET").toUpperCase();
    const startedAt: any = Date.now();
    logRouter("info", "operation_permission.http.requested", {
      requestId: request?.__meshrixRequestId || "",
      method: normalizedMethod,
      route: url.pathname,
      suffix,
      query: Object.fromEntries(url.searchParams.entries()),
      bodyBytes: requestBody?.length || 0
    });

    async function complete(status?: any, payload: Record<string, any> = {}) : Promise<any> {
      logRouter(status >= 400 ? "warn" : "info", "operation_permission.http.completed", {
        requestId: request?.__meshrixRequestId || "",
        method: normalizedMethod,
        route: url.pathname,
        suffix,
        status,
        durationMs: Date.now() - startedAt,
        payload: summarizeForLog(payload, { maxDepth: 3, maxArrayItems: 4, maxObjectKeys: 20 })
      });
      sendJson(response, status, payload);
      return true;
    }

    async function completeText(status?: any, text?: any, contentType: any = "text/plain; charset=utf-8") : Promise<any> {
      logRouter(status >= 400 ? "warn" : "info", "operation_permission.http.completed", {
        requestId: request?.__meshrixRequestId || "",
        method: normalizedMethod,
        route: url.pathname,
        suffix,
        status,
        durationMs: Date.now() - startedAt,
        responseBytes: Buffer.byteLength(String(text || ""), "utf8")
      });
      response.writeHead(status, { "content-type": contentType });
      response.end(String(text || ""));
      return true;
    }

    async function completeOneTimeApiKey(status?: any, payload: Record<string, any> = {}) : Promise<any> {
      logRouter("info", "operation_permission.api_key.one_time_response", {
        requestId: request?.__meshrixRequestId || "",
        method: normalizedMethod,
        route: url.pathname,
        status,
        durationMs: Date.now() - startedAt,
        keyId: payload.record?.keyId || "",
        lifecycleRevision: payload.record?.lifecycleRevision || 0
      });
      response.setHeader?.("cache-control", "no-store");
      response.setHeader?.("pragma", "no-cache");
      sendJson(response, status, payload);
      return true;
    }

    try {
    if (normalizedMethod === "GET" && suffix === "/api-keys/issuer-scopes") {
      const authorization: any = await requireConsole(request, response, normalizedMethod, url, ["console:read"]);
      if (!authorization) return true;
      const scopes: any = await platform.apiKeyDistributionProvider.getIssuerScopes({
        subjectId: resolvedByFromAuthorization(authorization)
      });
      const requestHost: any = String(request?.headers?.host || request?.headers?.[":authority"] || "")
        .split(",")[0]
        .trim();
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        ...scopes,
        ...(requestHost ? { serverAudience: requestHost } : {})
      });
    }

    if (normalizedMethod === "GET" && suffix === "/api-keys") {
      const authorization: any = await requireConsole(request, response, normalizedMethod, url, ["console:read"]);
      if (!authorization) return true;
      const page: any = await platform.apiKeyDistributionProvider.list({
        subjectId: resolvedByFromAuthorization(authorization),
        ...(url.searchParams.get("status") ? { status: url.searchParams.get("status") } : {}),
        ...(url.searchParams.get("organizationNodeId") ? { organizationNodeId: url.searchParams.get("organizationNodeId") } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
        ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {})
      });
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", ...page });
    }

    if (normalizedMethod === "POST" && suffix === "/api-keys") {
      const payload: any = parseJsonBody(requestBody);
      const authorization: any = await requireConsole(request, response, normalizedMethod, url, ["console:read"], payload);
      if (!authorization) return true;
      const result: any = await platform.apiKeyDistributionProvider.create({
        ...payload,
        subjectId: resolvedByFromAuthorization(authorization)
      });
      return completeOneTimeApiKey(201, { schemaVersion: "v0.0.1:schema:definition-1", ...result });
    }

    const apiKeyRotateMatch: any = suffix.match(/^\/api-keys\/([^/]+)\/rotate$/);
    if (normalizedMethod === "POST" && apiKeyRotateMatch) {
      const payload: any = parseJsonBody(requestBody);
      const authorization: any = await requireConsole(request, response, normalizedMethod, url, ["console:read"], payload);
      if (!authorization) return true;
      const result: any = await platform.apiKeyDistributionProvider.rotate({
        ...payload,
        keyId: decodeURIComponent(apiKeyRotateMatch[1]),
        subjectId: resolvedByFromAuthorization(authorization)
      });
      return completeOneTimeApiKey(200, { schemaVersion: "v0.0.1:schema:definition-1", ...result });
    }

    const apiKeyRevokeMatch: any = suffix.match(/^\/api-keys\/([^/]+)\/revoke$/);
    if (normalizedMethod === "POST" && apiKeyRevokeMatch) {
      const payload: any = parseJsonBody(requestBody);
      const authorization: any = await requireConsole(request, response, normalizedMethod, url, ["console:read"], payload);
      if (!authorization) return true;
      const record: any = await platform.apiKeyDistributionProvider.revoke({
        ...payload,
        keyId: decodeURIComponent(apiKeyRevokeMatch[1]),
        subjectId: resolvedByFromAuthorization(authorization)
      });
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", record });
    }

    if (normalizedMethod === "GET" && suffix === "/catalog") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, platform.catalog());
    }

    if (normalizedMethod === "GET" && suffix.startsWith("/catalog/")) {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      const toolId: any = decodeURIComponent(suffix.slice("/catalog/".length));
      const tool: any = platform.registry.getTool(toolId);
      if (!tool) {
        return complete(404, {
          schemaVersion: "v0.0.1:schema:definition-1",
          error: { code: "unknown_tool", message: "Tool is not registered.", details: { toolId } }
        });
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", tool });
    }

    if (normalizedMethod === "GET" && suffix === "/toolsets") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", toolsets: platform.registry.listToolsets() });
    }

    if (normalizedMethod === "POST" && suffix === "/toolsets/resolve") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      const payload: any = parseJsonBody(requestBody);
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        result: platform.registry.resolveToolset(payload)
      });
    }

    if (normalizedMethod === "GET" && suffix === "/profiles") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", profiles: platform.registry.listProfiles() });
    }

    if (normalizedMethod === "POST" && (suffix === "/policy/evaluate" || suffix === "/policy/preview")) {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      const payload: any = parseJsonBody(requestBody);
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        decision: platform.policyEngine.preview(payload)
      });
    }

    if (normalizedMethod === "POST" && (suffix === "/execute" || suffix === "/dry-run")) {
      const payload: any = parseJsonBody(requestBody);
      const result: any = await platform.runtime.executeTool({
        toolId: payload.toolId,
        input: payload.input || {},
        request,
        requestBody,
        requestUrl: url,
        requestMethod: normalizedMethod,
        signal,
        context: sanitizeExternalToolContext(payload.context, { transport: "meshrix-client-http" }),
        dryRun: suffix === "/dry-run" || payload.dryRun === true
      });
      return complete(result.status || 500, result.payload);
    }

    if (normalizedMethod === "POST" && suffix === "/batch") {
      const payload: any = parseJsonBody(requestBody);
      const calls: any = Array.isArray(payload.calls) ? payload.calls : [];
      const effectCalls: any = calls.filter((call?: any) : any =>
        payload.dryRun !== true && call?.dryRun !== true
      );
      if (effectCalls.length > 1) {
        return complete(409, {
          schemaVersion: "v0.0.1:schema:definition-1",
          error: {
            code: "operation_permission_atomic_batch_required",
            message: "Multiple effectful calls require an atomic reservation and are not admitted by this endpoint."
          }
        });
      }
      const results: any[] = [];
      for (const call of calls) {
        results.push(
          (await platform.runtime.executeTool({
            toolId: call.toolId,
            input: call.input || {},
            request,
            requestBody,
            requestUrl: url,
            requestMethod: normalizedMethod,
            signal,
            context: sanitizeExternalToolContext({
              ...plainObject(payload.context),
              ...plainObject(call.context)
            }, { transport: "meshrix-client-http-batch" }),
            dryRun: payload.dryRun === true || call.dryRun === true
          })).payload
        );
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", results });
    }

    if (normalizedMethod === "GET" && suffix === "/grants") {
      if (!(await requireConsole(request, response, normalizedMethod, url))) {
        return true;
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", grants: platform.store.listGrants() });
    }

    if (normalizedMethod === "POST" && suffix === "/grants") {
      const payload: any = parseJsonBody(requestBody);
      if (!(await requireConsole(request, response, normalizedMethod, url, ["runtime:admin"], payload))) {
        return true;
      }
      if (!requireSafetyConfirm(request, response)) {
        return true;
      }
      const result: any = await platform.store.createGrant(payload);
      return complete(201, {
        schemaVersion: "v0.0.1:schema:definition-1",
        grant: result.grant,
        token: result.token
      });
    }

    const grantRotateMatch: any = suffix.match(/^\/grants\/([^/]+)\/rotate$/);
    if (normalizedMethod === "POST" && grantRotateMatch) {
      if (!(await requireConsole(request, response, normalizedMethod, url))) {
        return true;
      }
      if (!requireSafetyConfirm(request, response)) {
        return true;
      }
      const result: any = await platform.store.rotateGrantToken(decodeURIComponent(grantRotateMatch[1]));
      if (!result) {
        return complete(404, { schemaVersion: "v0.0.1:schema:definition-1", error: { code: "grant_not_found", message: "Grant not found." } });
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", grant: result.grant, token: result.token });
    }

    const grantRevokeMatch: any = suffix.match(/^\/grants\/([^/]+)\/revoke$/);
    if (normalizedMethod === "POST" && grantRevokeMatch) {
      if (!(await requireConsole(request, response, normalizedMethod, url))) {
        return true;
      }
      if (!requireSafetyConfirm(request, response)) {
        return true;
      }
      const payload: any = parseJsonBody(requestBody);
      const grant: any = await platform.store.revokeGrant(decodeURIComponent(grantRevokeMatch[1]), payload.reason || "");
      if (!grant) {
        return complete(404, { schemaVersion: "v0.0.1:schema:definition-1", error: { code: "grant_not_found", message: "Grant not found." } });
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", grant });
    }

    const grantUpdateMatch: any = suffix.match(/^\/grants\/([^/]+)$/);
    if (normalizedMethod === "POST" && grantUpdateMatch) {
      const payload: any = parseJsonBody(requestBody);
      const grantId: any = decodeURIComponent(grantUpdateMatch[1]);
      if (!(await requireConsole(request, response, normalizedMethod, url, ["runtime:admin"], {
        ...payload,
        grantId
      }))) {
        return true;
      }
      if (!requireSafetyConfirm(request, response)) {
        return true;
      }
      const grant: any = await platform.store.updateGrant(grantId, payload);
      if (!grant) {
        return complete(404, { schemaVersion: "v0.0.1:schema:definition-1", error: { code: "grant_not_found", message: "Grant not found." } });
      }
      await platform.store.flushChangeNotifications?.();
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", grant });
    }

    if (normalizedMethod === "GET" && suffix === "/audit") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        items: publicOperationPermissionResponse(platform.store.listAudit({
          limit: Number(url.searchParams.get("limit") || 100),
          toolId: url.searchParams.get("toolId") || "",
          grantId: url.searchParams.get("grantId") || "",
          status: url.searchParams.get("status") || ""
        }))
      });
    }

    if (normalizedMethod === "GET" && suffix.startsWith("/audit/")) {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      const toolExecutionId: any = decodeURIComponent(suffix.slice("/audit/".length));
      const audit: any = platform.store.getAudit(toolExecutionId);
      if (!audit) {
        return complete(404, { schemaVersion: "v0.0.1:schema:definition-1", error: { code: "audit_not_found", message: "Audit record not found." } });
      }
      return complete(200, { schemaVersion: "v0.0.1:schema:definition-1", audit: publicOperationPermissionResponse(audit) });
    }

    if (normalizedMethod === "GET" && suffix === "/metrics/summary") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        metrics: publicOperationPermissionResponse(platform.store.metricsSummary({
          limit: Number(url.searchParams.get("limit") || 2000),
          since: url.searchParams.get("since") || "",
          until: url.searchParams.get("until") || "",
          toolId: url.searchParams.get("toolId") || url.searchParams.get("tool-id") || "",
          grantId: url.searchParams.get("grantId") || url.searchParams.get("grant-id") || "",
          profileId: url.searchParams.get("profileId") || url.searchParams.get("profile-id") || "",
          route: url.searchParams.get("route") || "",
          transport: url.searchParams.get("transport") || "",
          status: url.searchParams.get("status") || "",
          statusCode: url.searchParams.get("statusCode") || url.searchParams.get("status-code") || "",
          completionStatus: url.searchParams.get("completionStatus") || url.searchParams.get("completion-status") || "",
          bucketSeconds: Number(url.searchParams.get("bucketSeconds") || url.searchParams.get("bucket-seconds") || 0)
        }))
      });
    }

    if (normalizedMethod === "GET" && suffix === "/metrics/export") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        export: publicOperationPermissionResponse(platform.store.metricsExport({
          limit: Number(url.searchParams.get("limit") || 2000),
          since: url.searchParams.get("since") || "",
          until: url.searchParams.get("until") || "",
          kind: url.searchParams.get("kind") || "",
          toolId: url.searchParams.get("toolId") || url.searchParams.get("tool-id") || "",
          grantId: url.searchParams.get("grantId") || url.searchParams.get("grant-id") || "",
          profileId: url.searchParams.get("profileId") || url.searchParams.get("profile-id") || "",
          route: url.searchParams.get("route") || "",
          transport: url.searchParams.get("transport") || "",
          status: url.searchParams.get("status") || "",
          statusCode: url.searchParams.get("statusCode") || url.searchParams.get("status-code") || "",
          completionStatus: url.searchParams.get("completionStatus") || url.searchParams.get("completion-status") || ""
        }))
      });
    }

    if (normalizedMethod === "GET" && suffix === "/metrics/health") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        health: publicOperationPermissionResponse(platform.store.metricsHealth({
          windowSeconds: Number(url.searchParams.get("windowSeconds") || url.searchParams.get("window-seconds") || 300),
          maxRequestErrorRate: url.searchParams.get("maxRequestErrorRate") ||
            url.searchParams.get("max-request-error-rate") || "",
          maxToolFailureRate: url.searchParams.get("maxToolFailureRate") ||
            url.searchParams.get("max-tool-failure-rate") || "",
          maxDeniedRate: url.searchParams.get("maxDeniedRate") || url.searchParams.get("max-denied-rate") || "",
          maxRequestP95Ms: url.searchParams.get("maxRequestP95Ms") ||
            url.searchParams.get("max-request-p95-ms") || "",
          maxToolP95Ms: url.searchParams.get("maxToolP95Ms") || url.searchParams.get("max-tool-p95-ms") || "",
          minRequests: Number(url.searchParams.get("minRequests") || url.searchParams.get("min-requests") || 0)
        }))
      });
    }

    if (normalizedMethod === "GET" && suffix === "/metrics/prometheus") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return completeText(200, platform.store.metricsPrometheus({
        windowSeconds: Number(url.searchParams.get("windowSeconds") || url.searchParams.get("window-seconds") || 300),
        maxRequestErrorRate: url.searchParams.get("maxRequestErrorRate") ||
          url.searchParams.get("max-request-error-rate") || "",
        maxToolFailureRate: url.searchParams.get("maxToolFailureRate") ||
          url.searchParams.get("max-tool-failure-rate") || "",
        maxDeniedRate: url.searchParams.get("maxDeniedRate") || url.searchParams.get("max-denied-rate") || "",
        maxRequestP95Ms: url.searchParams.get("maxRequestP95Ms") ||
          url.searchParams.get("max-request-p95-ms") || "",
        maxToolP95Ms: url.searchParams.get("maxToolP95Ms") || url.searchParams.get("max-tool-p95-ms") || "",
        minRequests: Number(url.searchParams.get("minRequests") || url.searchParams.get("min-requests") || 0)
      }), "text/plain; version=0.0.4; charset=utf-8");
    }

    if (normalizedMethod === "GET" && suffix === "/metrics/storage") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        storage: publicOperationPermissionResponse(platform.store.metricsStorageSummary())
      });
    }

    if (normalizedMethod === "POST" && suffix === "/metrics/prune") {
      if (!(await requireConsole(request, response, normalizedMethod, url))) {
        return true;
      }
      if (!requireSafetyConfirm(request, response)) {
        return true;
      }
      const payload: any = parseJsonBody(requestBody);
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        prune: platform.store.pruneMetrics({
          olderThan: payload.olderThan || payload.older_than || "",
          retentionDays: payload.retentionDays ?? payload.retention_days ?? 0,
          maxRows: payload.maxRows ?? payload.max_rows ?? 0,
          maxToolMetricRows: payload.maxToolMetricRows ?? payload.max_tool_metric_rows ?? 0,
          maxHttpRequestMetricRows: payload.maxHttpRequestMetricRows ?? payload.max_http_request_metric_rows ?? 0,
          dryRun: payload.dryRun === true || payload.dry_run === true
        })
      });
    }

    if (normalizedMethod === "GET" && suffix === "/events") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        events: publicOperationPermissionResponse(platform.store.listGrantEvents({
          limit: Number(url.searchParams.get("limit") || 100),
          grantId: url.searchParams.get("grantId") || url.searchParams.get("grant-id") || "",
          eventType: url.searchParams.get("eventType") || url.searchParams.get("event-type") || ""
        }))
      });
    }

    if (normalizedMethod === "GET" && suffix === "/pending-operations") {
      if (!(await requireConsole(request, response, normalizedMethod, url, ["console:read"]))) {
        return true;
      }
      const pendingOperations: any = platform.store.listPendingOperations({
        status: url.searchParams.get("status") || "pending",
        limit: Number(url.searchParams.get("limit") || 100)
      }).map((operation?: any) : any => {
        const toolLabel: any = String(platform.registry?.getTool?.(operation.toolId)?.label || "").trim();
        return toolLabel ? { ...operation, toolLabel } : operation;
      });
      return complete(200, {
        schemaVersion: "v0.0.1:schema:definition-1",
        pendingOperations: publicPendingOperationListResponse(pendingOperations)
      });
    }

    const pendingResolveMatch: any = suffix.match(/^\/pending-operations\/([^/]+)\/resolve$/);
    if (normalizedMethod === "POST" && pendingResolveMatch) {
      const authorization: any = await requireConsole(request, response, normalizedMethod, url);
      if (!authorization) {
        return true;
      }
      if (!requireSafetyConfirm(request, response)) {
        return true;
      }
      if (!platform.runtime?.resumePendingOperation) {
        return complete(503, {
          schemaVersion: "v0.0.1:schema:definition-1",
          error: {
            code: "pending_operation_runtime_unavailable",
            message: "Pending operation runtime is unavailable."
          }
        });
      }
      const payload: any = parseJsonBody(requestBody);
      const result: any = await platform.runtime.resumePendingOperation({
        pendingOperationId: decodeURIComponent(pendingResolveMatch[1]),
        resolution: payload.resolution || payload.decision || "",
        request,
        context: sanitizeExternalToolContext(payload.context, { transport: "tool-http-approval" }),
        resolvedBy: resolvedByFromAuthorization(authorization),
        approver: authorization.session?.user || null,
        reason: payload.reason || ""
      });
      return complete(result.status || 500, publicOperationPermissionResponse(result.payload));
    }

    return complete(404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: {
        code: "operation_permission_route_not_found",
        message: "Operation Permission route not found.",
        details: { path: suffix }
      }
    });
    } catch (error: any) {
      if (String(error?.code || "").startsWith("api_key_")) {
        return complete(Number(error.statusCode || 500), {
          schemaVersion: "v0.0.1:schema:definition-1",
          error: {
            code: String(error.code),
            message: String(error.message || "API Key operation failed.")
          }
        });
      }
      logRouter("error", "operation_permission.http.failed", {
        requestId: request?.__meshrixRequestId || "",
        method: normalizedMethod,
        route: url.pathname,
        suffix,
        durationMs: Date.now() - startedAt,
        error: summarizeError(error)
      });
      throw error;
    }
  }

  return {
    handleOperationPermissionHttpRequest
  };
}
