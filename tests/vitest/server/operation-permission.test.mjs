import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "@lico/foundation/serialization/canonical-json";

const sendJsonMock = vi.hoisted(() => vi.fn((response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}));
const dispatchOperationMock = vi.hoisted(() => vi.fn(async ({ response }) => {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    result: { ok: true }
  }));
  return { ok: true };
}));
const summarizeErrorMock = vi.hoisted(() => vi.fn((error) => ({
  name: error?.name || "Error",
  message: error?.message || String(error || "")
})));
const summarizeForLogMock = vi.hoisted(() => vi.fn((value) => value));
const getRuntimeLoggerMock = vi.hoisted(() => vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})));
const traceContextFromRequestMock = vi.hoisted(() => vi.fn(() => ({
  traceId: "trace-request"
})));

vi.mock("@lico/foundation/observability/runtime-logger", () => ({
  getRuntimeLogger: getRuntimeLoggerMock,
  summarizeError: summarizeErrorMock,
  summarizeForLog: summarizeForLogMock
}));

vi.mock("@lico/foundation/observability/trace-context", () => ({
  traceContextFromRequest: traceContextFromRequestMock
}));

vi.mock("@lico/protocols/http/http-utils", () => ({
  sendJson: sendJsonMock
}));

import { createOperationPermissionHttpRouter } from "../../../packages/capabilities/src/operation-permission-core/http.mjs";
import { createToolExecutionRuntime } from "../../../packages/capabilities/src/operation-permission-core/runtime.mjs";
import { pendingResumeInput } from "../../../packages/capabilities/src/operation-permission-core/runtime-common.mjs";
import {
  createOperationPermissionStore,
  getOperationPermissionDatabasePath
} from "../../../packages/capabilities/src/operation-permission-core/store.mjs";
import {
  hashLocalMcpAuthorizationClaim,
  openLocalMcpAuthorizationReplay,
  sealLocalMcpAuthorizationReplay
} from "../../../packages/capabilities/src/skills/tool-skill-management-provider-local-mcp.mjs";

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

function createRequest({ headers = {}, id = "req-1" } = {}) {
  return {
    __licoRequestId: id,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function createUrl(pathname) {
  return new URL(pathname, "http://127.0.0.1");
}

function createRuntimeFixture(overrides = {}) {
  const operation = {
    id: "operation.alpha",
    http: {
      method: "POST",
      path: "/tool/:id",
      params: [{ name: "id" }]
    },
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" }
      }
    },
    safety: {
      approvalScope: "approval:alpha"
    }
  };

  const grant = {
    id: "grant-1",
    label: "Grant 1",
    scopes: ["tool:run"],
    capabilities: [],
    enabled: true,
    revokedAt: "",
    projectionFingerprint: "sha256:fixture-grant-projection",
    policyIntegrity: { valid: true }
  };

  const tool = {
    id: "tool.alpha",
    operationId: operation.id,
    version: "1.0.0",
    toolsets: ["toolset-1"],
    requiredScopes: ["tool:run"],
    risk: "low",
    timeoutMs: 1000,
    maxResultBytes: 1024,
    concurrencySafe: true,
    requiresApproval: false,
    approvalScope: "",
    transport: {}
  };
  Object.assign(tool, overrides.tool || {});

  const store = {
    authorizeRequest: vi.fn(async () => ({
      ok: true,
      grant,
      sourceIp: "127.0.0.1"
    })),
    appendExecution: vi.fn(),
    appendMetric: vi.fn(),
    appendPolicyDecision: vi.fn(),
    createPendingOperation: vi.fn((entry) => ({
      pendingOperationId: "pending-1",
      status: "pending",
      traceId: entry.traceId,
      toolId: entry.toolId,
      grantId: entry.grantId,
      originalInput: entry.originalInput,
      context: entry.context,
      requiredApproval: entry.requiredApproval || {},
      approvalLayers: entry.approvalLayers || []
    })),
    getPendingOperation: vi.fn(),
    resolvePendingOperation: vi.fn(),
    getGrant: vi.fn(() => grant),
    getRawGrant: vi.fn(() => grant)
  };
  Object.assign(store, overrides.store || {});

  const registry = {
    getTool: vi.fn(() => tool),
    listProfiles: vi.fn(() => []),
    ...overrides.registry
  };

  const policyEngine = {
    evaluate: vi.fn(() => ({
      effect: "allow",
      decisionId: "policy-1",
      reasonCode: "",
      redactedReason: "",
      missingScopes: [],
      missingCapabilities: [],
      missingToolsets: [],
      grantPolicyRevision: 1,
      grantPolicyState: "active",
      governancePolicyRevision: {
        protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
        revision: 1,
        updatedAt: "2026-06-05T00:00:00.000Z"
      }
    })),
    ...overrides.policyEngine
  };

  const securityPermissions = {
    appendDecision: vi.fn(),
    upsertGovernanceApproval: vi.fn(),
    revokeGovernanceApproval: vi.fn(),
    ...overrides.securityPermissions
  };

  const runtime = createToolExecutionRuntime({
    registry,
    store,
    policyEngine,
    operations: [operation],
    operationDispatcher: dispatchOperationMock,
    securityPermissions,
    protocolEventBus: { publish: vi.fn(async () => undefined) },
    logger: getRuntimeLoggerMock(),
    ...overrides.runtime
  });

  return {
    runtime,
    store,
    registry,
    policyEngine,
    securityPermissions,
    operation,
    tool,
    grant
  };
}

function createPlatform(overrides = {}) {
  const runtime = {
    executeTool: vi.fn(async () => ({
      status: 200,
      payload: { schemaVersion: "v0.0.1:schema:definition-1", result: { ok: true } }
    })),
    resumePendingOperation: vi.fn(async () => ({
      status: 200,
      payload: { schemaVersion: "v0.0.1:schema:definition-1", status: "completed" }
    })),
    ...overrides.runtime
  };

  const platform = {
    catalog: vi.fn(() => ({ schemaVersion: "v0.0.1:schema:definition-1", catalog: true })),
    registry: {
      getTool: vi.fn(() => ({ id: "tool.alpha" })),
      getToolByOperationId: vi.fn(() => ({ id: "tool.alpha" })),
      listToolsets: vi.fn(() => [{ id: "toolset-1" }]),
      resolveToolset: vi.fn((payload) => ({ resolved: true, payload })),
      listProfiles: vi.fn(() => [{ id: "profile-1" }])
    },
    runtime,
    store: {
      listGrants: vi.fn(() => [{ id: "grant-1" }]),
      createGrant: vi.fn(async (payload) => ({ grant: { id: "grant-new", ...payload }, token: "token-new" })),
      rotateGrantToken: vi.fn(async (grantId) => ({ grant: { id: grantId }, token: "token-rotated" })),
      revokeGrant: vi.fn(async (grantId, reason) => ({ id: grantId, revoked: true, reason })),
      updateGrant: vi.fn((grantId, payload) => ({ id: grantId, updated: payload })),
      listAudit: vi.fn(() => [{ id: "audit-1" }]),
      getAudit: vi.fn((toolExecutionId) => ({ id: toolExecutionId })),
      metricsSummary: vi.fn(() => ({ checked: true })),
      metricsExport: vi.fn(() => ({ checked: true })),
      metricsHealth: vi.fn(() => ({ checked: true })),
      metricsPrometheus: vi.fn(() => "metric 1"),
      metricsStorageSummary: vi.fn(() => ({ checked: true })),
      pruneMetrics: vi.fn(() => ({ checked: true })),
      listPendingOperations: vi.fn(() => [{ id: "pending-1" }])
    },
    policyEngine: {
      preview: vi.fn((payload) => ({ effect: "allow", payload }))
    }
  };

  return Object.assign(platform, overrides, {
    runtime: { ...platform.runtime, ...(overrides.runtime || {}) },
    registry: { ...platform.registry, ...(overrides.registry || {}) },
    store: { ...platform.store, ...(overrides.store || {}) }
  });
}

async function callRouter(router, {
  method = "GET",
  path: requestPath,
  body = null,
  headers = {},
  requestId = "req-1",
  signal = null
}) {
  const response = createResponse();
  const request = createRequest({ headers, id: requestId });
  const requestBody = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const handled = await router.handleOperationPermissionHttpRequest({
    request,
    response,
    requestBody,
    url: createUrl(requestPath),
    method,
    signal
  });
  return { handled, request, response, requestBody };
}

async function withTempUserDataPath(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-operation-permission-more-extra-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { force: true, recursive: true });
  }
}

function createGovernanceRequiredApproval(overrides = {}) {
  const approvalLayers = overrides.approvalLayers ?? ["department"];
  return {
    userId: "console-user-1",
    agentId: "agent-codex",
    resourceType: "repo",
    resourceId: "owner/repo",
    actions: ["repo:write"],
    targetProviders: ["github"],
    teamIds: ["team-code"],
    departmentIds: ["department-platform"],
    grantKinds: ["once", "timed"],
    operationBinding: operationBindingForTest({
      resourceType: "repo",
      resourceId: "owner/repo"
    }),
    ...overrides,
    approvalLayers
  };
}

function operationBindingForTest(resource = {}, operationId = "operation.alpha") {
  const core = {
      schemaVersion: "v0.0.1:operation-permission:approval-operation-binding-1",
      operationId,
      upstreamProjection: {
        sourceRevision: 0,
        sourceDigest: "",
        serviceId: "",
        operationKey: "",
        upstreamToolName: "",
        capabilityDigest: ""
      },
      resource: {
        workspaceId: String(resource.workspaceId || ""),
        targetWorkspaceId: String(resource.targetWorkspaceId || ""),
        resourceType: String(resource.resourceType || ""),
        resourceId: String(resource.resourceId || ""),
        proposalRef: String(resource.proposalRef || ""),
        previewDigest: String(resource.previewDigest || ""),
        outputDigest: String(resource.outputDigest || ""),
        policyDigest: String(resource.policyDigest || "")
      },
      policyRevision: { grantPolicyRevision: 1, governancePolicyRevision: 1 }
  };
  return {
    ...core,
    bindingDigest: canonicalHash(core)
  };
}

function createGovernancePendingRecord(requiredApproval, overrides = {}) {
  return {
    pendingOperationId: "pending-governance-1",
    status: "pending",
    traceId: "trace-request",
    toolId: "tool.alpha",
    grantId: "grant-1",
    profileId: "profile-1",
    context: { transport: "mcp" },
    originalInput: {
      name: "alpha",
      resourceType: "repo",
      resourceId: "owner/repo",
      requestedAction: "repo:write",
      targetProvider: "github"
    },
    risk: "repair_write",
    toolVersion: "1.0.0",
    toolsetIds: ["toolset-1"],
    operationId: "operation.alpha",
    requiredApproval,
    approvalLayers: requiredApproval.approvalLayers || [],
    ...overrides
  };
}

function createEligibleApprover(overrides = {}) {
  return {
    userId: "console-user-1",
    username: "Console User",
    roleId: "admin",
    scopes: ["runtime:admin"],
    teamIds: ["team-code"],
    departmentIds: ["department-platform"],
    ...overrides
  };
}

beforeEach(() => {
  sendJsonMock.mockClear();
  dispatchOperationMock.mockClear();
  summarizeErrorMock.mockClear();
  summarizeForLogMock.mockClear();
  getRuntimeLoggerMock.mockClear();
  traceContextFromRequestMock.mockClear();
});

describe("native MCP device authorization store", () => {
  it("keeps claim material private and atomically consumes one approved request", async () => {
    await withTempUserDataPath(async (userDataPath) => {
      const store = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      try {
        const claimToken = "store_retry_claim_abcdefghijklmnopqrstuvwxyz";
        const claimTokenHash = hashLocalMcpAuthorizationClaim(claimToken);
        const created = store.createMcpAuthorizationRequest({
          request: { socket: { remoteAddress: "127.0.0.1" }, headers: {} },
          clientName: "Local MCP client",
          requestKind: "local_mcp_install",
          requestPayload: {
            body: { targets: ["codex"], processIdentities: { codex: { processPublicKeyPem: "public-key" } } },
            summary: {
              targets: ["codex"],
              toolsets: ["lico.runtime.read"],
              maxRisk: "read_only",
              processKeyFingerprints: [{ target: "codex", fingerprint: "sha256:fingerprint" }]
            }
          },
          claimTokenHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        const publicRequest = store.listMcpAuthorizationRequests({ status: "pending" })[0];

        expect(publicRequest).toMatchObject({
          requestId: created.requestId,
          requestKind: "local_mcp_install",
          targets: ["codex"],
          maxRisk: "read_only"
        });
        expect(publicRequest).not.toHaveProperty("requestPayload");
        expect(JSON.stringify(publicRequest)).not.toContain("public-key");
        expect(JSON.stringify(publicRequest)).not.toContain(claimTokenHash);

        expect(store.resolveMcpAuthorizationRequest({
          requestId: created.requestId,
          resolution: "approved",
          resolvedBy: "owner"
        })).toBe(true);
        expect(store.resolveMcpAuthorizationRequest({
          requestId: created.requestId,
          resolution: "approved",
          resolvedBy: "other"
        })).toBe(false);
        expect(store.claimMcpAuthorizationRequest({
          requestId: created.requestId,
          claimTokenHash: "b".repeat(64)
        })).toMatchObject({ claimed: false, status: "not_found" });

        const claimed = store.claimMcpAuthorizationRequest({
          requestId: created.requestId,
          claimTokenHash
        });
        expect(claimed).toMatchObject({
          claimed: true,
          status: "issuing",
          request: {
            resolvedBy: "owner",
            requestPayload: { body: { targets: ["codex"] } }
          }
        });
        expect(store.claimMcpAuthorizationRequest({
          requestId: created.requestId,
          claimTokenHash
        })).toMatchObject({ claimed: false, status: "issuing" });
        const replayResponse = {
          status: 201,
          body: {
            authorizationRequestId: created.requestId,
            token: "sensitive-retry-token"
          }
        };
        const replayEnvelope = sealLocalMcpAuthorizationReplay({
          claimToken,
          requestId: created.requestId,
          response: replayResponse
        });
        const replayExpiresAt = new Date(Date.now() + 60_000).toISOString();
        expect(store.completeMcpAuthorizationRequest({
          requestId: created.requestId,
          status: "consumed",
          grantIds: ["grant-1"],
          replayEnvelope,
          replayExpiresAt
        })).toBe(true);
        expect(store.completeMcpAuthorizationRequest({
          requestId: created.requestId,
          status: "consumed",
          grantIds: ["grant-2"],
          replayEnvelope,
          replayExpiresAt
        })).toBe(false);
        expect(store.getMcpAuthorizationRequest(created.requestId)).toMatchObject({
          status: "consumed",
          grantId: "grant-1",
          grantIds: ["grant-1"]
        });
        expect(store.getMcpAuthorizationRequest(created.requestId)).not.toHaveProperty("replayEnvelope");
        const replayClaim = store.claimMcpAuthorizationRequest({
          requestId: created.requestId,
          claimTokenHash
        });
        expect(replayClaim).toMatchObject({
          claimed: false,
          replayable: true,
          status: "consumed"
        });
        expect(openLocalMcpAuthorizationReplay({
          claimToken,
          requestId: created.requestId,
          envelope: replayClaim.request.replayEnvelope
        })).toEqual(replayResponse);
        const storedReplay = store.db.prepare(`
          SELECT replay_envelope_json
          FROM mcp_authorization_requests
          WHERE request_id = ?
        `).get(created.requestId).replay_envelope_json;
        expect(storedReplay).not.toContain("sensitive-retry-token");
        store.db.prepare(`
          UPDATE mcp_authorization_requests
          SET replay_expires_at = ?
          WHERE request_id = ?
        `).run(new Date(Date.now() - 1_000).toISOString(), created.requestId);
        expect(store.claimMcpAuthorizationRequest({
          requestId: created.requestId,
          claimTokenHash
        })).toMatchObject({ claimed: false, status: "consumed" });
        expect(store.db.prepare(`
          SELECT replay_envelope_json
          FROM mcp_authorization_requests
          WHERE request_id = ?
        `).get(created.requestId).replay_envelope_json).toBe("");
      } finally {
        store.close();
      }
    });
  });

  it("expires pending requests, recovers stale issue leases, and bounds active requests per source", async () => {
    await withTempUserDataPath(async (userDataPath) => {
      const store = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
      try {
        const expired = store.createMcpAuthorizationRequest({
          request,
          requestKind: "local_mcp_install",
          requestPayload: { summary: {} },
          claimTokenHash: "c".repeat(64),
          expiresAt: new Date(Date.now() - 1_000).toISOString()
        });
        expect(store.getMcpAuthorizationRequest(expired.requestId).status).toBe("expired");

        const leased = store.createMcpAuthorizationRequest({
          request,
          requestKind: "local_mcp_install",
          requestPayload: { summary: {} },
          claimTokenHash: "d".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        expect(store.resolveMcpAuthorizationRequest({
          requestId: leased.requestId,
          resolution: "approved"
        })).toBe(true);
        expect(store.claimMcpAuthorizationRequest({
          requestId: leased.requestId,
          claimTokenHash: "d".repeat(64)
        }).claimed).toBe(true);
        store.db.prepare("UPDATE mcp_authorization_requests SET issuing_at = ? WHERE request_id = ?")
          .run(new Date(Date.now() - 16 * 60 * 1000).toISOString(), leased.requestId);
        expect(store.getMcpAuthorizationRequest(leased.requestId)).toMatchObject({
          status: "failed",
          errorCode: "authorization_issue_interrupted"
        });

        for (let index = 0; index < 16; index += 1) {
          store.createMcpAuthorizationRequest({
            request,
            requestKind: "local_mcp_install",
            requestPayload: { summary: {} },
            claimTokenHash: String(index).padStart(64, "0"),
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          });
        }
        expect(() => store.createMcpAuthorizationRequest({
          request,
          requestKind: "local_mcp_install",
          requestPayload: { summary: {} },
          claimTokenHash: "e".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })).toThrow("local_mcp_authorization_capacity_exceeded");
      } finally {
        store.close();
      }
    });
  });

  it("bounds native MCP authorization payload bytes before row quotas can exhaust storage", async () => {
    await withTempUserDataPath(async (userDataPath) => {
      const store = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
      try {
        expect(() => store.createMcpAuthorizationRequest({
          request,
          requestKind: "local_mcp_install",
          requestPayload: { padding: "x".repeat(70 * 1024) },
          claimTokenHash: "a".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })).toThrow("local_mcp_authorization_payload_too_large");

        for (let index = 0; index < 8; index += 1) {
          store.createMcpAuthorizationRequest({
            request,
            requestKind: "local_mcp_install",
            requestPayload: { padding: "x".repeat(60 * 1024) },
            claimTokenHash: String(index).padStart(64, "b"),
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          });
        }
        expect(() => store.createMcpAuthorizationRequest({
          request,
          requestKind: "local_mcp_install",
          requestPayload: { padding: "x".repeat(60 * 1024) },
          claimTokenHash: "c".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })).toThrow("local_mcp_authorization_capacity_exceeded");
        expect(store.listMcpAuthorizationRequests({ status: "pending" })).toHaveLength(8);
      } finally {
        store.close();
      }
    });
  });
});

describe("operation-permission runtime (behavior)", () => {
  it("preserves opaque secret-reference arrays without persisting secret material", () => {
    expect(pendingResumeInput({
      capabilities: {
        secretRefs: ["secret-ref:scanner"],
        "secret-refs": []
      },
      apiKey: "sensitive-value"
    }, "sample_plugin.scan")).toEqual({
      capabilities: {
        secretRefs: ["secret-ref:scanner"],
        "secret-refs": []
      },
      apiKey: "<redacted>"
    });
  });
  it("passes the HTTP parent signal into tool execution", async () => {
    const platform = createPlatform();
    const router = createOperationPermissionHttpRouter({
      platform,
      logger: getRuntimeLoggerMock()
    });
    const controller = new AbortController();

    await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/execute",
      body: { toolId: "tool.alpha", input: { name: "alpha" } },
      signal: controller.signal
    });

    expect(platform.runtime.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal
    }));
  });

  it("aborts timed-out dispatch and waits for dispatcher settlement before returning", async () => {
    let observeAbort;
    const aborted = new Promise((resolve) => {
      observeAbort = resolve;
    });
    let settleDispatch;
    const dispatchSettled = new Promise((resolve) => {
      settleDispatch = resolve;
    });
    const operationDispatcher = vi.fn(async ({ signal }) => {
      signal.addEventListener("abort", observeAbort, { once: true });
      await dispatchSettled;
    });
    const fixture = createRuntimeFixture({
      tool: { timeoutMs: 10 },
      runtime: { operationDispatcher }
    });
    let executionSettled = false;

    const execution = fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    }).then((result) => {
      executionSettled = true;
      return result;
    });

    await aborted;
    expect(executionSettled).toBe(false);
    settleDispatch();
    const result = await execution;

    expect(operationDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      payload: {
        error: {
          code: "tool_timeout",
          message: "Tool execution timed out after 10ms."
        }
      }
    });
  });

  it("propagates a parent request abort and still waits for nested dispatch settlement", async () => {
    let observeDispatch;
    const dispatchStarted = new Promise((resolve) => {
      observeDispatch = resolve;
    });
    let observeAbort;
    const aborted = new Promise((resolve) => {
      observeAbort = resolve;
    });
    let settleDispatch;
    const dispatchSettled = new Promise((resolve) => {
      settleDispatch = resolve;
    });
    const operationDispatcher = vi.fn(async ({ signal }) => {
      signal.addEventListener("abort", observeAbort, { once: true });
      observeDispatch();
      await dispatchSettled;
    });
    const fixture = createRuntimeFixture({
      tool: { timeoutMs: 5_000 },
      runtime: { operationDispatcher }
    });
    const controller = new AbortController();
    let executionSettled = false;
    const execution = fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      signal: controller.signal
    }).then((result) => {
      executionSettled = true;
      return result;
    });

    await dispatchStarted;
    controller.abort(new Error("private request detail"));
    await aborted;
    expect(executionSettled).toBe(false);
    settleDispatch();

    await expect(execution).resolves.toMatchObject({
      ok: false,
      status: 499,
      payload: {
        error: {
          code: "tool_aborted",
          message: "Tool execution was cancelled."
        }
      }
    });
  });

  it("refreshes operations and moves from operation-missing to a successful dry run", async () => {
    const fixture = createRuntimeFixture({
      runtime: {
        operations: []
      }
    });

    const first = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(first.ok).toBe(false);
    expect(first.status).toBe(500);
    expect(first.payload.error.code).toBe("operation_missing");
    expect(fixture.store.authorizeRequest).not.toHaveBeenCalled();

    const refreshed = fixture.runtime.refreshOperations([fixture.operation]);
    expect(refreshed).toEqual({ ok: true, operationCount: 1 });

    const second = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      dryRun: true
    });

    expect(second.ok).toBe(true);
    expect(second.status).toBe(200);
    expect(second.payload.status).toBe("ok");
    expect(second.payload.result.wouldExecute).toBe(true);
    expect(fixture.store.authorizeRequest).toHaveBeenCalledTimes(1);
  });

  it("returns authorization denial details and records the authorization decision", async () => {
    const fixture = createRuntimeFixture({
      store: {
        authorizeRequest: vi.fn(async () => ({
          ok: false,
          status: 401,
          reasonCode: "missing_token",
          error: "缺少工具访问令牌。",
          missingScopes: ["tool:run"],
          missingCapabilities: ["cap:operation-permission:tool.alpha:execute"],
          grant: { id: "grant-1", label: "Grant 1", scopes: [] }
        }))
      }
    });

    const result = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.payload.error).toMatchObject({
      code: "missing_token",
      message: "缺少工具访问令牌。",
      details: {
        missingScopes: ["tool:run"],
        missingCapabilities: ["cap:operation-permission:tool.alpha:execute"]
      }
    });
    expect(fixture.store.appendPolicyDecision).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "missing_token",
      effect: "deny"
    }));
    expect(fixture.securityPermissions.appendDecision).toHaveBeenCalledWith(expect.objectContaining({
      protocolVersion: "v0.0.1:risk-control:authorization-1",
      effect: "deny",
      redactedReason: "缺少工具访问令牌。",
      resource: expect.objectContaining({
        toolId: fixture.tool.id,
        operationId: fixture.operation.id
      })
    }));
    expect(fixture.store.appendExecution).toHaveBeenCalledWith(expect.objectContaining({
      status: "denied",
      errorCode: "missing_token"
    }));
    expect(fixture.store.appendMetric).toHaveBeenCalledWith(expect.objectContaining({
      status: "denied",
      reasonCode: "missing_token"
    }));
  });

  it("returns a policy confirmation response when the policy requires confirmation", async () => {
    const fixture = createRuntimeFixture({
      policyEngine: {
        evaluate: vi.fn(() => ({
          effect: "require_confirmation",
          decisionId: "policy-confirm",
          reasonCode: "confirmation_required",
          redactedReason: "Tool requires confirmation.",
          missingScopes: ["tool:run"],
          missingCapabilities: [],
          missingToolsets: [],
          grantPolicyRevision: 2,
          grantPolicyState: "active",
          governancePolicyRevision: {
            protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
            revision: 2,
            updatedAt: "2026-06-05T00:00:00.000Z"
          }
        }))
      }
    });

    const result = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.payload.error).toMatchObject({
      code: "confirmation_required",
      message: "Tool requires confirmation.",
      details: {
        decisionId: "policy-confirm",
        missingScopes: ["tool:run"],
        missingCapabilities: [],
        missingToolsets: []
      }
    });
    expect(fixture.store.appendPolicyDecision).not.toHaveBeenCalled();
    expect(fixture.store.appendExecution).toHaveBeenCalledWith(expect.objectContaining({
      status: "denied",
      errorCode: "confirmation_required"
    }));
  });

  it("creates and resumes pending operations through the runtime", async () => {
    const pendingRecord = {
      pendingOperationId: "pending-1",
      status: "pending",
      traceId: "trace-request",
      toolId: "tool.alpha",
      grantId: "grant-1",
      profileId: "profile-1",
      context: {
        transport: "mcp",
        traceId: "trace-request"
      },
      originalInput: {
        name: "alpha",
        workspaceId: "workspace-source",
        targetWorkspaceId: "workspace-target"
      },
      risk: "low",
      toolVersion: "1.0.0",
      toolsetIds: ["toolset-1"],
      operationId: "operation.alpha",
      expiresAt: "2099-01-01T00:00:00.000Z",
      requiredApproval: {
        operationBinding: operationBindingForTest({
          workspaceId: "workspace-source",
          targetWorkspaceId: "workspace-target"
        })
      },
      sourceIp: "127.0.0.1",
      userAgent: "unit-test"
    };
    const fixture = createRuntimeFixture({
      tool: {
        requiresApproval: true
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry) => ({
      pendingOperationId: "pending-1",
      status: "pending",
      traceId: entry.traceId,
      toolId: entry.toolId,
      grantId: entry.grantId,
      profileId: entry.profileId,
      context: entry.context,
      originalInput: entry.originalInput,
      risk: entry.risk,
      toolVersion: entry.toolVersion,
      toolsetIds: entry.toolsetIds,
      operationId: entry.operationId,
      sourceIp: entry.sourceIp,
      userAgent: entry.userAgent
    }));
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }) => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const pendingResult = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: pendingRecord.originalInput,
      request: createRequest({ headers: { "user-agent": "unit-test" } }),
      context: { transport: "mcp" }
    });

    expect(pendingResult.ok).toBe(true);
    expect(pendingResult.status).toBe(202);
    expect(pendingResult.payload.status).toBe("pending_approval");
    expect(fixture.store.createPendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "tool_approval_required",
      originalInput: pendingRecord.originalInput
    }));

    let capturedAuthorization = null;
    dispatchOperationMock.mockImplementationOnce(async ({ request, response }) => {
      capturedAuthorization = JSON.parse(JSON.stringify(request.__licoToolRuntimeAuthorization));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        result: { ok: true }
      }));
      return { ok: true };
    });
    const resumed = await fixture.runtime.resumePendingOperation({
      pendingOperationId: "pending-1",
      request: createRequest({ headers: { "user-agent": "unit-test" } }),
      resolvedBy: "console",
      reason: "approved"
    });

    expect(resumed.ok).toBe(true);
    expect(resumed.status).toBe(200);
    expect(resumed.payload.pendingOperation.status).toBe("completed");
    expect(dispatchOperationMock).toHaveBeenCalled();
    expect(capturedAuthorization).toMatchObject({
      ok: true,
      grant: { id: "grant-1" },
      approvedPendingOperation: {
        pendingOperationId: "pending-1",
        operationId: "operation.alpha",
        status: "approved",
        expiresAt: "2099-01-01T00:00:00.000Z",
        grantId: "grant-1",
        actorId: "console",
        workspaceId: "workspace-source",
        targetWorkspaceId: "workspace-target",
        policyRevision: {
          grantPolicyRevision: expect.any(Number),
          governancePolicyRevision: expect.any(Number)
        }
      }
    });
    expect(fixture.store.resolvePendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      pendingOperationId: "pending-1",
      resolution: "approved"
    }));
    expect(fixture.store.resolvePendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      pendingOperationId: "pending-1",
      resolution: "completed"
    }));
  });

  it("rejects an approved pending operation when policy revision changed before resume", async () => {
    let pendingRecord = null;
    const policyDecision = (revision) => ({
      effect: "allow",
      decisionId: `policy-${revision}`,
      reasonCode: "",
      redactedReason: "",
      missingScopes: [],
      missingCapabilities: [],
      missingToolsets: [],
      grantPolicyRevision: revision,
      grantPolicyState: "active",
      governancePolicyRevision: {
        protocolVersion: "v0.0.1:risk-control:governance-policy-revision-1",
        revision,
        updatedAt: "2026-06-05T00:00:00.000Z"
      }
    });
    const fixture = createRuntimeFixture({
      tool: { requiresApproval: true },
      policyEngine: {
        evaluate: vi.fn()
          .mockReturnValueOnce(policyDecision(1))
          .mockReturnValueOnce(policyDecision(2))
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry) => {
      pendingRecord = {
        ...entry,
        pendingOperationId: "pending-policy-change",
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      return pendingRecord;
    });
    fixture.store.getPendingOperation.mockImplementation(() => pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }) => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const input = {
      name: "alpha",
      workspaceId: "workspace-source",
      targetWorkspaceId: "workspace-target"
    };
    const pending = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input,
      request: createRequest()
    });
    expect(pending.payload.status).toBe("pending_approval");
    expect(pendingRecord.requiredApproval.operationBinding.policyRevision).toEqual({
      grantPolicyRevision: 1,
      governancePolicyRevision: 1
    });

    const resumed = await fixture.runtime.resumePendingOperation({
      pendingOperationId: "pending-policy-change",
      request: createRequest(),
      resolvedBy: "console",
      reason: "approved"
    });
    expect(resumed.ok).toBe(false);
    expect(resumed.status).toBe(409);
    expect(resumed.payload.error.code).toBe("pending_approval_binding_stale");
    expect(dispatchOperationMock).not.toHaveBeenCalled();
  });

  it("rejects an approved pending upstream operation after its catalog source revision changes", async () => {
    let pendingRecord = null;
    const fixture = createRuntimeFixture({
      tool: {
        requiresApproval: true,
        sourceRevision: 1,
        sourceDigest: "source-one",
        serviceId: "service-a",
        operationKey: "tools/call"
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry) => {
      pendingRecord = {
        ...entry,
        pendingOperationId: "pending-source-change",
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      return pendingRecord;
    });
    fixture.store.getPendingOperation.mockImplementation(() => pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }) => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const pending = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });
    expect(pending.payload.status).toBe("pending_approval");
    fixture.tool.sourceRevision = 2;
    fixture.tool.sourceDigest = "source-two";

    const resumed = await fixture.runtime.resumePendingOperation({
      pendingOperationId: "pending-source-change",
      request: createRequest(),
      resolvedBy: "console",
      reason: "approved"
    });
    expect(resumed).toMatchObject({
      ok: false,
      status: 409,
      payload: { error: { code: "pending_approval_binding_stale" } }
    });
    expect(dispatchOperationMock).not.toHaveBeenCalled();
  });

  it("rejects handler-origin pending responses unless they are explicitly escalatable", async () => {
    dispatchOperationMock.mockImplementationOnce(async ({ response }) => {
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        status: "pending_approval",
        approval: { required: true }
      }));
      return { ok: true };
    });
    const fixture = createRuntimeFixture();

    const result = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.payload.error.code).toBe("handler_pending_not_escalatable");
    expect(fixture.store.createPendingOperation).not.toHaveBeenCalled();
    expect(fixture.store.appendExecution).toHaveBeenCalledWith(expect.objectContaining({
      status: "denied",
      errorCode: "handler_pending_not_escalatable"
    }));
  });

  it("binds escalatable handler pending responses to the runtime operation and ignores handler binding input", async () => {
    dispatchOperationMock.mockImplementationOnce(async ({ response }) => {
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        status: "pending_approval",
        escalatable: true,
        approval: { required: true, escalatable: true },
        requiredApproval: {
          operationBinding: { bindingDigest: "handler-controlled" }
        }
      }));
      return { ok: true };
    });
    const fixture = createRuntimeFixture();

    const result = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(fixture.store.createPendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      requiredApproval: expect.objectContaining({
        operationBinding: expect.objectContaining({
          schemaVersion: "v0.0.1:operation-permission:approval-operation-binding-1",
          operationId: fixture.operation.id,
          bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        })
      })
    }));
    const binding = fixture.store.createPendingOperation.mock.calls[0][0].requiredApproval.operationBinding;
    expect(binding.bindingDigest).not.toBe("handler-controlled");
  });

  it("projects governance needsApproval into pending operations and records the approved layer in governance", async () => {
    const requiredApproval = createGovernanceRequiredApproval({ approvalLayers: ["department"] });
    const pendingRecord = createGovernancePendingRecord(requiredApproval);
    const fixture = createRuntimeFixture({
      tool: { risk: "repair_write" },
      policyEngine: {
        evaluate: vi.fn()
          .mockReturnValueOnce({
            effect: "needsApproval",
            decisionId: "policy-department",
            reasonCode: "department_approval_required",
            redactedReason: "Department approval is required.",
            requiredApproval,
            missingScopes: [],
            missingCapabilities: [],
            missingToolsets: [],
            grantPolicyRevision: 1,
            grantPolicyState: "active",
            governancePolicyRevision: { revision: 1 }
          })
          .mockReturnValueOnce({
            effect: "allow",
            decisionId: "policy-allowed",
            reasonCode: "governance_allowed",
            redactedReason: "Request allowed.",
            missingScopes: [],
            missingCapabilities: [],
            missingToolsets: [],
            grantPolicyRevision: 1,
            grantPolicyState: "active",
            governancePolicyRevision: { revision: 1 }
          })
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry) => ({
      ...pendingRecord,
      pendingOperationId: "pending-governance-1",
      reasonCode: entry.reasonCode,
      requiredApproval: entry.requiredApproval,
      approvalLayers: entry.approvalLayers
    }));
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }) => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const pendingResult = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: pendingRecord.originalInput,
      request: createRequest()
    });

    expect(pendingResult.ok).toBe(true);
    expect(pendingResult.status).toBe(202);
    expect(fixture.store.createPendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "department_approval_required",
      requiredApproval,
      approvalLayers: ["department"]
    }));

    const resumed = await fixture.runtime.resumePendingOperation({
      pendingOperationId: "pending-governance-1",
      request: createRequest(),
      resolvedBy: "console-user-1",
      approver: createEligibleApprover(),
      reason: "department approved"
    });

    expect(resumed.ok).toBe(true);
    expect(fixture.securityPermissions.upsertGovernanceApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "pending-pending-governance-1",
      userId: "console-user-1",
      agentId: "agent-codex",
      resourceType: "repo",
      resourceId: "owner/repo",
      actions: ["repo:write"],
      targetProviders: ["github"],
      teamIds: ["team-code"],
      departmentIds: ["department-platform"],
      approvalLayers: ["department"],
      grantKind: "once",
      effect: "allow"
    }));
    expect(fixture.securityPermissions.revokeGovernanceApproval).toHaveBeenCalledWith(
      "pending-pending-governance-1",
      expect.stringContaining("Single-use approval consumed")
    );
    expect(dispatchOperationMock).toHaveBeenCalled();
    expect(resumed.payload.pendingOperation.status).toBe("completed");
  });

  it("rejects pending approval rows when approval layers exist only as a stored projection", async () => {
    const requiredApproval = createGovernanceRequiredApproval({ approvalLayers: [] });
    const pendingRecord = createGovernancePendingRecord(requiredApproval, {
      pendingOperationId: "pending-projection-only",
      approvalLayers: ["department"]
    });
    const fixture = createRuntimeFixture({ tool: { risk: "repair_write" } });
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);

    const resumed = await fixture.runtime.resumePendingOperation({
      pendingOperationId: "pending-projection-only",
      request: createRequest(),
      resolvedBy: "console-user-1",
      approver: createEligibleApprover(),
      reason: "projection only"
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.status).toBe(409);
    expect(resumed.payload.error).toMatchObject({
      code: "pending_approval_fact_mismatch",
      details: {
        approvalLayers: []
      }
    });
    expect(fixture.securityPermissions.upsertGovernanceApproval).not.toHaveBeenCalled();
    expect(fixture.store.resolvePendingOperation).not.toHaveBeenCalled();
    expect(fixture.store.getGrant).not.toHaveBeenCalled();
    expect(dispatchOperationMock).not.toHaveBeenCalled();
  });

  it("rejects governance approvals when the runtime admin is not eligible for the required layer", async () => {
    const cases = [
      {
        layer: "user",
        approver: createEligibleApprover({ userId: "runtime-admin-other" }),
        reasonCode: "user_approver_mismatch"
      },
      {
        layer: "team",
        approver: createEligibleApprover({ teamIds: ["team-other"] }),
        reasonCode: "team_approver_mismatch"
      },
      {
        layer: "department",
        approver: createEligibleApprover({ departmentIds: ["department-other"] }),
        reasonCode: "department_approver_mismatch"
      },
      {
        layer: "agent",
        approver: createEligibleApprover({ userId: "runtime-admin-other", agentId: "agent-other" }),
        reasonCode: "agent_approver_mismatch"
      }
    ];

    for (const testCase of cases) {
      dispatchOperationMock.mockClear();
      const requiredApproval = createGovernanceRequiredApproval({ approvalLayers: [testCase.layer] });
      const pendingRecord = createGovernancePendingRecord(requiredApproval, {
        pendingOperationId: `pending-${testCase.layer}`
      });
      const fixture = createRuntimeFixture({
        tool: { risk: "repair_write" },
        securityPermissions: {
          authorizationGovernanceStore: {
            getAgentBinding: vi.fn(() => null)
          }
        }
      });
      fixture.store.getPendingOperation.mockReturnValue(pendingRecord);

      const resumed = await fixture.runtime.resumePendingOperation({
        pendingOperationId: pendingRecord.pendingOperationId,
        request: createRequest(),
        resolvedBy: "runtime-admin",
        approver: testCase.approver,
        reason: "approve"
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.status).toBe(403);
      expect(resumed.payload.status).toBe("pending");
      expect(resumed.payload.error).toMatchObject({
        code: "pending_approval_approver_not_authorized",
        details: {
          reasonCode: testCase.reasonCode,
          deniedLayer: testCase.layer,
          approvalLayers: [testCase.layer]
        }
      });
      expect(fixture.securityPermissions.upsertGovernanceApproval).not.toHaveBeenCalled();
      expect(fixture.store.resolvePendingOperation).not.toHaveBeenCalled();
      expect(fixture.store.getGrant).not.toHaveBeenCalled();
      expect(dispatchOperationMock).not.toHaveBeenCalled();
    }
  });

  it("does not record governance approval when the original grant is unavailable", async () => {
    const activeGrantProjection = {
      id: "grant-1",
      enabled: true,
      revokedAt: "",
      projectionFingerprint: "sha256:fixture-grant-projection",
      policyIntegrity: { valid: true }
    };
    const cases = [
      { name: "missing", grant: null },
      { name: "projection-missing", grant: { ...activeGrantProjection, projectionFingerprint: "" } },
      { name: "policy-corrupt", grant: { ...activeGrantProjection, policyIntegrity: { valid: false } } },
      { name: "disabled", grant: { ...activeGrantProjection, enabled: false } },
      { name: "revoked", grant: { ...activeGrantProjection, revokedAt: "2026-06-05T00:00:00.000Z" } }
    ];

    for (const testCase of cases) {
      dispatchOperationMock.mockClear();
      const requiredApproval = createGovernanceRequiredApproval({ approvalLayers: ["department"] });
      const pendingRecord = createGovernancePendingRecord(requiredApproval, {
        pendingOperationId: `pending-grant-${testCase.name}`
      });
      const fixture = createRuntimeFixture({
        tool: { risk: "repair_write" },
        store: {
          getGrant: vi.fn(() => testCase.grant)
        }
      });
      fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
      fixture.store.resolvePendingOperation.mockImplementation(({ resolution, errorCode = "" }) => ({
        ...pendingRecord,
        status: resolution,
        errorCode,
        resolvedAt: "2026-06-05T00:00:00.000Z"
      }));

      const resumed = await fixture.runtime.resumePendingOperation({
        pendingOperationId: pendingRecord.pendingOperationId,
        request: createRequest(),
        resolvedBy: "console-user-1",
        approver: createEligibleApprover(),
        reason: "department approved"
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.status).toBe(409);
      expect(resumed.payload.error.code).toBe("pending_operation_grant_unavailable");
      expect(fixture.securityPermissions.upsertGovernanceApproval).not.toHaveBeenCalled();
      expect(dispatchOperationMock).not.toHaveBeenCalled();
      expect(fixture.store.resolvePendingOperation.mock.calls.map(([entry]) => entry.resolution)).toEqual(["failed"]);
    }
  });

  it("continues layered governance approval by creating the next pending operation after a prior layer is approved", async () => {
    const departmentApproval = createGovernanceRequiredApproval({
      approvalLayers: ["department"],
      grantKinds: ["once"]
    });
    const teamApproval = {
      ...departmentApproval,
      approvalLayers: ["team"]
    };
    const pendingRecord = {
      pendingOperationId: "pending-department",
      status: "pending",
      traceId: "trace-request",
      toolId: "tool.alpha",
      grantId: "grant-1",
      profileId: "profile-1",
      context: { transport: "mcp" },
      originalInput: {
        name: "alpha",
        resourceType: "repo",
        resourceId: "owner/repo",
        requestedAction: "repo:write",
        targetProvider: "github"
      },
      risk: "repair_write",
      toolVersion: "1.0.0",
      toolsetIds: ["toolset-1"],
      operationId: "operation.alpha",
      requiredApproval: departmentApproval,
      approvalLayers: ["department"]
    };
    const fixture = createRuntimeFixture({
      tool: { risk: "repair_write" },
      policyEngine: {
        evaluate: vi.fn(() => ({
          effect: "needsApproval",
          decisionId: "policy-team",
          reasonCode: "team_approval_required",
          redactedReason: "Team approval is required.",
          requiredApproval: teamApproval,
          missingScopes: [],
          missingCapabilities: [],
          missingToolsets: [],
          grantPolicyRevision: 1,
          grantPolicyState: "active",
          governancePolicyRevision: { revision: 1 }
        }))
      }
    });
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }) => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));
    fixture.store.createPendingOperation.mockImplementation((entry) => ({
      ...pendingRecord,
      pendingOperationId: "pending-team",
      status: "pending",
      reasonCode: entry.reasonCode,
      requiredApproval: entry.requiredApproval,
      approvalLayers: entry.approvalLayers
    }));

    const resumed = await fixture.runtime.resumePendingOperation({
      pendingOperationId: "pending-department",
      request: createRequest(),
      resolvedBy: "console-user-1",
      approver: createEligibleApprover(),
      reason: "department approved"
    });

    expect(resumed.ok).toBe(true);
    expect(resumed.status).toBe(202);
    expect(resumed.payload.status).toBe("pending_approval");
    expect(resumed.payload.pendingOperation).toMatchObject({
      pendingOperationId: "pending-team",
      reasonCode: "team_approval_required",
      approvalLayers: ["team"]
    });
    expect(fixture.store.createPendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "team_approval_required",
      requiredApproval: teamApproval,
      approvalLayers: ["team"]
    }));
    expect(fixture.store.resolvePendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      pendingOperationId: "pending-department",
      resolution: "completed"
    }));
  });
});

describe("operation-permission http router (behavior)", () => {
  it("returns a 404 for unknown operation-permission routes", async () => {
    const platform = createPlatform();
    const router = createOperationPermissionHttpRouter({ platform, logger: getRuntimeLoggerMock() });

    const result = await callRouter(router, {
      method: "GET",
      path: "/api/operation-permission/v1/not-a-route"
    });

    expect(result.handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(result.response, 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: {
        code: "operation_permission_route_not_found",
        message: "Operation Permission route not found.",
        details: { path: "/not-a-route" }
      }
    });
  });

  it("returns a 404 when a catalog tool is missing", async () => {
    const platform = createPlatform({
      registry: {
        getTool: vi.fn(() => null)
      }
    });
    const securityPermissions = {
      authorizeOperation: vi.fn(async () => ({
        ok: true,
        session: { user: { userId: "test-user", roleId: "test-role" } }
      }))
    };
    const router = createOperationPermissionHttpRouter({
      platform,
      securityPermissions,
      logger: getRuntimeLoggerMock()
    });

    const result = await callRouter(router, {
      method: "GET",
      path: "/api/operation-permission/v1/catalog/tool%2Fmissing"
    });

    expect(result.handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(result.response, 404, {
      schemaVersion: "v0.0.1:schema:definition-1",
      error: {
        code: "unknown_tool",
        message: "Tool is not registered.",
        details: { toolId: "tool/missing" }
      }
    });
  });

  it("throws on invalid JSON request bodies so the router error path is exercised", async () => {
    const platform = createPlatform();
    const router = createOperationPermissionHttpRouter({ platform, logger: getRuntimeLoggerMock() });
    const response = createResponse();

    await expect(router.handleOperationPermissionHttpRequest({
      request: createRequest({
        headers: {
          host: "127.0.0.1:7228",
          "x-lico-client-kind": "lico-client",
          "x-lico-client-id": "lico-test-client"
        }
      }),
      response,
      requestBody: Buffer.from("{not-json", "utf8"),
      url: createUrl("/api/operation-permission/v1/execute"),
      method: "POST"
    })).rejects.toThrow(SyntaxError);
  });

  it("uses the authorized console session as pending resolver instead of trusting the request body", async () => {
    const platform = createPlatform();
    const securityPermissions = {
      authorizeOperation: vi.fn(async () => ({
        ok: true,
        session: {
          user: {
            userId: "console-user-1",
            username: "Console User",
            roleId: "admin"
          }
        }
      }))
    };
    const router = createOperationPermissionHttpRouter({
      platform,
      securityPermissions,
      logger: getRuntimeLoggerMock()
    });

    const result = await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/pending-operations/pending-1/resolve",
      headers: { "x-lico-safety-confirm": "true" },
      body: {
        resolution: "approved",
        resolvedBy: "payload-spoof",
        reviewer: "payload-reviewer",
        reason: "ok"
      }
    });

    expect(result.handled).toBe(true);
    expect(platform.runtime.resumePendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      pendingOperationId: "pending-1",
      resolution: "approved",
      resolvedBy: "console-user-1",
      approver: expect.objectContaining({
        userId: "console-user-1"
      }),
      reason: "ok"
    }));
  });
});

describe("operation-permission store boundaries (behavior)", () => {
  it("rejects unknown capabilities and keeps the database path stable", async () => {
    await withTempUserDataPath(async (userDataPath) => {
      const store = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      try {
        expect(path.basename(getOperationPermissionDatabasePath(userDataPath))).toBe("operation-permission.sqlite");
        await expect(store.createGrant({
          label: "Bad Grant",
          capabilities: ["cap:operation-permission:unknown:test"]
        })).rejects.toThrow("Unknown tool grant capability permission");
      } finally {
        store.close();
        expect(store.isClosed()).toBe(true);
        expect(() => store.close()).not.toThrow();
      }
    });
  });

  it("derives pending approval layer projections only from requiredApproval", async () => {
    await withTempUserDataPath(async (userDataPath) => {
      const store = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      try {
        const requiredApproval = createGovernanceRequiredApproval({ approvalLayers: ["team"] });
        const pending = store.createPendingOperation({
          pendingOperationId: "pending-required-source",
          toolId: "tool.alpha",
          operationId: "operation.alpha",
          requiredApproval,
          approvalLayers: ["department"],
          originalInput: { token: "secret" }
        });
        const projectionOnly = store.createPendingOperation({
          pendingOperationId: "pending-projection-source",
          toolId: "tool.alpha",
          operationId: "operation.alpha",
          requiredApproval: createGovernanceRequiredApproval({ approvalLayers: [] }),
          approvalLayers: ["department"],
          originalInput: { token: "secret" }
        });
        const loaded = store.getPendingOperation("pending-required-source", { includeOriginalInput: true });
        const loadedProjectionOnly = store.getPendingOperation("pending-projection-source", { includeOriginalInput: true });

        expect(pending.approvalLayers).toEqual(["team"]);
        expect(loaded.requiredApproval.approvalLayers).toEqual(["team"]);
        expect(loaded.requiredApproval.operationBinding).toEqual(requiredApproval.operationBinding);
        expect(loaded.redactedInput.token).toBe("<redacted>");
        expect(projectionOnly.approvalLayers).toEqual([]);
        expect(loadedProjectionOnly.requiredApproval.approvalLayers).toEqual([]);
        const approved = store.resolvePendingOperation({
          pendingOperationId: "pending-required-source",
          resolution: "approved",
          resolvedBy: "console-user-1",
          requiredApproval: {
            ...requiredApproval,
            operationBinding: {
              ...requiredApproval.operationBinding,
              approvalActorId: "console-user-1"
            }
          }
        });
        expect(approved.requiredApproval.operationBinding).toEqual({
          ...requiredApproval.operationBinding,
          approvalActorId: "console-user-1"
        });
      } finally {
        store.close();
      }
    });
  });

  it("returns null for missing records and rejects invalid resolution states", async () => {
    await withTempUserDataPath(async (userDataPath) => {
      const store = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      try {
        expect(store.getPendingOperation("missing")).toBeNull();
        await expect(store.deleteGrant("missing")).resolves.toBe(false);
        expect(() => store.resolvePendingOperation({
          pendingOperationId: "missing",
          resolution: "not-a-valid-state"
        })).toThrow("Invalid pending operation resolution status.");
        expect(() => store.resolveMcpAuthorizationRequest({
          requestId: "missing",
          resolution: "not-a-valid-state"
        })).toThrow("Invalid resolution status");
      } finally {
        store.close();
      }
    });
  });
});
