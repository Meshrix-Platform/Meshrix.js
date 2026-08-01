import { beforeEach, describe, expect, it, vi } from "vitest";

const sendJsonMock: any = vi.hoisted(() : any => vi.fn((response?: any, status?: any, payload?: any) : any => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}));
const summarizeErrorMock: any = vi.hoisted(() : any => vi.fn((error?: any) : any => ({ message: error?.message || String(error || "") })));
const summarizeForLogMock: any = vi.hoisted(() : any => vi.fn((value?: any) : any => value));
const getRuntimeLoggerMock: any = vi.hoisted(() : any => vi.fn(() : any => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})));

vi.mock("@meshrix/foundation/observability/runtime-logger", () : any => ({
  getRuntimeLogger: getRuntimeLoggerMock,
  summarizeError: summarizeErrorMock,
  summarizeForLog: summarizeForLogMock
}));

vi.mock("@meshrix/protocols/http/http-utils", () : any => ({
  sendJson: sendJsonMock
}));

import { createOperationPermissionHttpRouter } from "../../../packages/capabilities/src/operation-permission-core/http.ts";
import { rowToPendingOperation } from "../../../packages/capabilities/src/operation-permission-core/store-models.ts";

function createResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk: any = "") : any {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      this.ended = true;
    }
  };
}

function createRequest({ headers = {}, id = "req-tool-http-final-extra-5" }: Record<string, any> = {}) : any {
  return {
    __meshrixRequestId: id,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function createUrl(pathname?: any) : any {
  return new URL(pathname, "http://127.0.0.1");
}

function createPlatform(overrides: Record<string, any> = {}) : any {
  const platform: Record<string, any> = {
    catalog: vi.fn(() : any => ({ schemaVersion: "v0.0.1:schema:definition-1", catalog: true })),
    registry: {
      getTool: vi.fn((toolId?: any) : any => (toolId === "known.tool" ? { id: toolId, label: "Known" } : null)),
      getToolByOperationId: vi.fn(() : any => null),
      listToolsets: vi.fn(() : any => [{ id: "toolset-a" }]),
      resolveToolset: vi.fn((payload?: any) : any => ({ resolved: payload.toolsets || [] })),
      listProfiles: vi.fn(() : any => [{ id: "profile-a" }])
    },
    runtime: {
      executeTool: vi.fn(async () : Promise<any> => ({ status: 207, payload: { schemaVersion: "v0.0.1:schema:definition-1", executed: true } })),
      resumePendingOperation: vi.fn(async (payload?: any) : Promise<any> => ({ status: 202, payload: { schemaVersion: "v0.0.1:schema:definition-1", resumed: payload } }))
    },
    store: {
      listGrants: vi.fn(() : any => [{ id: "grant-a" }]),
      createGrant: vi.fn(async () : Promise<any> => ({ grant: { id: "grant-new" }, token: "sat" })),
      rotateGrantToken: vi.fn(async (grantId?: any) : Promise<any> => (grantId === "missing" ? null : { grant: { id: grantId }, token: "rotated" })),
      revokeGrant: vi.fn(async (grantId?: any, reason?: any) : Promise<any> => (grantId === "missing" ? null : { id: grantId, reason })),
      updateGrant: vi.fn((grantId?: any, payload?: any) : any => (grantId === "missing" ? null : { id: grantId, ...payload })),
      listAudit: vi.fn((payload?: any) : any => [{ toolExecutionId: "exec-a", ...payload }]),
      getAudit: vi.fn((id?: any) : any => (id === "missing" ? null : { toolExecutionId: id })),
      listGrantEvents: vi.fn((payload?: any) : any => [{ eventId: "event-a", ...payload }]),
      metricsSummary: vi.fn((payload?: any) : any => ({ type: "summary", payload })),
      metricsExport: vi.fn((payload?: any) : any => ({ type: "export", payload })),
      metricsHealth: vi.fn((payload?: any) : any => ({ type: "health", payload })),
      metricsPrometheus: vi.fn((payload?: any) : any => `metric_total{window="${payload.windowSeconds}"} 1\n`),
      metricsStorageSummary: vi.fn(() : any => ({ bytes: 10 })),
      pruneMetrics: vi.fn((payload?: any) : any => ({ pruned: true, payload })),
      listPendingOperations: vi.fn((payload?: any) : any => [{
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
      preview: vi.fn((payload?: any) : any => ({ effect: "allow", payload }))
    }
  };
  return Object.assign(platform, overrides, {
    registry: { ...platform.registry, ...(overrides.registry || {}) },
    runtime: { ...platform.runtime, ...(overrides.runtime || {}) },
    store: { ...platform.store, ...(overrides.store || {}) },
    policyEngine: { ...platform.policyEngine, ...(overrides.policyEngine || {}) }
  });
}

async function callRouter(router?: any, {
  method = "GET",
  path,
  body = null,
  rawRequestBody = null,
  headers = {},
  requestId
}: Record<string, any> = {}) : Promise<any> {
  const response: any = createResponse();
  const request: any = createRequest({ headers, id: requestId });
  const requestBody: any = rawRequestBody || (body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"));
  const handled: any = await router.handleOperationPermissionHttpRequest({
    request,
    response,
    requestBody,
    url: createUrl(path),
    method
  });
  return { handled, request, response };
}

beforeEach(() : any => {
  sendJsonMock.mockClear();
  summarizeErrorMock.mockClear();
  summarizeForLogMock.mockClear();
  getRuntimeLoggerMock.mockClear();
});

describe("operation permission http behavior", () : any => {
  it("keeps the safe layered outcome while redacting every continuation identifier", async () : Promise<any> => {
    const pending: any = rowToPendingOperation({
      pending_operation_id: "custom-current-layer",
      trace_id: "trace-private",
      tool_execution_id: "tool-execution-private",
      tool_id: "known.tool",
      tool_version: "1.0.0",
      toolset_ids_json: "[]",
      operation_id: "operation.safe",
      risk: "safe_write",
      approval_scope: "approval:safe",
      approval_requirements_json: "{}",
      approval_layers_json: "[\"department\"]",
      grant_id: "custom-grant-private",
      agent_id: "custom-agent-private",
      profile_id: "custom-profile-private",
      idempotency_key: "private-idempotency",
      reason_code: "team_approval_required",
      risk_reason: "Synthetic reason",
      redacted_input_json: "{}",
      context_json: "{}",
      status: "completed",
      result_summary_json: JSON.stringify({
        type: "object",
        executionOutcome: "continued_pending_approval",
        continuedPendingOperationId: "custom-next-layer"
      }),
      error_code: "",
      resolved_by: "custom-approver-private",
      resolution_reason: "approved",
      resumed_tool_execution_id: "custom-resume-private",
      source_ip: "192.0.2.1",
      user_agent: "private-agent",
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      resolved_at: "2026-01-01T00:01:00.000Z",
      completed_at: "2026-01-01T00:01:00.000Z"
    });
    const platform: any = createPlatform({
      store: {
        listPendingOperations: vi.fn(() : any => [pending])
      }
    });
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: true,
        session: { user: { userId: "user-a", roleId: "role-a" } }
      }))
    };
    const router: any = createOperationPermissionHttpRouter({
      platform,
      securityPermissions,
      logger: getRuntimeLoggerMock()
    });

    await callRouter(router, {
      path: "/api/operation-permission/v1/pending-operations?status=all"
    });
    const response: any = sendJsonMock.mock.calls.at(-1)?.[2];
    const publicPending: any = response.pendingOperations[0];

    expect(publicPending.executionOutcome).toBe("continued_pending_approval");
    expect(publicPending.toolLabel).toBe("Known");
    expect(publicPending.resultSummary).toMatchObject({
      executionOutcome: "continued_pending_approval",
      continuedPendingOperationId: "[redacted]"
    });
    expect(publicPending).toMatchObject({
      traceId: "[redacted]",
      toolExecutionId: "[redacted]",
      grantId: "[redacted]",
      agentId: "[redacted]",
      profileId: "[redacted]",
      resumedToolExecutionId: "[redacted]",
      resolvedBy: "[redacted]"
    });
    expect(JSON.stringify(publicPending)).not.toContain("custom-next-layer");
  });

  it("covers read-side catalog, profile, policy, audit, metrics, event, and pending routes", async () : Promise<any> => {
    const platform: any = createPlatform();
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: true,
        session: { user: { userId: "user-a", roleId: "role-a" } }
      }))
    };
    const router: any = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: getRuntimeLoggerMock() });

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
    const prometheus: any = await callRouter(router, { path: "/api/operation-permission/v1/metrics/prometheus?windowSeconds=12" });
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
    expect(platform.registry.getTool).toHaveBeenCalledWith("known.tool");
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.any(Object), 200, {
      schemaVersion: "v0.0.1:schema:definition-1",
      pendingOperations: [
        expect.objectContaining({
          pendingOperationId: "pending_op_visible_123",
          toolId: "known.tool",
          toolLabel: "Known",
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

  it("covers write route 404s, confirmed mutations, pending resolve, route misses, and thrown parser errors", async () : Promise<any> => {
    const platform: any = createPlatform();
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: true,
        session: { user: { userId: "test-user", roleId: "test-role" } }
      }))
    };
    const router: any = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: getRuntimeLoggerMock() });
    const confirmed: Record<string, any> = { "x-meshrix-safety-confirm": "true" };

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

  it("returns early for authorized route families when console authorization is denied", async () : Promise<any> => {
    const platform: any = createPlatform();
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: false,
        status: 403,
        error: "denied"
      }))
    };
    const router: any = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: getRuntimeLoggerMock() });
    const routes: any[] = [
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
      const result: any = await callRouter(router, route);
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

  it("covers no-op logger, empty JSON payloads, and unavailable pending runtime", async () : Promise<any> => {
    const platform: any = createPlatform({
      runtime: {
        resumePendingOperation: null
      }
    });
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: true,
        session: { user: { userId: "test-user", roleId: "test-role" } }
      }))
    };
    const router: any = createOperationPermissionHttpRouter({ platform, securityPermissions, logger: null });
    const confirmed: Record<string, any> = { "x-meshrix-safety-confirm": "yes" };

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
