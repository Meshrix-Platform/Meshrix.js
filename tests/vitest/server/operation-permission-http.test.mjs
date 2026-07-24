import { beforeEach, describe, expect, it, vi } from "vitest";

const sendJsonMock = vi.hoisted(() => vi.fn((response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}));
const summarizeErrorMock = vi.hoisted(() => vi.fn((error) => ({ message: error?.message || String(error || "") })));
const summarizeForLogMock = vi.hoisted(() => vi.fn((value) => value));
const getRuntimeLoggerMock = vi.hoisted(() => vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})));

vi.mock("@meshrix/foundation/observability/runtime-logger", () => ({
  getRuntimeLogger: getRuntimeLoggerMock,
  summarizeError: summarizeErrorMock,
  summarizeForLog: summarizeForLogMock
}));

vi.mock("@meshrix/protocols/http/http-utils", () => ({
  sendJson: sendJsonMock
}));

import { createOperationPermissionHttpRouter } from "../../../packages/capabilities/src/operation-permission-core/http.mjs";

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk = "") {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      this.ended = true;
    }
  };
}

function createRequest({ headers = {}, id = "req-tool-http-final-extra-5" } = {}) {
  return {
    __licoRequestId: id,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function createUrl(pathname) {
  return new URL(pathname, "http://127.0.0.1");
}

function createPlatform(overrides = {}) {
  const platform = {
    catalog: vi.fn(() => ({ schemaVersion: "v0.0.1:schema:definition-1", catalog: true })),
    registry: {
      getTool: vi.fn((toolId) => (toolId === "known.tool" ? { id: toolId, label: "Known" } : null)),
      getToolByOperationId: vi.fn(() => null),
      listToolsets: vi.fn(() => [{ id: "toolset-a" }]),
      resolveToolset: vi.fn((payload) => ({ resolved: payload.toolsets || [] })),
      listProfiles: vi.fn(() => [{ id: "profile-a" }])
    },
    runtime: {
      executeTool: vi.fn(async () => ({ status: 207, payload: { schemaVersion: "v0.0.1:schema:definition-1", executed: true } })),
      resumePendingOperation: vi.fn(async (payload) => ({ status: 202, payload: { schemaVersion: "v0.0.1:schema:definition-1", resumed: payload } }))
    },
    store: {
      listGrants: vi.fn(() => [{ id: "grant-a" }]),
      createGrant: vi.fn(async () => ({ grant: { id: "grant-new" }, token: "sat" })),
      rotateGrantToken: vi.fn(async (grantId) => (grantId === "missing" ? null : { grant: { id: grantId }, token: "rotated" })),
      revokeGrant: vi.fn(async (grantId, reason) => (grantId === "missing" ? null : { id: grantId, reason })),
      updateGrant: vi.fn((grantId, payload) => (grantId === "missing" ? null : { id: grantId, ...payload })),
      listAudit: vi.fn((payload) => [{ toolExecutionId: "exec-a", ...payload }]),
      getAudit: vi.fn((id) => (id === "missing" ? null : { toolExecutionId: id })),
      listGrantEvents: vi.fn((payload) => [{ eventId: "event-a", ...payload }]),
      metricsSummary: vi.fn((payload) => ({ type: "summary", payload })),
      metricsExport: vi.fn((payload) => ({ type: "export", payload })),
      metricsHealth: vi.fn((payload) => ({ type: "health", payload })),
      metricsPrometheus: vi.fn((payload) => `metric_total{window="${payload.windowSeconds}"} 1\n`),
      metricsStorageSummary: vi.fn(() => ({ bytes: 10 })),
      pruneMetrics: vi.fn((payload) => ({ pruned: true, payload })),
      listPendingOperations: vi.fn((payload) => [{
        pendingOperationId: "pending_op_visible_123",
        toolId: "known.tool",
        traceId: "trace-pending_op_trace_123",
        toolExecutionId: "tool_exec_hidden_123",
        grantId: "grant_hidden1234",
        resolvedBy: "authenticated-owner-hidden",
        context: { nestedPendingOperationId: "pending_op_nested_123" },
        redactedInput: { message: "secret" },
        ...payload
      }])
    },
    policyEngine: {
      preview: vi.fn((payload) => ({ effect: "allow", payload }))
    }
  };
  return Object.assign(platform, overrides, {
    registry: { ...platform.registry, ...(overrides.registry || {}) },
    runtime: { ...platform.runtime, ...(overrides.runtime || {}) },
    store: { ...platform.store, ...(overrides.store || {}) },
    policyEngine: { ...platform.policyEngine, ...(overrides.policyEngine || {}) }
  });
}

async function callRouter(router, {
  method = "GET",
  path,
  body = null,
  rawRequestBody = null,
  headers = {},
  requestId
} = {}) {
  const response = createResponse();
  const request = createRequest({ headers, id: requestId });
  const requestBody = rawRequestBody || (body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"));
  const handled = await router.handleOperationPermissionHttpRequest({
    request,
    response,
    requestBody,
    url: createUrl(path),
    method
  });
  return { handled, request, response };
}

beforeEach(() => {
  sendJsonMock.mockClear();
  summarizeErrorMock.mockClear();
  summarizeForLogMock.mockClear();
  getRuntimeLoggerMock.mockClear();
});

describe("operation permission http behavior", () => {
  it("covers read-side catalog, profile, policy, audit, metrics, event, and pending routes", async () => {
    const platform = createPlatform();
    const securityPermissions = {
      authorizeOperation: vi.fn(async () => ({
        ok: true,
        session: { user: { userId: "user-a", roleId: "role-a" } }
      }))
    };
    const router = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: getRuntimeLoggerMock() });

    expect((await callRouter(router, { path: "/not-operation-permission" })).handled).toBe(false);

    await callRouter(router, { path: "/api/operation-permission/v1/catalog/known.tool" });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 200, {
      schemaVersion: "v0.0.1:schema:definition-1",
      tool: { id: "known.tool", label: "Known" }
    });

    await callRouter(router, { path: "/api/operation-permission/v1/catalog/missing.tool" });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: { code: "unknown_tool", message: "Tool is not registered.", details: { toolId: "missing.tool" } }
    });

    await callRouter(router, { path: "/api/operation-permission/v1/toolsets" });
    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/toolsets/resolve", body: { toolsets: ["a"] } });
    await callRouter(router, { path: "/api/operation-permission/v1/profiles" });
    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/policy/preview", body: { operationId: "op" } });
    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/policy/evaluate", body: { operationId: "op2" } });
    expect(platform.registry.listToolsets).toHaveBeenCalled();
    expect(platform.registry.resolveToolset).toHaveBeenCalledWith({ toolsets: ["a"] });
    expect(platform.registry.listProfiles).toHaveBeenCalled();
    expect(platform.policyEngine.preview).toHaveBeenCalledTimes(2);

    await callRouter(router, { path: "/api/operation-permission/v1/grants" });
    expect(platform.store.listGrants).toHaveBeenCalled();

    await callRouter(router, { path: "/api/operation-permission/v1/audit?limit=3&toolId=t&grantId=g&status=ok" });
    expect(platform.store.listAudit).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      toolId: "t",
      grantId: "g",
      status: "ok"
    }));
    await callRouter(router, { path: "/api/operation-permission/v1/audit/exec%2F1" });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 200, {
      schemaVersion: "v0.0.1:schema:definition-1",
      audit: { toolExecutionId: "[redacted]" }
    });
    await callRouter(router, { path: "/api/operation-permission/v1/audit/missing" });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: { code: "audit_not_found", message: "Audit record not found." }
    });

    await callRouter(router, { path: "/api/operation-permission/v1/metrics/summary?bucket-seconds=60&completion-status=completed" });
    await callRouter(router, { path: "/api/operation-permission/v1/metrics/export?kind=http&status-code=500" });
    await callRouter(router, { path: "/api/operation-permission/v1/metrics/health?window-seconds=10&max-request-error-rate=0.5&min-requests=2" });
    const prometheus = await callRouter(router, { path: "/api/operation-permission/v1/metrics/prometheus?windowSeconds=12" });
    expect(prometheus.response.statusCode).toBe(200);
    expect(prometheus.response.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    await callRouter(router, { path: "/api/operation-permission/v1/metrics/storage" });
    expect(platform.store.metricsSummary).toHaveBeenCalled();
    expect(platform.store.metricsExport).toHaveBeenCalled();
    expect(platform.store.metricsHealth).toHaveBeenCalled();
    expect(platform.store.metricsPrometheus).toHaveBeenCalledWith(expect.objectContaining({ windowSeconds: 12 }));
    expect(platform.store.metricsStorageSummary).toHaveBeenCalled();

    await callRouter(router, { path: "/api/operation-permission/v1/events?limit=9&grantId=g&eventType=created" });
    await callRouter(router, { path: "/api/operation-permission/v1/pending-operations?status=all&limit=8" });
    expect(platform.store.listGrantEvents).toHaveBeenCalledWith({
      limit: 9,
      grantId: "g",
      eventType: "created"
    });
    expect(platform.store.listPendingOperations).toHaveBeenCalledWith({ status: "all", limit: 8 });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 200, {
      schemaVersion: "v0.0.1:schema:definition-1",
      pendingOperations: [
        expect.objectContaining({
          pendingOperationId: "pending_op_visible_123",
          toolId: "known.tool",
          status: "all",
          limit: 8,
          traceId: "[redacted]",
          toolExecutionId: "[redacted]",
          grantId: "[redacted]",
          resolvedBy: "[redacted]",
          context: "[redacted]",
          redactedInput: "[redacted]"
        })
      ]
    });
  });

  it("covers write route 404s, confirmed mutations, pending resolve, route misses, and thrown parser errors", async () => {
    const platform = createPlatform();
    const securityPermissions = {
      authorizeOperation: vi.fn(async () => ({
        ok: true,
        session: { user: { userId: "test-user", roleId: "test-role" } }
      }))
    };
    const router = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: getRuntimeLoggerMock() });
    const confirmed = { "x-meshrix-safety-confirm": "true" };

    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/grants/missing/rotate", headers: confirmed });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: { code: "grant_not_found", message: "Grant not found." }
    });
    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/grants/grant%2F1/rotate", headers: confirmed });
    expect(platform.store.rotateGrantToken).toHaveBeenCalledWith("grant/1");

    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/grants/missing/revoke", headers: confirmed, body: { reason: "deny" } });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: { code: "grant_not_found", message: "Grant not found." }
    });
    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/grants/grant%2F2/revoke", headers: confirmed, body: { reason: "done" } });
    expect(platform.store.revokeGrant).toHaveBeenCalledWith("grant/2", "done");

    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/grants/missing", headers: confirmed, body: { label: "x" } });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: { code: "grant_not_found", message: "Grant not found." }
    });
    await callRouter(router, { method: "POST", path: "/api/operation-permission/v1/grants/grant%2F3", headers: confirmed, body: { label: "ok" } });
    expect(platform.store.updateGrant).toHaveBeenCalledWith("grant/3", { label: "ok" });

    await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/metrics/prune",
      headers: confirmed,
      body: {
        older_than: "2026-01-01T00:00:00.000Z",
        retention_days: 7,
        max_rows: 10,
        max_tool_metric_rows: 3,
        max_http_request_metric_rows: 4,
        dry_run: true
      }
    });
    expect(platform.store.pruneMetrics).toHaveBeenCalledWith({
      olderThan: "2026-01-01T00:00:00.000Z",
      retentionDays: 7,
      maxRows: 10,
      maxToolMetricRows: 3,
      maxHttpRequestMetricRows: 4,
      dryRun: true
    });

    await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/pending-operations/pending%2F1/resolve",
      headers: confirmed,
      body: {
        decision: "approved",
        reviewer: "reviewer-a",
        reason: "allowed",
        context: { source: "unit" }
      }
    });
    expect(platform.runtime.resumePendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      pendingOperationId: "pending/1",
      resolution: "approved",
      resolvedBy: "test-user",
      reason: "allowed",
      approver: {
        userId: "test-user",
        roleId: "test-role"
      },
      context: expect.objectContaining({ source: "unit", transport: "tool-http-approval" }),
      request: expect.any(Object)
    }));

    await callRouter(router, { path: "/api/operation-permission/v1/unknown-route" });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: {
        code: "operation_permission_route_not_found",
        message: "Operation Permission route not found.",
        details: { path: "/unknown-route" }
      }
    });

    await expect(callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/toolsets/resolve",
      rawRequestBody: Buffer.from("{not-json", "utf8")
    })).rejects.toBeInstanceOf(SyntaxError);
    expect(summarizeErrorMock).toHaveBeenCalled();
  });

  it("returns early for authorized route families when console authorization is denied", async () => {
    const platform = createPlatform();
    const securityPermissions = {
      authorizeOperation: vi.fn(async () => ({
        ok: false,
        status: 403,
        error: "denied"
      }))
    };
    const router = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: getRuntimeLoggerMock() });
    const routes = [
      { path: "/api/operation-permission/v1/catalog/missing.tool" },
      { path: "/api/operation-permission/v1/toolsets" },
      { method: "POST", path: "/api/operation-permission/v1/toolsets/resolve", body: { toolsets: ["a"] } },
      { path: "/api/operation-permission/v1/profiles" },
      { path: "/api/operation-permission/v1/grants" },
      { method: "POST", path: "/api/operation-permission/v1/grants", body: { label: "new", allowedWorkspaceIds: ["ws-b"] } },
      { method: "POST", path: "/api/operation-permission/v1/grants/grant-a/rotate" },
      { method: "POST", path: "/api/operation-permission/v1/grants/grant-a/revoke", body: { reason: "x" } },
      { method: "POST", path: "/api/operation-permission/v1/grants/grant-a", body: { label: "x", allowedSecretBindings: ["sec-b"] } },
      { path: "/api/operation-permission/v1/audit" },
      { path: "/api/operation-permission/v1/audit/exec-a" },
      { path: "/api/operation-permission/v1/metrics/summary" },
      { path: "/api/operation-permission/v1/metrics/export" },
      { path: "/api/operation-permission/v1/metrics/health" },
      { path: "/api/operation-permission/v1/metrics/prometheus" },
      { path: "/api/operation-permission/v1/metrics/storage" },
      { method: "POST", path: "/api/operation-permission/v1/metrics/prune", body: { dryRun: true } },
      { path: "/api/operation-permission/v1/events" },
      { path: "/api/operation-permission/v1/pending-operations" },
      { method: "POST", path: "/api/operation-permission/v1/pending-operations/pending-a/resolve", body: { resolution: "approved" } }
    ];

    for (const route of routes) {
      const result = await callRouter(router, route);
      expect(result.handled).toBe(true);
      expect(result.response.statusCode).toBe(403);
    }
    expect(platform.registry.getTool).not.toHaveBeenCalled();
    expect(platform.store.listGrants).not.toHaveBeenCalled();
    expect(platform.runtime.resumePendingOperation).not.toHaveBeenCalled();
    expect(securityPermissions.authorizeOperation).toHaveBeenCalledTimes(routes.length);
    expect(securityPermissions.authorizeOperation).toHaveBeenNthCalledWith(6, expect.objectContaining({
      input: expect.objectContaining({
        label: "new",
        allowedWorkspaceIds: ["ws-b"]
      })
    }));
    expect(securityPermissions.authorizeOperation).toHaveBeenNthCalledWith(9, expect.objectContaining({
      input: expect.objectContaining({
        grantId: "grant-a",
        label: "x",
        allowedSecretBindings: ["sec-b"]
      })
    }));
  });

  it("covers no-op logger, empty JSON payloads, and unavailable pending runtime", async () => {
    const platform = createPlatform({
      runtime: {
        resumePendingOperation: null
      }
    });
    const securityPermissions = {
      authorizeOperation: vi.fn(async () => ({
        ok: true,
        session: { user: { userId: "test-user", roleId: "test-role" } }
      }))
    };
    const router = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: null });
    const confirmed = { "x-meshrix-safety-confirm": "yes" };

    await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/toolsets/resolve",
      rawRequestBody: Buffer.alloc(0)
    });
    expect(platform.registry.resolveToolset).toHaveBeenCalledWith({});

    await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/pending-operations/pending-a/resolve",
      headers: confirmed,
      body: { resolution: "approved" }
    });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 503, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: {
        code: "pending_operation_runtime_unavailable",
        message: "Pending operation runtime is unavailable."
      }
    });
  });

});
