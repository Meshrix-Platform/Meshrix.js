import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHash } from "@meshrix/foundation/serialization/canonical-json";

const sendJsonMock: any = vi.hoisted(() : any => vi.fn((response?: any, status?: any, payload?: any) : any => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}));
const dispatchOperationMock: any = vi.hoisted(() : any => vi.fn(async ({ response }: Record<string, any>) : Promise<any> => {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    schemaVersion: "v0.0.1:schema:definition-1",
    result: { ok: true }
  }));
  return { ok: true };
}));
const summarizeErrorMock: any = vi.hoisted(() : any => vi.fn((error?: any) : any => ({
  name: error?.name || "Error",
  message: error?.message || String(error || "")
})));
const summarizeForLogMock: any = vi.hoisted(() : any => vi.fn((value?: any) : any => value));
const getRuntimeLoggerMock: any = vi.hoisted(() : any => vi.fn(() : any => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})));
const traceContextFromRequestMock: any = vi.hoisted(() : any => vi.fn(() : any => ({
  traceId: "trace-request"
})));

vi.mock("@meshrix/foundation/observability/runtime-logger", () : any => ({
  getRuntimeLogger: getRuntimeLoggerMock,
  summarizeError: summarizeErrorMock,
  summarizeForLog: summarizeForLogMock
}));

vi.mock("@meshrix/foundation/observability/trace-context", () : any => ({
  traceContextFromRequest: traceContextFromRequestMock
}));

vi.mock("@meshrix/protocols/http/http-utils", () : any => ({
  sendJson: sendJsonMock
}));

import { createOperationPermissionHttpRouter } from "../../../packages/capabilities/src/operation-permission-core/http.ts";
import { createToolExecutionRuntime } from "../../../packages/capabilities/src/operation-permission-core/runtime.ts";
import { pendingResumeInput } from "../../../packages/capabilities/src/operation-permission-core/runtime-common.ts";
import {
  createOperationPermissionStore,
  getOperationPermissionDatabasePath
} from "../../../packages/capabilities/src/operation-permission-core/store.ts";

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

function createRequest({ headers = {}, id = "req-1" }: Record<string, any> = {}) : any {
  return {
    __meshrixRequestId: id,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function createUrl(pathname?: any) : any {
  return new URL(pathname, "http://127.0.0.1");
}

function scopedApiKeyAuthorization(): any {
  return {
    credentialKind: "scoped_api_key",
    keyId: "A".repeat(22),
    workloadPrincipalId: "workload-release-journey",
    organizationNodeId: "organization-release-journey",
    lifecycleRevision: 7,
    policyFingerprint: "sha256:release-journey-policy",
    policy: {
      protocol: "mcp",
      serviceIds: [],
      capabilityIds: [],
      toolsetIds: ["toolset-1"],
      allowedTools: ["tool.alpha"],
      deniedTools: [],
      scopeIds: ["tool:run"],
      maximumRisk: "low",
      resources: {
        workspaceIds: [],
        dataClassifications: [],
        egressClasses: [],
        secretBindingIds: [],
        allowedOrigins: [],
        allowedCidrs: [],
        semanticFamilies: [],
        capabilityDomains: [],
        capabilityVerbs: [],
        resourceKinds: [],
        effectKinds: []
      }
    }
  };
}

function createRuntimeFixture(overrides: Record<string, any> = {}) : any {
  const operation: Record<string, any> = {
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

  const grant: Record<string, any> = {
    id: "grant-1",
    label: "Grant 1",
    scopes: ["tool:run"],
    capabilities: [],
    enabled: true,
    revokedAt: "",
    projectionFingerprint: "sha256:fixture-grant-projection",
    policyIntegrity: { valid: true }
  };

  const tool: Record<string, any> = {
    id: "tool.alpha",
    operationId: operation.id,
    version: "1.0.0",
    toolsets: ["toolset-1"],
    requiredScopes: ["tool:run"],
    risk: "low",
    timeoutMs: 1000,
    maxResultBytes: 1024,
    concurrency: { workloadClass: "parallel", maxParallel: 16, cost: 2 },
    requiresApproval: false,
    approvalScope: "",
    transport: {}
  };
  Object.assign(tool, overrides.tool || {});

  const store: Record<string, any> = {
    authorizeRequest: vi.fn(async () : Promise<any> => ({
      ok: true,
      grant,
      sourceIp: "127.0.0.1"
    })),
    appendExecution: vi.fn(),
    appendMetric: vi.fn(),
    appendPolicyDecision: vi.fn(),
    createPendingOperation: vi.fn((entry?: any) : any => ({
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
    getGrant: vi.fn(() : any => grant),
    getRawGrant: vi.fn(() : any => grant),
    authorizeGrantForExecution: vi.fn(() : any => ({
      ok: true,
      grant,
      sourceIp: "127.0.0.1"
    }))
  };
  Object.assign(store, overrides.store || {});

  const registry: Record<string, any> = {
    getTool: vi.fn(() : any => tool),
    listProfiles: vi.fn(() : any => []),
    ...overrides.registry
  };

  const policyEngine: Record<string, any> = {
    evaluate: vi.fn(() : any => ({
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

  const securityPermissions: Record<string, any> = {
    appendDecision: vi.fn(),
    getGovernanceApproval: vi.fn(() : any => null),
    listGovernanceApprovals: vi.fn(() : any => []),
    upsertGovernanceApproval: vi.fn(),
    revokeGovernanceApproval: vi.fn(),
    ...overrides.securityPermissions
  };

  const runtime: any = createToolExecutionRuntime({
    registry,
    store,
    policyEngine,
    operations: [operation],
    operationDispatcher: dispatchOperationMock,
    securityPermissions,
    protocolEventBus: { publish: vi.fn(async () : Promise<any> => undefined) },
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

function createPlatform(overrides: Record<string, any> = {}) : any {
  const runtime: Record<string, any> = {
    executeTool: vi.fn(async () : Promise<any> => ({
      status: 200,
      payload: { schemaVersion: "v0.0.1:schema:definition-1", result: { ok: true } }
    })),
    resumePendingOperation: vi.fn(async () : Promise<any> => ({
      status: 200,
      payload: { schemaVersion: "v0.0.1:schema:definition-1", status: "completed" }
    })),
    ...overrides.runtime
  };

  const platform: Record<string, any> = {
    catalog: vi.fn(() : any => ({ schemaVersion: "v0.0.1:schema:definition-1", catalog: true })),
    registry: {
      getTool: vi.fn(() : any => ({ id: "tool.alpha" })),
      getToolByOperationId: vi.fn(() : any => ({ id: "tool.alpha" })),
      listToolsets: vi.fn(() : any => [{ id: "toolset-1" }]),
      resolveToolset: vi.fn((payload?: any) : any => ({ resolved: true, payload })),
      listProfiles: vi.fn(() : any => [{ id: "profile-1" }])
    },
    runtime,
    store: {
      listGrants: vi.fn(() : any => [{ id: "grant-1" }]),
      createGrant: vi.fn(async (payload?: any) : Promise<any> => ({ grant: { id: "grant-new", ...payload }, token: "token-new" })),
      rotateGrantToken: vi.fn(async (grantId?: any) : Promise<any> => ({ grant: { id: grantId }, token: "token-rotated" })),
      revokeGrant: vi.fn(async (grantId?: any, reason?: any) : Promise<any> => ({ id: grantId, revoked: true, reason })),
      updateGrant: vi.fn((grantId?: any, payload?: any) : any => ({ id: grantId, updated: payload })),
      listAudit: vi.fn(() : any => [{ id: "audit-1" }]),
      getAudit: vi.fn((toolExecutionId?: any) : any => ({ id: toolExecutionId })),
      metricsSummary: vi.fn(() : any => ({ checked: true })),
      metricsExport: vi.fn(() : any => ({ checked: true })),
      metricsHealth: vi.fn(() : any => ({ checked: true })),
      metricsPrometheus: vi.fn(() : any => "metric 1"),
      metricsStorageSummary: vi.fn(() : any => ({ checked: true })),
      pruneMetrics: vi.fn(() : any => ({ checked: true })),
      listPendingOperations: vi.fn(() : any => [{ id: "pending-1" }])
    },
    policyEngine: {
      preview: vi.fn((payload?: any) : any => ({ effect: "allow", payload }))
    }
  };

  return Object.assign(platform, overrides, {
    runtime: { ...platform.runtime, ...(overrides.runtime || {}) },
    registry: { ...platform.registry, ...(overrides.registry || {}) },
    store: { ...platform.store, ...(overrides.store || {}) }
  });
}

async function callRouter(router: any, {
  method = "GET",
  path: requestPath,
  body = null,
  headers = {},
  requestId = "req-1",
  signal = null
}: Record<string, any>) : Promise<any> {
  const response: any = createResponse();
  const request: any = createRequest({ headers, id: requestId });
  const requestBody: any = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  const handled: any = await router.handleOperationPermissionHttpRequest({
    request,
    response,
    requestBody,
    url: createUrl(requestPath),
    method,
    signal
  });
  return { handled, request, response, requestBody };
}

async function withTempUserDataPath(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-permission-more-extra-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { force: true, recursive: true });
  }
}

function createGovernanceRequiredApproval(overrides: Record<string, any> = {}) : any {
  const approvalLayers: any = overrides.approvalLayers ?? ["department"];
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

function operationBindingForTest(resource: Record<string, any> = {}, operationId: any = "operation.alpha") : any {
  const core: Record<string, any> = {
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
      policyRevision: { grantPolicyRevision: 1, governancePolicyRevision: 1 },
      credentialBinding: {
        kind: "tool_grant",
        id: "grant-1",
        policyFingerprint: "sha256:fixture-grant-projection"
      },
      grantProjectionFingerprint: "sha256:fixture-grant-projection"
  };
  return {
    ...core,
    bindingDigest: canonicalHash(core)
  };
}

function createGovernancePendingRecord(requiredApproval?: any, overrides: Record<string, any> = {}) : any {
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

function createEligibleApprover(overrides: Record<string, any> = {}) : any {
  return {
    userId: "console-user-1",
    username: "Console User",
    roleId: "maintainer",
    scopes: ["runtime:admin"],
    teamIds: ["team-code"],
    departmentIds: ["department-platform"],
    ...overrides
  };
}

beforeEach(() : any => {
  sendJsonMock.mockClear();
  dispatchOperationMock.mockClear();
  summarizeErrorMock.mockClear();
  summarizeForLogMock.mockClear();
  getRuntimeLoggerMock.mockClear();
  traceContextFromRequestMock.mockClear();
});

describe("operation-permission runtime (behavior)", () : any => {
  it("preserves opaque secret-reference arrays without persisting secret material", () : any => {
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
  it("passes the HTTP parent signal into tool execution", async () : Promise<any> => {
    const platform: any = createPlatform();
    const router: any = createOperationPermissionHttpRouter({
      platform,
      logger: getRuntimeLoggerMock()
    });
    const controller: any = new AbortController();

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

  it("passes the configured proof substrate into the protected operation dispatcher", async () : Promise<any> => {
    const operationProofSubstrate: Readonly<Record<string, any>> = Object.freeze({
      beginLifecycle: vi.fn(),
      finishLifecycle: vi.fn(),
      recordReceipt: vi.fn()
    });
    const operationDispatcher: any = vi.fn(async ({ response }: Record<string, any>) : Promise<any> => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        result: { ok: true }
      }));
      return { ok: true };
    });
    const fixture: any = createRuntimeFixture({
      runtime: {
        operationDispatcher,
        operationProofSubstrate
      }
    });

    const result: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result.ok).toBe(true);
    expect(operationDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      operationProofSubstrate
    }));
  });

  it("uses the selected dynamic MCP descriptor instead of static dispatcher authority", async () : Promise<any> => {
    const authorization: any = scopedApiKeyAuthorization();
    authorization.policy = {
      ...authorization.policy,
      serviceIds: ["opaque-service"],
      capabilityIds: ["cap:upstream:opaque-service:tools-call-records-list"],
      toolsetIds: ["meshrix.gateway.read", "upstream:opaque-service"],
      allowedTools: ["catalog.other"],
      scopeIds: ["gateway:read"],
      maximumRisk: "low"
    };
    const reserveEffect: any = vi.fn(async () : Promise<any> => ({ leaseId: "lease-dynamic-tool" }));
    const authorizeOperation: any = vi.fn(async () : Promise<any> => authorization);
    const fixture: any = createRuntimeFixture({
      tool: {
        serviceId: "static-dispatcher",
        operationKey: "tools/call",
        toolsets: ["meshrix.gateway.write"],
        requiredScopes: ["gateway:write"],
        risk: "safe_write",
        requiresApproval: true
      },
      runtime: {
        apiKeyDistributionProvider: {
          authorizeOperation,
          reserveEffect,
          revalidateEffect: vi.fn(async () : Promise<any> => authorization),
          releaseEffect: vi.fn(async () : Promise<any> => undefined)
        }
      }
    });
    const dynamicCapability: any = {
      capabilityId: "cap:upstream:opaque-service:tools-call-records-list",
      serviceId: "opaque-service",
      operationKey: "tools/call",
      upstreamToolName: "records.list",
      risk: "read_only",
      requiredScopes: ["gateway:read"],
      toolsets: ["meshrix.gateway.read", "upstream:opaque-service"],
      approvalPolicy: {
        requiresApproval: false,
        approvalScope: "",
        requiredApproval: {}
      },
      resourceContext: {
        serviceId: "opaque-service",
        resourceKind: "upstream-service-operation"
      }
    };

    const result: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      apiKeyAuthorization: authorization,
      context: { dynamicCapability, resourceContext: dynamicCapability.resourceContext }
    });

    expect(result.ok).toBe(true);
    expect(fixture.policyEngine.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      restriction: expect.objectContaining({ toolAllow: [], toolDeny: [] }),
      tool: expect.objectContaining({
        id: fixture.tool.id,
        serviceId: "opaque-service",
        operationKey: "tools/call",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        toolsets: ["meshrix.gateway.read", "upstream:opaque-service"],
        requiresApproval: false,
        resourceContext: dynamicCapability.resourceContext
      })
    }));
    expect(authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      authorization,
      operation: expect.objectContaining({
        dynamicCapability: true,
        serviceId: "opaque-service",
        capabilityId: dynamicCapability.capabilityId,
        resourceContext: dynamicCapability.resourceContext
      })
    }));
    expect(reserveEffect).toHaveBeenCalledWith(expect.objectContaining({
      operation: {
        id: fixture.tool.id,
        toolId: fixture.tool.id,
        serviceId: "opaque-service",
        capabilityId: dynamicCapability.capabilityId,
        dynamicCapability: true,
        toolsetIds: dynamicCapability.toolsets,
        scopeIds: dynamicCapability.requiredScopes,
        risk: "read_only",
        resourceContext: dynamicCapability.resourceContext
      }
    }));
    expect(fixture.store.appendExecution).toHaveBeenCalledWith(expect.objectContaining({
      grantId: authorization.keyId,
      toolId: fixture.tool.id,
      risk: "read_only",
      toolsetIds: dynamicCapability.toolsets
    }));
  });

  it("aborts timed-out dispatch and waits for dispatcher settlement before returning", async () : Promise<any> => {
    let observeAbort: any;
    const aborted: any = new Promise((resolve?: any) : any => {
      observeAbort = resolve;
    });
    let settleDispatch: any;
    const dispatchSettled: any = new Promise((resolve?: any) : any => {
      settleDispatch = resolve;
    });
    const operationDispatcher: any = vi.fn(async ({ signal }: Record<string, any>) : Promise<any> => {
      signal.addEventListener("abort", observeAbort, { once: true });
      await dispatchSettled;
    });
    const fixture: any = createRuntimeFixture({
      tool: { timeoutMs: 10 },
      runtime: { operationDispatcher }
    });
    let executionSettled: any = false;

    const execution: any = fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    }).then((result?: any) : any => {
      executionSettled = true;
      return result;
    });

    await aborted;
    expect(executionSettled).toBe(false);
    settleDispatch();
    const result: any = await execution;

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

  it("revalidates the current grant before the dispatched operation effect", async () : Promise<any> => {
    let authorizationCall: any = 0;
    const authorizeRequest: any = vi.fn(async () : Promise<any> => {
      authorizationCall += 1;
      if (authorizationCall === 1) {
        return {
          ok: true,
          grant: {
            id: "grant-1",
            label: "Grant 1",
            scopes: ["tool:run"],
            capabilities: [],
            enabled: true,
            revokedAt: "",
            projectionFingerprint: "sha256:fixture-grant-projection",
            policyIntegrity: { valid: true }
          },
          sourceIp: "127.0.0.1"
        };
      }
      return {
        ok: false,
        status: 403,
        reasonCode: "grant_revoked",
        error: "Tool grant is no longer active."
      };
    });
    const operationHandler: any = vi.fn();
    const operationDispatcher: any = vi.fn(async ({ revalidateAuthorization, response }: Record<string, any>) : Promise<any> => {
      const currentAuthorization: any = await revalidateAuthorization();
      if (!currentAuthorization.ok) {
        response.writeHead(currentAuthorization.status, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify({
          error: {
            code: currentAuthorization.reasonCode,
            message: currentAuthorization.error
          }
        }));
        return { ok: false };
      }
      await operationHandler();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ result: { ok: true } }));
      return { ok: true };
    });
    const fixture: any = createRuntimeFixture({
      store: { authorizeRequest },
      runtime: { operationDispatcher }
    });

    const result: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(authorizeRequest).toHaveBeenCalledTimes(2);
    expect(authorizeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      recordUse: false
    }));
    expect(operationHandler).not.toHaveBeenCalled();
  });

  it("revalidates the current policy before the dispatched operation effect", async () : Promise<any> => {
    let policyCall: any = 0;
    const policyEngine: Record<string, any> = {
      evaluate: vi.fn(async () : Promise<any> => {
        policyCall += 1;
        return policyCall === 1
          ? {
              effect: "allow",
              decisionId: "policy-initial",
              reasonCode: "",
              redactedReason: "",
              missingScopes: [],
              missingCapabilities: [],
              missingToolsets: [],
              grantPolicyRevision: 1,
              governancePolicyRevision: { revision: 1 }
            }
          : {
              effect: "deny",
              decisionId: "policy-revoked",
              reasonCode: "policy_revoked",
              redactedReason: "Current policy denies execution.",
              missingScopes: [],
              missingCapabilities: [],
              missingToolsets: [],
              grantPolicyRevision: 2,
              governancePolicyRevision: { revision: 2 }
            };
      })
    };
    const operationHandler: any = vi.fn();
    const operationDispatcher: any = vi.fn(async ({ revalidateAuthorization, response }: Record<string, any>) : Promise<any> => {
      const currentAuthorization: any = await revalidateAuthorization();
      if (!currentAuthorization.ok) {
        response.writeHead(currentAuthorization.status, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify({
          error: {
            code: currentAuthorization.reasonCode,
            message: currentAuthorization.error
          }
        }));
        return { ok: false };
      }
      await operationHandler();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ result: { ok: true } }));
      return { ok: true };
    });
    const fixture: any = createRuntimeFixture({
      policyEngine,
      runtime: { operationDispatcher }
    });

    const result: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(policyEngine.evaluate).toHaveBeenCalledTimes(2);
    expect(operationHandler).not.toHaveBeenCalled();
  });

  it("denies a queued effect when its governance approval is revoked before execution", async () : Promise<any> => {
    let releaseLockWait: any;
    const lockWait: any = new Promise((resolve?: any) : any => {
      releaseLockWait = resolve;
    });
    let dispatchQueued: any;
    const queued: any = new Promise((resolve?: any) : any => {
      dispatchQueued = resolve;
    });
    let revoked: any = false;
    const requiredApproval: Record<string, any> = {
      approvalLayers: ["department"],
      operationBinding: {
        ...operationBindingForTest(),
        approvalActorId: "console-user-1"
      }
    };
    const approvedPendingOperation: Record<string, any> = {
      pendingOperationId: "pending-revoked-while-waiting",
      operationId: "operation.alpha",
      approvalScope: "approval:alpha",
      status: "approved",
      expiresAt: "2099-01-01T00:00:00.000Z",
      grantId: "grant-1",
      resolvedBy: "console-user-1",
      requiredApproval,
      approvalLayers: ["department"]
    };
    const operationHandler: any = vi.fn();
    const operationDispatcher: any = vi.fn(async ({ revalidateAuthorization, response }: Record<string, any>) : Promise<any> => {
      dispatchQueued();
      await lockWait;
      const currentAuthorization: any = await revalidateAuthorization();
      if (!currentAuthorization.ok) {
        response.writeHead(currentAuthorization.status, {
          "content-type": "application/json; charset=utf-8"
        });
        response.end(JSON.stringify({
          error: {
            code: currentAuthorization.reasonCode,
            message: currentAuthorization.error
          }
        }));
        return { ok: false };
      }
      await operationHandler();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ result: { ok: true } }));
      return { ok: true };
    });
    const fixture: any = createRuntimeFixture({
      tool: { requiresApproval: true },
      securityPermissions: {
        getGovernanceApproval: vi.fn(() : any => ({
          approvalId: "pending-pending-revoked-while-waiting",
          effect: "allow",
          approvalLayers: ["department"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          revokedAt: revoked ? "2026-07-25T00:00:00.000Z" : ""
        }))
      },
      runtime: { operationDispatcher }
    });

    const execution: any = fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      context: {
        approval: { resolvedBy: "console-user-1" }
      },
      approvedPendingOperation
    });
    await queued;
    revoked = true;
    releaseLockWait();
    const result: any = await execution;

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(operationHandler).not.toHaveBeenCalled();
    expect(fixture.securityPermissions.getGovernanceApproval)
      .toHaveBeenCalledWith("pending-pending-revoked-while-waiting");
  });

  it("allows a current confirmation fact after lock-time revalidation", async () : Promise<any> => {
    const requiredApproval: Record<string, any> = {
      operationBinding: {
        ...operationBindingForTest(),
        approvalActorId: "console-user-1"
      }
    };
    const approvedPendingOperation: Record<string, any> = {
      pendingOperationId: "pending-confirmed-current",
      operationId: "operation.alpha",
      approvalScope: "approval:alpha",
      status: "approved",
      expiresAt: "2099-01-01T00:00:00.000Z",
      grantId: "grant-1",
      resolvedBy: "console-user-1",
      requiredApproval,
      approvalLayers: []
    };
    const operationHandler: any = vi.fn();
    const operationDispatcher: any = vi.fn(async ({ revalidateAuthorization, response }: Record<string, any>) : Promise<any> => {
      const currentAuthorization: any = await revalidateAuthorization();
      if (!currentAuthorization.ok) {
        response.writeHead(currentAuthorization.status, {});
        response.end(JSON.stringify({ error: currentAuthorization.reasonCode }));
        return { ok: false };
      }
      await operationHandler();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ result: { ok: true } }));
      return { ok: true };
    });
    const fixture: any = createRuntimeFixture({
      tool: { requiresApproval: true },
      policyEngine: {
        evaluate: vi.fn(async () : Promise<any> => ({
          effect: "require_confirmation",
          decisionId: "policy-confirm-current",
          reasonCode: "confirmation_required",
          redactedReason: "Confirmation is required.",
          missingScopes: [],
          missingCapabilities: [],
          missingToolsets: [],
          grantPolicyRevision: 1,
          governancePolicyRevision: { revision: 1 }
        }))
      },
      runtime: { operationDispatcher }
    });

    const result: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      context: {
        approval: { resolvedBy: "console-user-1" }
      },
      approvedPendingOperation
    });

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(operationHandler).toHaveBeenCalledTimes(1);
    expect(fixture.policyEngine.evaluate).toHaveBeenCalledTimes(2);
  });

  it("propagates a parent request abort and still waits for nested dispatch settlement", async () : Promise<any> => {
    let observeDispatch: any;
    const dispatchStarted: any = new Promise((resolve?: any) : any => {
      observeDispatch = resolve;
    });
    let observeAbort: any;
    const aborted: any = new Promise((resolve?: any) : any => {
      observeAbort = resolve;
    });
    let settleDispatch: any;
    const dispatchSettled: any = new Promise((resolve?: any) : any => {
      settleDispatch = resolve;
    });
    const operationDispatcher: any = vi.fn(async ({ signal }: Record<string, any>) : Promise<any> => {
      signal.addEventListener("abort", observeAbort, { once: true });
      observeDispatch();
      await dispatchSettled;
    });
    const fixture: any = createRuntimeFixture({
      tool: { timeoutMs: 5_000 },
      runtime: { operationDispatcher }
    });
    const controller: any = new AbortController();
    let executionSettled: any = false;
    const execution: any = fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      signal: controller.signal
    }).then((result?: any) : any => {
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

  it("refreshes operations and moves from operation-missing to a successful dry run", async () : Promise<any> => {
    const fixture: any = createRuntimeFixture({
      runtime: {
        operations: []
      }
    });

    const first: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });

    expect(first.ok).toBe(false);
    expect(first.status).toBe(500);
    expect(first.payload.error.code).toBe("operation_missing");
    expect(fixture.store.authorizeRequest).not.toHaveBeenCalled();

    const refreshed: any = fixture.runtime.refreshOperations([fixture.operation]);
    expect(refreshed).toEqual({ ok: true, operationCount: 1 });

    const second: any = await fixture.runtime.executeTool({
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

  it("returns authorization denial details and records the authorization decision", async () : Promise<any> => {
    const fixture: any = createRuntimeFixture({
      store: {
        authorizeRequest: vi.fn(async () : Promise<any> => ({
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

    const result: any = await fixture.runtime.executeTool({
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

  it("returns a policy confirmation response when the policy requires confirmation", async () : Promise<any> => {
    const fixture: any = createRuntimeFixture({
      policyEngine: {
        evaluate: vi.fn(() : any => ({
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

    const result: any = await fixture.runtime.executeTool({
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

  it("creates and resumes pending operations through the runtime", async () : Promise<any> => {
    const pendingRecord: Record<string, any> = {
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
    const fixture: any = createRuntimeFixture({
      tool: {
        requiresApproval: true
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry?: any) : any => ({
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
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const pendingResult: any = await fixture.runtime.executeTool({
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

    let capturedAuthorization: any = null;
    dispatchOperationMock.mockImplementationOnce(async ({ request, response }: Record<string, any>) : Promise<any> => {
      capturedAuthorization = JSON.parse(JSON.stringify(request.__meshrixToolRuntimeAuthorization));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        result: { ok: true }
      }));
      return { ok: true };
    });
    const resumed: any = await fixture.runtime.resumePendingOperation({
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

  it("resumes an API Key pending approval only after lifecycle revalidation", async () : Promise<any> => {
    const authorization: any = scopedApiKeyAuthorization();
    let pendingRecord: any = null;
    const apiKeyDistributionProvider: Record<string, any> = {
      revalidateAuthorization: vi.fn(() : any => authorization),
      reserveEffect: vi.fn(async () : Promise<any> => ({ leaseId: "lease-api-key" })),
      revalidateEffect: vi.fn(async () : Promise<any> => authorization),
      releaseEffect: vi.fn(async () : Promise<any> => undefined)
    };
    const fixture: any = createRuntimeFixture({
      tool: { requiresApproval: true },
      runtime: { apiKeyDistributionProvider }
    });
    fixture.store.createPendingOperation.mockImplementation((entry?: any) : any => {
      pendingRecord = {
        ...entry,
        pendingOperationId: "pending-api-key-current",
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      return pendingRecord;
    });
    fixture.store.getPendingOperation.mockImplementation(() : any => pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-08-03T00:00:00.000Z"
    }));

    const pending: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest(),
      apiKeyAuthorization: authorization
    });
    expect(pending).toMatchObject({ ok: true, status: 202, payload: { status: "pending_approval" } });
    expect(pendingRecord.credentialAuthorization).toEqual(authorization);
    expect(pendingRecord.credentialAuthorization).not.toHaveProperty("credential");
    expect(pendingRecord.credentialAuthorization).not.toHaveProperty("credentialFingerprint");
    expect(pendingRecord.credentialAuthorization).not.toHaveProperty("processIdentity");

    const resumed: any = await fixture.runtime.resumePendingOperation({
      pendingOperationId: pendingRecord.pendingOperationId,
      request: createRequest(),
      resolvedBy: "console-user-1",
      reason: "approved"
    });

    expect(resumed).toMatchObject({ ok: true, status: 200 });
    expect(apiKeyDistributionProvider.revalidateAuthorization).toHaveBeenCalledWith(authorization);
    expect(fixture.store.getGrant).not.toHaveBeenCalled();
    expect(apiKeyDistributionProvider.reserveEffect).toHaveBeenCalled();
  });

  it("fails a pending API Key approval closed when its lifecycle revision is stale", async () : Promise<any> => {
    const authorization: any = scopedApiKeyAuthorization();
    const stale: Error & Record<string, any> = new Error("API Key lifecycle changed.");
    stale.code = "api_key_revision_stale";
    stale.statusCode = 409;
    const fixture: any = createRuntimeFixture({
      runtime: {
        apiKeyDistributionProvider: {
          revalidateAuthorization: vi.fn(() : never => { throw stale; })
        }
      }
    });
    const pendingRecord: Record<string, any> = {
      pendingOperationId: "pending-api-key-stale",
      status: "pending",
      traceId: "trace-request",
      toolId: fixture.tool.id,
      grantId: "",
      profileId: "",
      context: {},
      originalInput: { name: "alpha" },
      risk: "low",
      operationId: fixture.operation.id,
      credentialAuthorization: authorization,
      requiredApproval: { operationBinding: operationBindingForTest() }
    };
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, errorCode = "" }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      errorCode
    }));

    const resumed: any = await fixture.runtime.resumePendingOperation({
      pendingOperationId: pendingRecord.pendingOperationId,
      request: createRequest(),
      resolvedBy: "console-user-1",
      reason: "approved"
    });

    expect(resumed).toMatchObject({
      ok: false,
      status: 409,
      payload: { status: "failed", error: { code: "api_key_revision_stale" } }
    });
    expect(fixture.store.getGrant).not.toHaveBeenCalled();
    expect(dispatchOperationMock).not.toHaveBeenCalled();
    expect(fixture.store.resolvePendingOperation).toHaveBeenCalledWith(expect.objectContaining({
      resolution: "failed",
      errorCode: "api_key_revision_stale"
    }));
  });

  it("rejects an approved pending operation when policy revision changed before resume", async () : Promise<any> => {
    let pendingRecord: any = null;
    const policyDecision: any = (revision?: any) : any => ({
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
    const fixture: any = createRuntimeFixture({
      tool: { requiresApproval: true },
      policyEngine: {
        evaluate: vi.fn()
          .mockReturnValueOnce(policyDecision(1))
          .mockReturnValueOnce(policyDecision(2))
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry?: any) : any => {
      pendingRecord = {
        ...entry,
        pendingOperationId: "pending-policy-change",
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      return pendingRecord;
    });
    fixture.store.getPendingOperation.mockImplementation(() : any => pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const input: Record<string, any> = {
      name: "alpha",
      workspaceId: "workspace-source",
      targetWorkspaceId: "workspace-target"
    };
    const pending: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input,
      request: createRequest()
    });
    expect(pending.payload.status).toBe("pending_approval");
    expect(pendingRecord.requiredApproval.operationBinding.policyRevision).toEqual({
      grantPolicyRevision: 1,
      governancePolicyRevision: 1
    });

    const resumed: any = await fixture.runtime.resumePendingOperation({
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

  it("rejects an approved pending upstream operation after its catalog source revision changes", async () : Promise<any> => {
    let pendingRecord: any = null;
    const fixture: any = createRuntimeFixture({
      tool: {
        requiresApproval: true,
        sourceRevision: 1,
        sourceDigest: "source-one",
        serviceId: "service-a",
        operationKey: "tools/call"
      }
    });
    fixture.store.createPendingOperation.mockImplementation((entry?: any) : any => {
      pendingRecord = {
        ...entry,
        pendingOperationId: "pending-source-change",
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      return pendingRecord;
    });
    fixture.store.getPendingOperation.mockImplementation(() : any => pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const pending: any = await fixture.runtime.executeTool({
      toolId: fixture.tool.id,
      input: { name: "alpha" },
      request: createRequest()
    });
    expect(pending.payload.status).toBe("pending_approval");
    fixture.tool.sourceRevision = 2;
    fixture.tool.sourceDigest = "source-two";

    const resumed: any = await fixture.runtime.resumePendingOperation({
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

  it("rejects handler-origin pending responses unless they are explicitly escalatable", async () : Promise<any> => {
    dispatchOperationMock.mockImplementationOnce(async ({ response }: Record<string, any>) : Promise<any> => {
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        schemaVersion: "v0.0.1:schema:definition-1",
        status: "pending_approval",
        approval: { required: true }
      }));
      return { ok: true };
    });
    const fixture: any = createRuntimeFixture();

    const result: any = await fixture.runtime.executeTool({
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

  it("binds escalatable handler pending responses to the runtime operation and ignores handler binding input", async () : Promise<any> => {
    dispatchOperationMock.mockImplementationOnce(async ({ response }: Record<string, any>) : Promise<any> => {
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
    const fixture: any = createRuntimeFixture();

    const result: any = await fixture.runtime.executeTool({
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
    const binding: any = fixture.store.createPendingOperation.mock.calls[0][0].requiredApproval.operationBinding;
    expect(binding.bindingDigest).not.toBe("handler-controlled");
  });

  it("projects governance needsApproval into pending operations and records the approved layer in governance", async () : Promise<any> => {
    const requiredApproval: any = createGovernanceRequiredApproval({ approvalLayers: ["department"] });
    const pendingRecord: any = createGovernancePendingRecord(requiredApproval);
    const fixture: any = createRuntimeFixture({
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
    fixture.store.createPendingOperation.mockImplementation((entry?: any) : any => ({
      ...pendingRecord,
      pendingOperationId: "pending-governance-1",
      reasonCode: entry.reasonCode,
      requiredApproval: entry.requiredApproval,
      approvalLayers: entry.approvalLayers
    }));
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));

    const pendingResult: any = await fixture.runtime.executeTool({
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

    const resumed: any = await fixture.runtime.resumePendingOperation({
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

  it("atomically claims a pending approval so concurrent resumes execute the tool once", async () : Promise<any> => {
    const requiredApproval: any = createGovernanceRequiredApproval({ approvalLayers: ["department"] });
    const pendingRecord: any = createGovernancePendingRecord(requiredApproval, {
      pendingOperationId: "pending-concurrent-claim"
    });
    let currentPending: any = pendingRecord;
    const fixture: any = createRuntimeFixture({
      tool: { risk: "repair_write" },
      store: {
        getPendingOperation: vi.fn(() : any => currentPending),
        resolvePendingOperation: vi.fn((entry?: any) : any => {
          if (entry.resolution === "approved" && currentPending.status !== "pending") {
            return null;
          }
          if (entry.resolution !== "approved" && !["pending", "approved"].includes(currentPending.status)) {
            return null;
          }
          currentPending = {
            ...currentPending,
            status: entry.resolution,
            requiredApproval: entry.requiredApproval || currentPending.requiredApproval,
            resolvedAt: currentPending.resolvedAt || "2026-06-05T00:00:00.000Z",
            resumedToolExecutionId: entry.resumedToolExecutionId || ""
          };
          return currentPending;
        })
      }
    });

    const results: any = await Promise.all([
      fixture.runtime.resumePendingOperation({
        pendingOperationId: pendingRecord.pendingOperationId,
        request: createRequest({ id: "req-concurrent-a" }),
        resolvedBy: "console-user-1",
        approver: createEligibleApprover(),
        reason: "approve"
      }),
      fixture.runtime.resumePendingOperation({
        pendingOperationId: pendingRecord.pendingOperationId,
        request: createRequest({ id: "req-concurrent-b" }),
        resolvedBy: "console-user-1",
        approver: createEligibleApprover(),
        reason: "approve"
      })
    ]);

    expect(results.filter((result?: any) : any => result.ok)).toHaveLength(1);
    expect(results.filter((result?: any) : any => result.status === 409)).toHaveLength(1);
    expect(results.find((result?: any) : any => result.status === 409)?.payload.error.code)
      .toBe("pending_operation_replayed");
    expect(dispatchOperationMock).toHaveBeenCalledTimes(1);
    expect(fixture.securityPermissions.upsertGovernanceApproval).toHaveBeenCalledTimes(1);
    expect(fixture.securityPermissions.revokeGovernanceApproval).toHaveBeenCalledTimes(1);
  });

  it("rejects pending approval rows when approval layers exist only as a stored projection", async () : Promise<any> => {
    const requiredApproval: any = createGovernanceRequiredApproval({ approvalLayers: [] });
    const pendingRecord: any = createGovernancePendingRecord(requiredApproval, {
      pendingOperationId: "pending-projection-only",
      approvalLayers: ["department"]
    });
    const fixture: any = createRuntimeFixture({ tool: { risk: "repair_write" } });
    fixture.store.getPendingOperation.mockReturnValue(pendingRecord);

    const resumed: any = await fixture.runtime.resumePendingOperation({
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

  it("rejects governance approvals when the runtime admin is not eligible for the required layer", async () : Promise<any> => {
    const cases: any[] = [
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
      const requiredApproval: any = createGovernanceRequiredApproval({ approvalLayers: [testCase.layer] });
      const pendingRecord: any = createGovernancePendingRecord(requiredApproval, {
        pendingOperationId: `pending-${testCase.layer}`
      });
      const fixture: any = createRuntimeFixture({
        tool: { risk: "repair_write" },
        securityPermissions: {
          authorizationGovernanceStore: {
            getAgentBinding: vi.fn(() : any => null)
          }
        }
      });
      fixture.store.getPendingOperation.mockReturnValue(pendingRecord);

      const resumed: any = await fixture.runtime.resumePendingOperation({
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

  it("does not record governance approval when the original grant is unavailable", async () : Promise<any> => {
    const activeGrantProjection: Record<string, any> = {
      id: "grant-1",
      enabled: true,
      revokedAt: "",
      projectionFingerprint: "sha256:fixture-grant-projection",
      policyIntegrity: { valid: true }
    };
    const cases: any[] = [
      { name: "missing", grant: null },
      { name: "projection-missing", grant: { ...activeGrantProjection, projectionFingerprint: "" } },
      { name: "policy-corrupt", grant: { ...activeGrantProjection, policyIntegrity: { valid: false } } },
      { name: "disabled", grant: { ...activeGrantProjection, enabled: false } },
      { name: "revoked", grant: { ...activeGrantProjection, revokedAt: "2026-06-05T00:00:00.000Z" } }
    ];

    for (const testCase of cases) {
      dispatchOperationMock.mockClear();
      const requiredApproval: any = createGovernanceRequiredApproval({ approvalLayers: ["department"] });
      const pendingRecord: any = createGovernancePendingRecord(requiredApproval, {
        pendingOperationId: `pending-grant-${testCase.name}`
      });
      const fixture: any = createRuntimeFixture({
        tool: { risk: "repair_write" },
        store: {
          getGrant: vi.fn(() : any => testCase.grant)
        }
      });
      fixture.store.getPendingOperation.mockReturnValue(pendingRecord);
      fixture.store.resolvePendingOperation.mockImplementation(({ resolution, errorCode = "" }: Record<string, any>) : any => ({
        ...pendingRecord,
        status: resolution,
        errorCode,
        resolvedAt: "2026-06-05T00:00:00.000Z"
      }));

      const resumed: any = await fixture.runtime.resumePendingOperation({
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
      expect(fixture.store.resolvePendingOperation.mock.calls.map(([entry]: any[]) : any => entry.resolution)).toEqual(["failed"]);
    }
  });

  it("continues layered governance approval by creating the next pending operation after a prior layer is approved", async () : Promise<any> => {
    const departmentApproval: any = createGovernanceRequiredApproval({
      approvalLayers: ["department"],
      grantKinds: ["once"]
    });
    const teamApproval: Record<string, any> = {
      ...departmentApproval,
      approvalLayers: ["team"]
    };
    const pendingRecord: Record<string, any> = {
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
    const fixture: any = createRuntimeFixture({
      tool: { risk: "repair_write" },
      policyEngine: {
        evaluate: vi.fn(() : any => ({
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
    fixture.store.resolvePendingOperation.mockImplementation(({ resolution, resumedToolExecutionId }: Record<string, any>) : any => ({
      ...pendingRecord,
      status: resolution,
      resumedToolExecutionId: resumedToolExecutionId || "",
      resolvedAt: "2026-06-05T00:00:00.000Z"
    }));
    fixture.store.createPendingOperation.mockImplementation((entry?: any) : any => ({
      ...pendingRecord,
      pendingOperationId: "pending-team",
      status: "pending",
      reasonCode: entry.reasonCode,
      requiredApproval: entry.requiredApproval,
      approvalLayers: entry.approvalLayers
    }));

    const resumed: any = await fixture.runtime.resumePendingOperation({
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
      resolution: "completed",
      resultSummary: expect.objectContaining({
        executionOutcome: "continued_pending_approval",
        continuedPendingOperationId: "pending-team"
      })
    }));
  });
});

describe("operation-permission http router (behavior)", () : any => {
  it("returns a 404 for unknown operation-permission routes", async () : Promise<any> => {
    const platform: any = createPlatform();
    const router: any = createOperationPermissionHttpRouter({ platform, logger: getRuntimeLoggerMock() });

    const result: any = await callRouter(router, {
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

  it("returns a 404 when a catalog tool is missing", async () : Promise<any> => {
    const platform: any = createPlatform({
      registry: {
        getTool: vi.fn(() : any => null)
      }
    });
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: true,
        session: { user: { userId: "test-user", roleId: "test-role" } }
      }))
    };
    const router: any = createOperationPermissionHttpRouter({
      platform,
      securityPermissions,
      logger: getRuntimeLoggerMock()
    });

    const result: any = await callRouter(router, {
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

  it("throws on invalid JSON request bodies so the router error path is exercised", async () : Promise<any> => {
    const platform: any = createPlatform();
    const router: any = createOperationPermissionHttpRouter({ platform, logger: getRuntimeLoggerMock() });
    const response: any = createResponse();

    await expect(router.handleOperationPermissionHttpRequest({
      request: createRequest({
        headers: {
          host: "127.0.0.1:7228",
          "x-meshrix-client-kind": "meshrix-client",
          "x-meshrix-client-id": "meshrix-test-client"
        }
      }),
      response,
      requestBody: Buffer.from("{not-json", "utf8"),
      url: createUrl("/api/operation-permission/v1/execute"),
      method: "POST"
    })).rejects.toThrow(SyntaxError);
  });

  it("uses the authorized console session as pending resolver instead of trusting the request body", async () : Promise<any> => {
    const platform: any = createPlatform();
    const securityPermissions: Record<string, any> = {
      authorizeOperation: vi.fn(async () : Promise<any> => ({
        ok: true,
        session: {
          user: {
            userId: "console-user-1",
            username: "Console User",
            roleId: "maintainer"
          }
        }
      }))
    };
    const router: any = createOperationPermissionHttpRouter({
      platform,
      securityPermissions,
      logger: getRuntimeLoggerMock()
    });

    const result: any = await callRouter(router, {
      method: "POST",
      path: "/api/operation-permission/v1/pending-operations/pending-1/resolve",
      headers: { "x-meshrix-safety-confirm": "true" },
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

describe("operation-permission store boundaries (behavior)", () : any => {
  it("rejects unknown capabilities and keeps the database path stable", async () : Promise<any> => {
    await withTempUserDataPath(async (userDataPath?: any) : Promise<any> => {
      const store: any = createOperationPermissionStore({
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
        await store.close();
        expect(store.isClosed()).toBe(true);
        await expect(store.close()).resolves.toBeUndefined();
      }
    });
  });

  it("derives pending approval layer projections only from requiredApproval", async () : Promise<any> => {
    await withTempUserDataPath(async (userDataPath?: any) : Promise<any> => {
      const store: any = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      try {
        const requiredApproval: any = createGovernanceRequiredApproval({ approvalLayers: ["team"] });
        const apiKeyAuthorization: any = {
          ...scopedApiKeyAuthorization(),
          credential: "must-not-persist",
          credentialFingerprint: "must-not-persist",
          processIdentity: { executablePath: "must-not-persist" }
        };
        const pending: any = await store.createPendingOperation({
          pendingOperationId: "pending-required-source",
          toolId: "tool.alpha",
          operationId: "operation.alpha",
          requiredApproval,
          approvalLayers: ["department"],
          credentialAuthorization: apiKeyAuthorization,
          originalInput: { token: "secret" }
        });
        const projectionOnly: any = await store.createPendingOperation({
          pendingOperationId: "pending-projection-source",
          toolId: "tool.alpha",
          operationId: "operation.alpha",
          requiredApproval: createGovernanceRequiredApproval({ approvalLayers: [] }),
          approvalLayers: ["department"],
          originalInput: { token: "secret" }
        });
        const loaded: any = await store.getPendingOperation("pending-required-source", { includeOriginalInput: true });
        const loadedProjectionOnly: any = await store.getPendingOperation("pending-projection-source", { includeOriginalInput: true });

        expect(pending.approvalLayers).toEqual(["team"]);
        expect(loaded.requiredApproval.approvalLayers).toEqual(["team"]);
        expect(loaded.requiredApproval.operationBinding).toEqual(requiredApproval.operationBinding);
        expect(loaded.redactedInput.token).toBe("<redacted>");
        expect(pending).not.toHaveProperty("credentialAuthorization");
        expect(loaded.credentialAuthorization).toEqual(scopedApiKeyAuthorization());
        expect(loaded.credentialAuthorization).not.toHaveProperty("credential");
        expect(loaded.credentialAuthorization).not.toHaveProperty("credentialFingerprint");
        expect(loaded.credentialAuthorization).not.toHaveProperty("processIdentity");
        expect(projectionOnly.approvalLayers).toEqual([]);
        expect(loadedProjectionOnly.requiredApproval.approvalLayers).toEqual([]);
        const approved: any = await store.resolvePendingOperation({
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
        expect(await store.resolvePendingOperation({
          pendingOperationId: "pending-required-source",
          resolution: "approved",
          resolvedBy: "console-user-2"
        })).toBeNull();
      } finally {
        await store.close();
      }
    });
  });

  it("returns null for missing records and rejects invalid resolution states", async () : Promise<any> => {
    await withTempUserDataPath(async (userDataPath?: any) : Promise<any> => {
      const store: any = createOperationPermissionStore({
        userDataPath,
        capabilityKeyProvider: {},
        capabilityBindingGuard: false
      });
      try {
        expect(await store.getPendingOperation("missing")).toBeNull();
        await expect(store.deleteGrant("missing")).resolves.toBe(false);
        await expect(store.resolvePendingOperation({
          pendingOperationId: "missing",
          resolution: "not-a-valid-state"
        })).rejects.toThrow("Invalid pending operation resolution status.");
      } finally {
        await store.close();
      }
    });
  });
});
