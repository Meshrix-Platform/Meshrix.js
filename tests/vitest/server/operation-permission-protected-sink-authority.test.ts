import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import {
  createToolCatalogRegistry
} from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import {
  createToolPolicyEngine
} from "../../../packages/capabilities/src/operation-permission-core/policy.ts";
import {
  createToolExecutionRuntime
} from "../../../packages/capabilities/src/operation-permission-core/runtime.ts";
import {
  createOperationPermissionStore
} from "../../../packages/capabilities/src/operation-permission-core/store.ts";
import {
  createToolSkillManagementProvider
} from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import {
  createConsoleAuth
} from "../../../packages/foundation/src/security/auth/console-auth.ts";
import {
  createSecurityPermissionsProvider
} from "../../../packages/foundation/src/security/security-permissions-provider.ts";
import {
  handleMeshrixMcpHttpRequest,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import {
  createTagStoreAdapter
} from "../../../packages/server-runtime/src/state/tags/tag-store.adapter.ts";

const AUTHORITY_KEYS: readonly any[] = Object.freeze(["context", "subject"]);
const SUBJECT_KEYS: readonly any[] = Object.freeze([
  "generation",
  "subjectId",
  "tenantId",
  "type"
]);
const CONTEXT_KEYS: readonly any[] = Object.freeze([
  "approvalRevision",
  "grantRevision",
  "policyRevision",
  "riskRevision",
  "workloadGeneration"
]);
const PHASES: readonly any[] = Object.freeze([
  "admission",
  "execution",
  "final-protected-sink"
]);
const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const TENANT_ID: any = "tenant-operation-permission-authority";
const WORKLOAD_GENERATION: any = "workload-generation-authority-fixture";
const LOOKALIKE_MARKER: any = "caller-authored-lookalike-authority";
const roots: any[] = [];
const resources: any[] = [];

function gatewayForwardOperation({
  approvalScope = "gateway:write",
  requiresConfirmation = false,
  resourceKind = "external_service",
  risk = "safe_write"
}: Record<string, any> = {}) : any {
  const source: any = SERVER_API_OPERATIONS.find(
    (candidate?: any) : any => candidate.id === "gateway.forward"
  );
  if (!source) {
    throw new Error("gateway.forward is not registered.");
  }
  const resource: Record<string, any> = {
    ...source.resource,
    resourceKind,
    fieldMap: {
      ...(source.resource?.fieldMap || {})
    }
  };
  return {
    ...source,
    safety: {
      ...source.safety,
      approvalScope,
      requiresConfirmation,
      requiresConfirmationExplicit: true,
      risk
    },
    resource,
    resourceContext: {
      ...resource
    }
  };
}

function responseCapture() : any {
  return {
    body: Buffer.alloc(0),
    headers: {},
    statusCode: 0,
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = {
        ...this.headers,
        ...headers
      };
    },
    write(chunk: any = "") : any {
      const value: any = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      this.body = Buffer.concat([this.body, value]);
    },
    end(chunk: any = "") : any {
      if (chunk !== undefined && chunk !== null && String(chunk).length > 0) {
        this.write(chunk);
      }
      this.ended = true;
    },
    json() : any {
      return JSON.parse(this.body.toString("utf8") || "{}");
    }
  };
}

function bearerRequest(token?: any, {
  id = "mcp-authority-request",
  lookalike = true
}: Record<string, any> = {}) : any {
  const request: Record<string, any> = {
    __meshrixRequestId: id,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      host: "meshrix.invalid",
      "user-agent": "meshrix-authority-acceptance"
    },
    method: "POST",
    socket: {
      encrypted: false,
      remoteAddress: "127.0.0.1"
    },
    url: "/mcp"
  };
  if (lookalike) {
    request.protectedSinkAuthority = lookalikeAuthority();
    request.__meshrixOperationRuntimeAuthorization = {
      authorizationDecision: {
        allowed: true,
        decisionId: LOOKALIKE_MARKER
      },
      protectedSinkAuthority: lookalikeAuthority(),
      session: lookalikeSession()
    };
  }
  return request;
}

function lookalikeAuthority() : any {
  return {
    subject: {
      generation: LOOKALIKE_MARKER,
      subjectId: LOOKALIKE_MARKER,
      tenantId: LOOKALIKE_MARKER,
      type: "tool-grant"
    },
    context: {
      approvalRevision: LOOKALIKE_MARKER,
      grantRevision: LOOKALIKE_MARKER,
      policyRevision: LOOKALIKE_MARKER,
      riskRevision: LOOKALIKE_MARKER,
      workloadGeneration: LOOKALIKE_MARKER
    }
  };
}

function lookalikeSession() : any {
  return {
    sessionId: LOOKALIKE_MARKER,
    user: {
      generation: LOOKALIKE_MARKER,
      subjectId: LOOKALIKE_MARKER,
      tenantId: LOOKALIKE_MARKER,
      userId: LOOKALIKE_MARKER
    }
  };
}

function mcpCallBody({
  input = {
    body: {
      accepted: true
    },
    operationKey: "authority-write",
    serviceId: "authority-service"
  },
  subject = {
    generation: LOOKALIKE_MARKER,
    subjectId: LOOKALIKE_MARKER,
    tenantId: LOOKALIKE_MARKER,
    type: "tool-grant"
  }
}: Record<string, any> = {}) : any {
  return Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: "authority-call",
    method: "tools/call",
    params: {
      name: MCP_GATEWAY_TOOL_NAME,
      arguments: {
        apiVersion: MCP_INTERFACE_VERSION,
        operation: "gateway.forward",
        input,
        subject
      }
    }
  }), "utf8");
}

function exactKeys(value?: any, expected?: any) : any {
  expect(value).toBeTruthy();
  expect(Array.isArray(value)).toBe(false);
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

function expectExactAuthority(authority?: any, {
  grantId,
  tenantId = TENANT_ID
}: Record<string, any> = {}) : any {
  exactKeys(authority, AUTHORITY_KEYS);
  exactKeys(authority.subject, SUBJECT_KEYS);
  exactKeys(authority.context, CONTEXT_KEYS);
  expect(authority.subject).toEqual({
    generation: expect.stringMatching(DIGEST_PATTERN),
    subjectId: grantId,
    tenantId,
    type: "tool-grant"
  });
  for (const key of CONTEXT_KEYS) {
    expect(authority.context[key]).toMatch(DIGEST_PATTERN);
  }
  expect(JSON.stringify(authority)).not.toContain(LOOKALIKE_MARKER);
  expect(JSON.stringify(authority)).not.toContain(WORKLOAD_GENERATION);
  expect(Object.isFrozen(authority)).toBe(true);
  expect(Object.isFrozen(authority.subject)).toBe(true);
  expect(Object.isFrozen(authority.context)).toBe(true);
}

function phaseInput(call?: any, phase?: any) : any {
  return {
    actor: call.actor,
    authSession: lookalikeSession(),
    input: {
      ...(call.input || {}),
      protectedSinkAuthority: lookalikeAuthority()
    },
    method: call.method,
    operation: call.operation,
    params: call.params,
    phase,
    request: call.request,
    requestBody: call.requestBody,
    signal: call.signal,
    transport: call.transport,
    url: call.url,
    authorizationDecision: {
      allowed: true,
      decisionId: LOOKALIKE_MARKER
    },
    protectedSinkAuthority: lookalikeAuthority()
  };
}

function createPhaseObservingDispatcher(state?: any) : any {
  return vi.fn(async (call: Record<string, any> = {}) : Promise<any> => {
    state.dispatchCalls.push(call);
    if (call.skipAuthorization === true) {
      throw Object.assign(
        new Error("Protected Operation Permission dispatch cannot skip phase authorization."),
        { code: "operation_permission_protected_sink_authority_bypassed" }
      );
    }
    const phasePorts: Record<string, any> = {
      admission: call.authorizeOperation,
      execution: call.revalidateAuthorization,
      "final-protected-sink": call.revalidateAuthorization
    };
    let priorAuthority: any = null;
    for (const phase of PHASES) {
      await state.beforePhase?.(phase, state.harness);
      const port: any = phasePorts[phase];
      if (typeof port !== "function") {
        throw Object.assign(
          new Error(`Operation Permission ${phase} authority port is unavailable.`),
          { code: "operation_permission_protected_sink_authority_port_missing" }
        );
      }
      const result: any = await port(phaseInput(call, phase));
      state.phaseResults.push({
        phase,
        result
      });
      if (result?.ok !== true || !result.protectedSinkAuthority) {
        call.response.writeHead(Number(result?.status || 403) || 403, {
          "content-type": "application/json"
        });
        call.response.end(JSON.stringify({
          error: {
            code: result?.reasonCode ||
              "operation_permission_protected_sink_authority_unavailable"
          }
        }));
        return {
          ok: false,
          statusCode: Number(result?.status || 403) || 403
        };
      }
      if (
        priorAuthority &&
        JSON.stringify(priorAuthority) !==
          JSON.stringify(result.protectedSinkAuthority)
      ) {
        call.response.writeHead(409, {
          "content-type": "application/json"
        });
        call.response.end(JSON.stringify({
          error: {
            code: "operation_permission_protected_sink_authority_changed"
          }
        }));
        return {
          ok: false,
          statusCode: 409
        };
      }
      priorAuthority = result.protectedSinkAuthority;
    }
    state.authorizedDispatches += 1;
    call.response.writeHead(200, {
      "content-type": "application/json"
    });
    call.response.end(JSON.stringify({
      result: {
        accepted: true
      }
    }));
    return {
      handled: true,
      ok: true,
      statusCode: 200
    };
  });
}

async function createHarness({
  beforePhase = null,
  grantId = "",
  issueGrant = true,
  operation = gatewayForwardOperation(),
  root = "",
  tenantId = TENANT_ID,
  token = ""
}: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = root ||
    await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-operation-authority-"));
  if (!root) {
    roots.push(userDataPath);
  }
  const tagManagementStore: any = createTagStoreAdapter({
    userDataPath
  });
  const consoleAuth: any = createConsoleAuth({
    tagManagementStore,
    userDataPath
  });
  const securityPermissions: any = createSecurityPermissionsProvider({
    consoleAuth
  });
  const registry: any = createToolCatalogRegistry({
    operations: [operation]
  });
  const store: any = createOperationPermissionStore({
    capabilityBindingGuard: false,
    governancePolicyRevisionProvider: () : any =>
      securityPermissions.getGovernancePolicyRevision(),
    registry,
    securityPermissions,
    userDataPath
  });
  const policyEngine: any = createToolPolicyEngine({
    policyEngine: null,
    registry,
    securityPermissions,
    store
  });
  const state: Record<string, any> = {
    authorizedDispatches: 0,
    beforePhase,
    dispatchCalls: [],
    harness: null,
    phaseResults: []
  };
  const operationDispatcher: any = createPhaseObservingDispatcher(state);
  const runtime: any = createToolExecutionRuntime({
    controllers: {},
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    },
    operationDispatcher,
    operations: [operation],
    policyEngine,
    registry,
    securityPermissions,
    store
  });
  const platform: Record<string, any> = {
    catalog: () : any => registry.getCatalog(),
    registry,
    runtime,
    securityPermissions,
    store
  };
  const provider: any = createToolSkillManagementProvider({
    operationPermissionPlatform: platform,
    securityPermissions,
    userDataPath
  });
  let issued: any = null;
  if (issueGrant) {
    issued = await store.createGrant({
      capabilities: ["cap:tool:*"],
      id: grantId || undefined,
      label: "Operation authority MCP grant",
      metadata: {
        policyRevision:
          securityPermissions.getGovernancePolicyRevision().revision,
        tenantId,
        workloadGeneration: WORKLOAD_GENERATION
      },
      toolsets: ["meshrix.gateway.write"],
      type: "machine"
    });
    token = issued.token;
    grantId = issued.grant.id;
  } else {
    const current: any = store.getGrant(grantId);
    if (!current) {
      throw new Error("The persisted authority grant is unavailable.");
    }
  }
  const harness: Record<string, any> = {
    consoleAuth,
    grantId,
    operation,
    operationDispatcher,
    platform,
    policyEngine,
    provider,
    registry,
    root: userDataPath,
    runtime,
    securityPermissions,
    state,
    store,
    tagManagementStore,
    tenantId,
    token
  };
  state.harness = harness;
  resources.push(harness);
  return harness;
}

async function closeHarness(harness?: any) : Promise<any> {
  const index: any = resources.indexOf(harness);
  if (index >= 0) {
    resources.splice(index, 1);
  }
  harness.store.close();
  harness.consoleAuth.close();
  harness.tagManagementStore.close();
}

async function callMcp(harness?: any, {
  body = mcpCallBody(),
  id = `mcp-authority-${Date.now().toString(36)}`
}: Record<string, any> = {}) : Promise<any> {
  const request: any = bearerRequest(harness.token, { id });
  const response: any = responseCapture();
  await handleMeshrixMcpHttpRequest({
    method: "POST",
    request,
    requestBody: body,
    response,
    toolSkillManagementProvider: harness.provider,
    url: new URL("http://meshrix.invalid/mcp")
  });
  return {
    request,
    response
  };
}

function authoritiesByPhase(harness?: any) : any {
  return Object.fromEntries(harness.state.phaseResults.map(({ phase, result }: Record<string, any>) : any => [
    phase,
    result?.protectedSinkAuthority || null
  ]));
}

function expectNoAuthorityLeak(response?: any) : any {
  const serialized: any = response.body.toString("utf8");
  expect(serialized).not.toContain("protectedSinkAuthority");
  expect(serialized).not.toContain("approvalRevision");
  expect(serialized).not.toContain("grantRevision");
  expect(serialized).not.toContain("riskRevision");
  expect(serialized).not.toContain("workloadGeneration");
  expect(serialized).not.toContain(LOOKALIKE_MARKER);
  expect(serialized).not.toContain(WORKLOAD_GENERATION);
  expect(serialized).not.toContain(TENANT_ID);
}

async function approvePending(harness?: any, pendingOperationId?: any) : Promise<any> {
  return harness.runtime.resumePendingOperation({
    approver: {
      roleId: "owner",
      scopes: ["runtime:admin"],
      userId: "authority-approver"
    },
    context: {
      transport: "mcp"
    },
    pendingOperationId,
    reason: "authority acceptance",
    request: bearerRequest(harness.token, {
      id: `resume-${pendingOperationId}`,
      lookalike: true
    }),
    resolution: "approved",
    resolvedBy: "authority-approver"
  });
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  while (resources.length > 0) {
    const harness: any = resources.pop();
    try {
      harness.store.close();
    } catch {
      // The focused acceptance owns cleanup, not error recovery evidence.
    }
    try {
      harness.consoleAuth.close();
    } catch {
      // The focused acceptance owns cleanup, not error recovery evidence.
    }
    try {
      harness.tagManagementStore.close();
    } catch {
      // The focused acceptance owns cleanup, not error recovery evidence.
    }
  }
  await Promise.all(
    roots.splice(0).map((root?: any) : any =>
      fs.rm(root, {
        force: true,
        recursive: true
      })
    )
  );
});

describe("Operation Permission protected-sink authority", () : any => {
  it("derives exact three-phase MCP authority from durable owners and preserves it across restart", async () : Promise<any> => {
    const first: any = await createHarness();
    const firstCall: any = await callMcp(first);

    expect(firstCall.response.statusCode).toBe(200);
    expect(first.state.authorizedDispatches).toBe(1);
    expect(first.state.phaseResults.map(({ phase }: Record<string, any>) : any => phase)).toEqual(PHASES);
    const firstAuthorities: any = authoritiesByPhase(first);
    for (const phase of PHASES) {
      expectExactAuthority(firstAuthorities[phase], {
        grantId: first.grantId
      });
    }
    expect(firstAuthorities.execution).toEqual(firstAuthorities.admission);
    expect(firstAuthorities["final-protected-sink"])
      .toEqual(firstAuthorities.admission);
    expect(firstAuthorities.admission.context.approvalRevision)
      .not.toBe("not-required");
    expect(firstAuthorities.admission.context.approvalRevision)
      .not.toBe("0");
    expectNoAuthorityLeak(firstCall.response);

    const persisted: Record<string, any> = {
      authority: firstAuthorities.admission,
      grantId: first.grantId,
      root: first.root,
      token: first.token
    };
    await closeHarness(first);

    const reopened: any = await createHarness({
      grantId: persisted.grantId,
      issueGrant: false,
      root: persisted.root,
      token: persisted.token
    });
    const secondCall: any = await callMcp(reopened, {
      id: "mcp-authority-after-restart"
    });

    expect(secondCall.response.statusCode).toBe(200);
    expect(reopened.state.phaseResults.map(({ phase }: Record<string, any>) : any => phase)).toEqual(PHASES);
    for (const phase of PHASES) {
      expectExactAuthority(authoritiesByPhase(reopened)[phase], {
        grantId: persisted.grantId
      });
      expect(authoritiesByPhase(reopened)[phase]).toEqual(persisted.authority);
    }
    expectNoAuthorityLeak(secondCall.response);
  });

  it.each([
    [
      "grant projection",
      async (harness?: any) : Promise<any> => {
        await harness.store.updateGrant(harness.grantId, {
          allowedServiceIds: ["authority-service"]
        });
      }
    ],
    [
      "grant revocation",
      async (harness?: any) : Promise<any> => {
        await harness.store.revokeGrant(
          harness.grantId,
          "authority acceptance revocation"
        );
      }
    ],
    [
      "grant owner generation",
      async (harness?: any) : Promise<any> => {
        harness.store.db.prepare(`
          UPDATE tool_grant_owner_authorities
          SET state = 'retiring'
          WHERE owner_kind = 'core'
            AND owner_id = 'core-platform'
            AND owner_generation = 'core'
        `).run();
      }
    ],
    [
      "workload generation and tenant",
      async (harness?: any) : Promise<any> => {
        const current: any = harness.store.getGrant(harness.grantId);
        await harness.store.updateGrant(harness.grantId, {
          metadata: {
            ...(current.metadata || {}),
            tenantId: "tenant-operation-permission-authority-changed",
            workloadGeneration: "workload-generation-authority-changed"
          }
        });
      }
    ],
    [
      "governance policy revision",
      async (harness?: any) : Promise<any> => {
        harness.consoleAuth.authorizationGovernanceStore.upsertTeam({
          label: "Authority policy drift",
          teamId: "authority-policy-drift"
        });
      }
    ],
    [
      "catalog operation risk",
      async (harness?: any) : Promise<any> => {
        harness.registry.refresh([
          gatewayForwardOperation({
            risk: "repair_write"
          })
        ]);
      }
    ],
    [
      "catalog operation resource",
      async (harness?: any) : Promise<any> => {
        harness.registry.refresh([
          gatewayForwardOperation({
            resourceKind: "changed_external_service"
          })
        ]);
      }
    ],
    [
      "catalog operation availability",
      async (harness?: any) : Promise<any> => {
        harness.registry.refresh([]);
      }
    ]
  ])(
    "denies before final authorization when current durable %s changes",
    async (_label?: any, mutate?: any) : Promise<any> => {
      const harness: any = await createHarness({
        beforePhase: async (phase?: any, current?: any) : Promise<any> => {
          if (phase === "execution") {
            await mutate(current);
          }
        }
      });
      const result: any = await callMcp(harness);

      expect(harness.state.phaseResults.map(({ phase }: Record<string, any>) : any => phase)).toEqual([
        "admission",
        "execution"
      ]);
      expect(harness.state.phaseResults[0].result).toMatchObject({
        ok: true
      });
      expectExactAuthority(
        harness.state.phaseResults[0].result.protectedSinkAuthority,
        {
          grantId: harness.grantId
        }
      );
      expect(harness.state.phaseResults[1].result?.ok).not.toBe(true);
      expect(harness.state.phaseResults[1].result)
        .not.toHaveProperty("protectedSinkAuthority");
      expect(harness.state.authorizedDispatches).toBe(0);
      expect(result.response.body.toString("utf8"))
        .not.toContain(LOOKALIKE_MARKER);
      expectNoAuthorityLeak(result.response);
    }
  );

  it("binds an approved pending operation exactly and rejects durable approval drift and replay", async () : Promise<any> => {
    const stable: any = await createHarness({
      operation: gatewayForwardOperation({
        requiresConfirmation: true
      })
    });
    const pendingCall: any = await callMcp(stable);
    const [pending] = stable.store.listPendingOperations({
      status: "pending"
    });

    expect(pending).toMatchObject({
      grantId: stable.grantId,
      operationId: "gateway.forward",
      status: "pending"
    });
    expect(stable.state.dispatchCalls).toHaveLength(0);
    expectNoAuthorityLeak(pendingCall.response);

    const approved: any = await approvePending(
      stable,
      pending.pendingOperationId
    );
    expect(approved.ok).toBe(true);
    expect(stable.state.phaseResults.map(({ phase }: Record<string, any>) : any => phase)).toEqual(PHASES);
    for (const phase of PHASES) {
      expectExactAuthority(authoritiesByPhase(stable)[phase], {
        grantId: stable.grantId
      });
    }
    expect(authoritiesByPhase(stable).execution)
      .toEqual(authoritiesByPhase(stable).admission);
    expect(authoritiesByPhase(stable)["final-protected-sink"])
      .toEqual(authoritiesByPhase(stable).admission);
    const phaseCount: any = stable.state.phaseResults.length;
    const replay: any = await approvePending(
      stable,
      pending.pendingOperationId
    );
    expect(replay).toMatchObject({
      ok: false,
      status: 409
    });
    expect(stable.state.phaseResults).toHaveLength(phaseCount);

    const drifted: any = await createHarness({
      beforePhase: async (phase?: any, harness?: any) : Promise<any> => {
        if (phase !== "execution") return;
        const approvedRow: any = harness.store.db.prepare(`
          SELECT approval_requirements_json
          FROM tool_pending_operations
          WHERE status = 'approved'
          ORDER BY resolved_at DESC
          LIMIT 1
        `).get();
        const requirements: any = JSON.parse(
          approvedRow?.approval_requirements_json || "{}"
        );
        harness.store.db.prepare(`
          UPDATE tool_pending_operations
          SET approval_requirements_json = ?
          WHERE status = 'approved'
        `).run(JSON.stringify({
          ...requirements,
          operationBinding: {
            ...(requirements.operationBinding || {}),
            bindingDigest: "f".repeat(64)
          }
        }));
      },
      operation: gatewayForwardOperation({
        requiresConfirmation: true
      })
    });
    await callMcp(drifted, {
      id: "mcp-authority-pending-drift"
    });
    const [driftedPending] = drifted.store.listPendingOperations({
      status: "pending"
    });
    const denied: any = await approvePending(
      drifted,
      driftedPending.pendingOperationId
    );

    expect(denied.ok).toBe(false);
    expect(drifted.state.phaseResults.map(({ phase }: Record<string, any>) : any => phase)).toEqual([
      "admission",
      "execution"
    ]);
    expect(drifted.state.phaseResults[1].result?.ok).not.toBe(true);
    expect(drifted.state.phaseResults[1].result)
      .not.toHaveProperty("protectedSinkAuthority");
    expect(drifted.state.authorizedDispatches).toBe(0);
  });

  it("uses complete catalog safety facts for no-approval authority and rejects missing tenant authority", async () : Promise<any> => {
    const harness: any = await createHarness({
      operation: gatewayForwardOperation({
        approvalScope: "gateway:write"
      })
    });
    await callMcp(harness, {
      id: "mcp-authority-no-approval-first"
    });
    const firstApprovalRevision: any =
      authoritiesByPhase(harness).admission.context.approvalRevision;
    const firstRiskRevision: any =
      authoritiesByPhase(harness).admission.context.riskRevision;

    const changedOperation: any = gatewayForwardOperation({
      approvalScope: "gateway:write:alternate"
    });
    harness.registry.refresh([changedOperation]);
    harness.runtime.refreshOperations([changedOperation]);
    harness.state.authorizedDispatches = 0;
    harness.state.dispatchCalls.length = 0;
    harness.state.phaseResults.length = 0;
    await callMcp(harness, {
      id: "mcp-authority-no-approval-second"
    });
    const secondAuthority: any = authoritiesByPhase(harness).admission;

    expect(secondAuthority.context.approvalRevision)
      .not.toBe(firstApprovalRevision);
    expect(secondAuthority.context.riskRevision)
      .not.toBe(firstRiskRevision);
    expect(secondAuthority.context.approvalRevision)
      .toMatch(DIGEST_PATTERN);

    const missingTenant: any = await createHarness({
      tenantId: ""
    });
    const missingResult: any = await callMcp(missingTenant, {
      id: "mcp-authority-missing-tenant"
    });
    expect(missingTenant.state.phaseResults.map(({ phase }: Record<string, any>) : any => phase))
      .toEqual(["admission"]);
    expect(missingTenant.state.phaseResults[0].result?.ok).not.toBe(true);
    expect(missingTenant.state.phaseResults[0].result)
      .not.toHaveProperty("protectedSinkAuthority");
    expect(missingTenant.state.authorizedDispatches).toBe(0);
    expectNoAuthorityLeak(missingResult.response);
  });
});
