import { describe, expect, it, vi } from "vitest";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";

import { ensureSchema } from "../../../packages/capabilities/src/operation-permission-core/store-schema.ts";
import {
  bindingContextFromRequest,
  mcpTargetHeaderFromRequest
} from "../../../packages/capabilities/src/operation-permission-core/store-utils.ts";
import { authenticateMcpApiKey } from "../../../packages/capabilities/src/skills/mcp-api-key-authentication.ts";
import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { authHeaders } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/discovery.ts";
import { handleMeshrixMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import { normalizeMcpOperationEnvelope } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-request-validation.ts";
import { listVisibleUpstreamMcpTools } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-upstream.ts";

const API_KEY: any = `mxak1.${"A".repeat(22)}.${"b".repeat(43)}`;

function request(headers: Record<string, any> = {}) : any {
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      host: "meshrix.test",
      "x-meshrix.js-mcp-target": "neutral-peer",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function responseCapture() : any {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body: any = "") : any {
      this.body = String(body || "");
    },
    json() : any {
      return this.body ? JSON.parse(this.body) : null;
    }
  };
}

function authorizationContext(extra: Record<string, any> = {}) : any {
  const workloadPrincipalId: any = "workload-principal-recorded-by-server";
  return {
    credentialKind: "scoped_api_key",
    keyId: "A".repeat(22),
    workloadPrincipalId,
    organizationNodeId: "org-recorded-by-server",
    lifecycleRevision: 7,
    policyFingerprint: "policy-recorded-by-server",
    policy: {
      protocol: "mcp",
      serviceIds: [],
      capabilityIds: [],
      toolsetIds: ["meshrix.runtime.read"],
      allowedTools: ["system.health"],
      deniedTools: [],
      scopeIds: ["runtime:read"],
      maximumRisk: "low",
      resources: { workspaceIds: [], secretBindingIds: [] }
    },
    processIdentity: null,
    ...extra
  };
}

describe("direct MCP API key authentication", () : any => {
  it("has no registered operation or adapter route for the retired device lifecycle", async () : Promise<any> => {
    const retiredOperationIds: readonly string[] = [
      "operation_permission.mcp.request_authorization",
      "operation_permission.mcp.list_requests",
      "operation_permission.mcp.resolve_request"
    ];
    const retiredRoutes: readonly (readonly [string, string])[] = [
      ["POST", "/api/mcp/authorization/request"],
      ["GET", "/api/console/mcp/authorization/requests"],
      ["POST", "/api/console/mcp/authorization/requests/request-id/resolve"],
      ["POST", "/api/mcp/local-grant/requests"],
      ["POST", "/api/mcp/local-grant/requests/request-id/consume"],
      ["POST", "/api/mcp/local-grant"],
      ["POST", "/api/mcp/local-uninstall"]
    ];
    const retiredPaths: readonly string[] = retiredRoutes.map(([, pathname]: readonly [string, string]) : string => pathname);
    expect(SERVER_API_OPERATIONS.filter((operation?: any) : any =>
      retiredOperationIds.includes(operation.id) || retiredPaths.includes(operation.http?.path)
    )).toEqual([]);

    for (const [method, pathname] of retiredRoutes) {
      const response: any = responseCapture();
      await expect(handleMeshrixMcpHttpRequest({
        request: request(),
        response,
        requestBody: Buffer.from("{}"),
        method,
        url: new URL(pathname, "https://meshrix.test"),
        toolSkillManagementProvider: new Proxy({}, {
          get() : never {
            throw new Error("retired route reached the provider");
          }
        })
      })).resolves.toBe(false);
      expect(response.statusCode).toBe(0);
      expect(response.body).toBe("");
    }

    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: { store: { authorizeRequest: vi.fn() } }
    });
    for (const method of [
      "createLocalMcpGrantAuthorizationRequest",
      "consumeLocalMcpGrantAuthorizationRequest",
      "createLocalMcpGrant",
      "markLocalMcpGrantUninstalled",
      "listMcpAuthorizationRequests",
      "resolveMcpAuthorizationRequest"
    ]) {
      expect(provider[method]).toBeUndefined();
    }
  });

  it("uses only the indexed API-key provider context and ignores client authority claims", async () : Promise<any> => {
    const authenticateRuntime: any = vi.fn(async () : Promise<any> => authorizationContext());
    const result: any = await authenticateMcpApiKey({
      request: request({
        "x-meshrix.js-api-key": API_KEY,
        "x-meshrix.js-connector-package-id": "meshrix-mcp-connector",
        "x-meshrix-subject-id": "spoofed-subject",
        "x-meshrix-organization-id": "spoofed-org",
        "x-meshrix-role": "owner",
        "x-meshrix-scopes": "*"
      }),
      requestBody: Buffer.from(JSON.stringify({
        clientInfo: { name: "spoofed-admin" },
        subject: { subjectId: "spoofed-subject", roles: ["owner"] },
        requestedScopes: ["*"]
      })),
      url: new URL("https://meshrix.test/mcp"),
      method: "POST",
      apiKeyDistributionProvider: { authenticateRuntime }
    });

    expect(result).toMatchObject({
      handled: true,
      ok: true,
      credentialKind: "scoped_api_key",
      apiKeyAuthorization: {
        workloadPrincipalId: "workload-principal-recorded-by-server",
        organizationNodeId: "org-recorded-by-server"
      }
    });
    expect(result).not.toHaveProperty("grant");
    expect(authenticateRuntime).toHaveBeenCalledWith({
      credential: API_KEY,
      serverAudience: "meshrix.test",
      targetId: "neutral-peer",
      connectorPackageId: "meshrix-mcp-connector",
      processIdentityEvidence: null
    });
    expect(JSON.stringify(authenticateRuntime.mock.calls[0][0])).not.toContain("spoofed");
  });

  it("rejects retired undotted authentication headers and never binds their audience values", async () : Promise<any> => {
    const authenticateRuntime: any = vi.fn(async () : Promise<any> => authorizationContext());
    const retiredOnly: any = await authenticateMcpApiKey({
      request: request({
        "x-meshrix-api-key": API_KEY,
        "x-meshrix-mcp-target": "retired-target",
        "x-meshrix-connector-package-id": "retired-connector"
      }),
      apiKeyDistributionProvider: { authenticateRuntime }
    });
    expect(retiredOnly).toEqual({ handled: false });
    expect(authenticateRuntime).not.toHaveBeenCalled();

    const canonicalCredential: any = await authenticateMcpApiKey({
      request: {
        ...request(),
        headers: {
          host: "meshrix.test",
          "x-meshrix.js-api-key": API_KEY,
          "x-meshrix-mcp-target": "retired-target",
          "x-meshrix-connector-package-id": "retired-connector"
        }
      },
      apiKeyDistributionProvider: { authenticateRuntime }
    });
    expect(canonicalCredential.ok).toBe(true);
    expect(authenticateRuntime).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "",
      connectorPackageId: null
    }));

    const retiredBindingRequest: any = { headers: { "x-meshrix-mcp-target": "retired-target" }, url: "/mcp" };
    expect(mcpTargetHeaderFromRequest(retiredBindingRequest)).toBe("");
    expect(bindingContextFromRequest({ request: retiredBindingRequest }).clientId).toBe("");
    const canonicalBindingRequest: any = { headers: { "x-meshrix.js-mcp-target": "canonical-target" }, url: "/mcp" };
    expect(mcpTargetHeaderFromRequest(canonicalBindingRequest)).toBe("canonical-target");
    expect(bindingContextFromRequest({ request: canonicalBindingRequest }).clientId).toBe("canonical-target");
  });

  it("projects only the server workload subject into the MCP envelope", () : any => {
    const context: any = authorizationContext();
    const normalized: any = normalizeMcpOperationEnvelope({
      operation: "system.health",
      subject: {
        subjectId: "spoofed-client-subject",
        organizationNodeId: "spoofed-client-org",
        roles: ["owner"]
      },
      operatorId: "spoofed-operator",
      requestedScopes: ["*"]
    }, {
      ok: true,
      credentialKind: "scoped_api_key",
      apiKeyAuthorization: context
    });
    expect(normalized.envelope.subject).toMatchObject({
      type: "scoped-api-key",
      subjectId: "workload-principal-recorded-by-server",
      organizationNodeId: "org-recorded-by-server",
      scopes: ["runtime:read"]
    });
    expect(normalized.envelope.subject.declaredSubject).toMatchObject({
      subjectId: "spoofed-client-subject"
    });
    expect(normalized.envelope.subject.subjectId).not.toBe("spoofed-client-subject");
    expect(normalized.envelope.operatorId).toBe("workload-principal-recorded-by-server");
    expect(normalized.envelope.agentProfileId).toBe("");
  });

  it("authenticates a neutral MCP tools/list request before exposing any outlet", async () : Promise<any> => {
    const authenticateRuntime: any = vi.fn(async () : Promise<any> => authorizationContext());
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest: vi.fn() },
        apiKeyDistributionProvider: { authenticateRuntime },
        catalog: () : any => ({
          tools: [
            {
              id: "system.health",
              status: "active",
              requiredScopes: ["runtime:read"],
              toolsets: ["meshrix.runtime.read"],
              risk: "read_only"
            },
            {
              id: "system.admin",
              status: "active",
              requiredScopes: ["runtime:admin"],
              toolsets: ["meshrix.runtime.write"],
              risk: "repair_write"
            }
          ]
        })
      }
    });
    const response: any = responseCapture();
    const body: any = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        clientInfo: { name: "untrusted-client-label" },
        scopes: ["*"]
      }
    }));
    await handleMeshrixMcpHttpRequest({
      request: request({ "x-meshrix.js-api-key": API_KEY }),
      response,
      requestBody: body,
      method: "POST",
      url: new URL("https://meshrix.test/mcp"),
      toolSkillManagementProvider: provider
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: expect.any(Array) }
    });
    expect(authenticateRuntime).toHaveBeenCalledOnce();
    const authorization: any = await provider.authorizeRequest({ request: request({ "x-meshrix.js-api-key": API_KEY }) });
    expect(provider.listVisibleTools({ authorization }).map((tool: any) : any => tool.id)).toEqual(["system.health"]);
  });

  it("shows selected Core and exact upstream tools through one restricted API Key", async () : Promise<any> => {
    const base: any = authorizationContext();
    const context: any = authorizationContext({
      policy: {
        ...base.policy,
        serviceIds: ["service-allowed"],
        capabilityIds: ["cap:upstream:service-allowed:tools-call"],
        toolsetIds: ["meshrix.runtime.read", "meshrix.gateway.read"],
        allowedTools: ["system.health"],
        scopeIds: ["runtime:read", "gateway:read"],
        maximumRisk: "low",
        resources: {
          ...base.policy.resources,
          mode: "restricted",
          egressClasses: ["mcp"],
          capabilityDomains: ["runtime", "upstream-gateway"],
          capabilityVerbs: ["health", "tools/call"],
          resourceKinds: ["system-health", "upstream-service-operation"],
          effectKinds: ["read"],
          secretBindingIds: ["secret-binding-allowed"],
          allowedOrigins: [],
          allowedCidrs: []
        }
      }
    });
    const evaluateProjectedOperationAudience: any = vi.fn(({ grant, restriction, subject, tool }: Record<string, any>) : any => ({
      allowed: grant === null &&
        restriction?.allowedServiceIds?.includes(tool.serviceId) &&
        subject?.subjectId === "workload-principal-recorded-by-server"
    }));
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest: vi.fn() },
        apiKeyDistributionProvider: {
          authenticateRuntime: vi.fn(async () : Promise<any> => context)
        },
        catalog: () : any => ({
          tools: [
            {
              id: "system.health",
              status: "active",
              requiredScopes: ["runtime:read"],
              toolsets: ["meshrix.runtime.read"],
              risk: "read_only",
              resourceContext: {
                capabilityDomain: "runtime",
                capabilityVerb: "health",
                resourceKind: "system-health",
                effectKind: "read"
              }
            },
            {
              id: "upstream.service-allowed.echo",
              status: "active",
              upstreamProjectedOperation: true,
              serviceId: "service-allowed",
              requiredScopes: ["gateway:read"],
              toolsets: ["meshrix.gateway.read"],
              risk: "read_only",
              resourceContext: {
                requestedEgress: "mcp",
                requestedEgresses: ["mcp"],
                secretBindingId: "secret-binding-allowed",
                secretBindingIds: ["secret-binding-allowed"],
                capabilityDomain: "upstream-gateway",
                capabilityVerb: "tools/call",
                resourceKind: "upstream-service-operation"
              },
              dynamicCapability: {
                capabilityId: "cap:upstream:service-allowed:tools-call",
                serviceId: "service-allowed",
                credentialBindingIds: ["secret-binding-allowed"],
                resourceContext: {
                  requestedEgress: "mcp",
                  requestedEgresses: ["mcp"],
                  secretBindingId: "secret-binding-allowed",
                  secretBindingIds: ["secret-binding-allowed"],
                  capabilityDomain: "upstream-gateway",
                  capabilityVerb: "tools/call",
                  resourceKind: "upstream-service-operation"
                }
              }
            },
            {
              id: "upstream.service-denied.admin",
              status: "active",
              upstreamProjectedOperation: true,
              serviceId: "service-denied",
              requiredScopes: ["gateway:admin"],
              toolsets: ["meshrix.gateway.admin"],
              risk: "repair_write",
              dynamicCapability: { capabilityId: "cap:upstream:service-denied:admin" }
            }
          ]
        })
      },
      evaluateToolAudience: evaluateProjectedOperationAudience
    });
    const authorization: any = await provider.authorizeRequest({
      request: request({ "x-meshrix.js-api-key": API_KEY })
    });
    expect(authorization).toMatchObject({
      ok: true,
      credentialKind: "scoped_api_key",
      restriction: {
        allowedServiceIds: ["service-allowed"],
        scopes: ["runtime:read", "gateway:read"]
      },
      subject: {
        type: "scoped-api-key",
        subjectId: "workload-principal-recorded-by-server"
      }
    });
    expect(authorization).not.toHaveProperty("grant");
    expect(provider.listVisibleTools({ authorization }).map((tool: any) : any => tool.id)).toEqual([
      "system.health",
      "upstream.service-allowed.echo"
    ]);
    expect(evaluateProjectedOperationAudience).toHaveBeenCalledOnce();

    const evaluateDiscoveredMcpToolAudience: any = vi.fn(({ grant, restriction, subject }: Record<string, any>) : any => ({
      allowed: grant === null &&
        restriction?.allowedServiceIds?.includes("service-allowed") &&
        subject?.subjectId === "workload-principal-recorded-by-server"
    }));
    const listMcpTools: any = vi.fn(async ({ serviceId }: Record<string, any>) : Promise<any> => ({
      items: serviceId === "service-allowed"
        ? [
            {
              name: "upstream.service-allowed.echo",
              _meta: {
                upstreamMcp: true,
                serviceId,
                requiredCapabilities: ["cap:upstream:service-allowed:tools-call"],
                requiredScopes: ["gateway:read"],
                toolsets: ["meshrix.gateway.read"],
                risk: "read_only",
                dynamicCapability: {
                  capabilityId: "cap:upstream:service-allowed:tools-call",
                  credentialBindingIds: ["secret-binding-allowed"]
                }
              }
            },
            {
              name: "upstream.service-allowed.admin",
              _meta: {
                upstreamMcp: true,
                serviceId,
                requiredCapabilities: ["cap:upstream:service-allowed:admin"],
                requiredScopes: ["gateway:admin"],
                toolsets: ["meshrix.gateway.admin"],
                risk: "repair_write",
                dynamicCapability: { credentialBindingIds: ["secret-binding-denied"] }
              }
            }
          ]
        : []
    }));
    const visible: any[] = await listVisibleUpstreamMcpTools({
      authorization,
      upstreamGatewayRegistry: {
        listServices: () : any => ({
          items: [
            {
              serviceId: "service-allowed",
              serviceProtocol: "mcp",
              credentialBindingIds: ["secret-binding-allowed"]
            },
            {
              serviceId: "service-denied",
              serviceProtocol: "mcp",
              credentialBindingIds: []
            }
          ]
        }),
        listMcpTools,
        evaluateDiscoveredMcpToolAudience
      }
    });
    expect(visible.map((tool: any) : any => tool.name)).toEqual(["upstream.service-allowed.echo"]);
    expect(listMcpTools).toHaveBeenCalledOnce();
    expect(listMcpTools).toHaveBeenCalledWith({ serviceId: "service-allowed" }, { signal: null });
    expect(evaluateDiscoveredMcpToolAudience).toHaveBeenCalledOnce();
  });

  it("denies an unknown API key before neutral MCP discovery", async () : Promise<any> => {
    const authenticateRuntime: any = vi.fn(async () : Promise<any> => {
      throw Object.assign(new Error("unknown"), { reasonCode: "api_key_invalid", status: 401 });
    });
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest: vi.fn() },
        apiKeyDistributionProvider: { authenticateRuntime },
        catalog: () : any => ({ tools: [] })
      }
    });
    const response: any = responseCapture();
    const body: any = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    await handleMeshrixMcpHttpRequest({
      request: request({ "x-meshrix.js-api-key": API_KEY }),
      response,
      requestBody: body,
      method: "POST",
      url: new URL("https://meshrix.test/mcp"),
      toolSkillManagementProvider: provider
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.data.code).toBe("api_key_invalid");
  });

  it.each([
    ["malformed", `mxak1.${"A".repeat(21)}.${"b".repeat(43)}`, "api_key_invalid"],
    ["whitespace-padded", ` ${API_KEY}`, "api_key_invalid"],
    ["generic Grant", "grant-token", "api_key_legacy_grant_rejected"]
  ])("rejects %s input before the API-key provider", async (_label?: any, credential?: any, reasonCode?: any) : Promise<any> => {
    const authenticateRuntime: any = vi.fn();
    const result: any = await authenticateMcpApiKey({
      request: request({ "x-meshrix.js-api-key": credential }),
      apiKeyDistributionProvider: { authenticateRuntime }
    });
    expect(result).toMatchObject({ ok: false, status: 401, reasonCode });
    expect(authenticateRuntime).not.toHaveBeenCalled();
  });

  it("rejects repeated process identity evidence instead of treating it as absent", async () : Promise<any> => {
    const authenticateRuntime: any = vi.fn();
    const result: any = await authenticateMcpApiKey({
      request: request({
        "x-meshrix.js-api-key": API_KEY,
        "x-meshrix-signature": ["first-signature", "second-signature"]
      }),
      securityPermissions: { verifyProcessIdentity: vi.fn() },
      apiKeyDistributionProvider: { authenticateRuntime }
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      reasonCode: "api_key_process_identity_ambiguous"
    });
    expect(authenticateRuntime).not.toHaveBeenCalled();
  });

  it.each([
    "api_key_invalid",
    "api_key_inactive",
    "api_key_use_limit_reached",
    "api_key_lineage_stale",
    "api_key_policy_denied"
  ])("preserves fail-closed domain denial %s before visibility", async (reasonCode?: any) : Promise<any> => {
    const error: any = Object.assign(new Error("private domain detail"), { reasonCode, status: 403 });
    const result: any = await authenticateMcpApiKey({
      request: request({ "x-meshrix.js-api-key": API_KEY }),
      apiKeyDistributionProvider: { authenticateRuntime: vi.fn(async () : Promise<any> => { throw error; }) }
    });
    expect(result).toEqual({
      handled: true,
      ok: false,
      status: 403,
      reasonCode,
      error: "API key authorization failed."
    });
  });

  it("rejects ambiguous credentials and API keys in Grant headers", async () : Promise<any> => {
    const provider: any = { authenticateRuntime: vi.fn() };
    const ambiguous: any = await authenticateMcpApiKey({
      request: request({ authorization: "Bearer generic-grant", "x-meshrix.js-api-key": API_KEY }),
      apiKeyDistributionProvider: provider
    });
    const bearer: any = await authenticateMcpApiKey({
      request: request({ authorization: `Bearer ${API_KEY}` }),
      apiKeyDistributionProvider: provider
    });
    const toolToken: any = await authenticateMcpApiKey({
      request: request({ "x-meshrix-tool-token": API_KEY }),
      apiKeyDistributionProvider: provider
    });
    expect(ambiguous.reasonCode).toBe("mcp_credential_ambiguous");
    expect(bearer.reasonCode).toBe("api_key_wrong_auth_scheme");
    expect(toolToken.reasonCode).toBe("api_key_wrong_auth_scheme");
    expect(provider.authenticateRuntime).not.toHaveBeenCalled();
  });

  it("keeps generic Grant authentication on its existing path without API-key normalization", async () : Promise<any> => {
    const authorizeRequest: any = vi.fn(async () : Promise<any> => ({
      ok: true,
      grant: { id: "generic-grant", scopes: [], toolsets: [] }
    }));
    const apiKeyAuthenticate: any = vi.fn();
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest },
        apiKeyDistributionProvider: { authenticateRuntime: apiKeyAuthenticate }
      }
    });
    const grantRequest: any = request({ authorization: "Bearer generic-grant" });
    const result: any = await provider.authorizeRequest({ request: grantRequest });
    expect(result.ok).toBe(true);
    expect(authorizeRequest).toHaveBeenCalledOnce();
    expect(apiKeyAuthenticate).not.toHaveBeenCalled();
    expect(grantRequest.headers["x-meshrix-tool-token"]).toBeUndefined();
  });

  it("denies ordinary Grants at the MCP boundary while preserving delegated children", async () : Promise<any> => {
    const authorizeRequest: any = vi.fn()
      .mockResolvedValueOnce({ ok: true, grant: { id: "ordinary", type: "machine" } })
      .mockResolvedValueOnce({ ok: true, grant: { id: "child", type: "delegated-mcp-child" } });
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest },
        apiKeyDistributionProvider: { authenticateRuntime: vi.fn() }
      }
    });

    await expect(provider.authorizeMcpClientRequest({
      request: request({ authorization: "Bearer ordinary-grant" })
    })).resolves.toMatchObject({ ok: false, status: 403, reasonCode: "mcp_api_key_required" });
    await expect(provider.authorizeMcpClientRequest({
      request: request({ authorization: "Bearer child" })
    })).resolves.toMatchObject({
      ok: true,
      grant: { id: "child", type: "delegated-mcp-child" }
    });
  });

  it("passes the domain authorization context to the existing execution runtime without a generic Grant", async () : Promise<any> => {
    const context: any = authorizationContext();
    const executeTool: any = vi.fn(async () : Promise<any> => ({ ok: true, payload: { ok: true } }));
    const provider: any = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        registry: { getTool: vi.fn(() : any => ({ id: "system.health" })) },
        runtime: { executeTool }
      }
    });
    await provider.executeTool({
      toolId: "system.health",
      input: {},
      request: request({ "x-meshrix.js-api-key": API_KEY }),
      authorization: {
        ok: true,
        credentialKind: "scoped_api_key",
        apiKeyAuthorization: context
      }
    });
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyAuthorization: context
    }));
    expect(executeTool.mock.calls[0][0]).not.toHaveProperty("authorizedGrant");
  });

  it("verifies supplied signed process identity and never learns a fingerprint on first use", async () : Promise<any> => {
    const verification: any = {
      ok: true,
      client: { processPublicKeyHash: "admin-provisioned-fingerprint" }
    };
    const verifyProcessIdentity: any = vi.fn(async () : Promise<any> => verification);
    const authenticateRuntime: any = vi.fn(async ({ processIdentityEvidence }: Record<string, any>) : Promise<any> => {
      expect(processIdentityEvidence).toMatchObject({
        ok: true,
        publicKeyFingerprint: "admin-provisioned-fingerprint"
      });
      return authorizationContext({ processIdentity: verification.client });
    });
    const result: any = await authenticateMcpApiKey({
      request: request({
        "x-meshrix.js-api-key": API_KEY,
        "x-meshrix-process-key-id": "admin-provisioned-key",
        "x-meshrix-signature": "signed-evidence"
      }),
      requestBody: Buffer.from("{}"),
      url: new URL("https://meshrix.test/mcp"),
      method: "POST",
      securityPermissions: { verifyProcessIdentity },
      apiKeyDistributionProvider: { authenticateRuntime }
    });
    expect(result.ok).toBe(true);
    expect(verifyProcessIdentity).toHaveBeenCalledOnce();
    expect(authenticateRuntime).toHaveBeenCalledOnce();
  });

  it("fails invalid supplied process identity before runtime key authorization", async () : Promise<any> => {
    const authenticateRuntime: any = vi.fn();
    const result: any = await authenticateMcpApiKey({
      request: request({
        "x-meshrix.js-api-key": API_KEY,
        "x-meshrix-process-key-id": "untrusted-key",
        "x-meshrix-signature": "invalid-signature"
      }),
      securityPermissions: {
        verifyProcessIdentity: vi.fn(async () : Promise<any> => ({
          ok: false,
          status: 401,
          reasonCode: "process_identity_signature_invalid"
        }))
      },
      apiKeyDistributionProvider: { authenticateRuntime }
    });
    expect(result).toMatchObject({ ok: false, status: 401, reasonCode: "process_identity_signature_invalid" });
    expect(authenticateRuntime).not.toHaveBeenCalled();
  });

  it("makes connector credential headers API-Key-only", () : any => {
    expect(authHeaders(API_KEY, "neutral-peer")).toMatchObject({
      "X-Meshrix.js-Api-Key": API_KEY,
      "X-Meshrix.js-Connector-Package-Id": "meshrix-mcp-connector",
      "X-Meshrix.js-MCP-Target": "neutral-peer"
    });
    expect(authHeaders(API_KEY, "neutral-peer")).not.toHaveProperty("Authorization");
    expect(() : any => authHeaders("generic-grant", "neutral-peer")).toThrow("strict mxak1");
  });
});

describe("Operation Permission device-state migration", () : any => {
  it("drops only the retired device table and preserves every current permission-state family", () : any => {
    const db: any = openSqliteDatabase(":memory:");
    const preservedTables: readonly string[] = [
      "tool_grants",
      "tool_grant_events",
      "tool_policy_decisions",
      "tool_executions",
      "tool_metric_events",
      "http_request_metric_events",
      "tool_catalog_snapshots",
      "api_key_records",
      "api_key_usage_windows",
      "api_key_effect_leases",
      "api_key_lifecycle_events",
      "tool_pending_operations"
    ];
    const snapshot: any = () : any => Object.fromEntries(preservedTables.map((table?: any) : any => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ]));
    try {
      ensureSchema(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("mcp_authorization_requests")).toBeUndefined();
      db.exec(`
        INSERT INTO tool_grants (id, label, type, parent_grant_id, metadata_json, created_at, updated_at)
          VALUES ('grant-parent-preserved', 'Parent', 'machine', '', '{}', 'synthetic', 'synthetic');
        INSERT INTO tool_grants (id, label, type, parent_grant_id, metadata_json, created_at, updated_at)
          VALUES ('grant-preserved', 'Preserved', 'delegated-mcp-child', 'grant-parent-preserved', '{"delegatedMcp":{"sourceGrantId":"grant-parent-preserved"}}', 'synthetic', 'synthetic');
        INSERT INTO tool_grant_events (event_id, grant_id, event_type, created_at)
          VALUES ('grant-event-preserved', 'grant-preserved', 'created', 'synthetic');
        INSERT INTO tool_policy_decisions (decision_id, tool_id, effect, reason_code, created_at)
          VALUES ('decision-preserved', 'tool.read', 'allow', 'policy_allowed', 'synthetic');
        INSERT INTO tool_executions (tool_execution_id, trace_id, tool_id, started_at, finished_at)
          VALUES ('execution-preserved', 'trace-preserved', 'tool.read', 'synthetic', 'synthetic');
        INSERT INTO tool_metric_events (metric_id, tool_id, created_at)
          VALUES ('metric-preserved', 'tool.read', 'synthetic');
        INSERT INTO http_request_metric_events (metric_id, route, created_at)
          VALUES ('http-metric-preserved', '/mcp', 'synthetic');
        INSERT INTO tool_catalog_snapshots (fingerprint, catalog_json, created_at)
          VALUES ('catalog-preserved', '{"tools":[]}', 'synthetic');
        INSERT INTO api_key_records (
          key_id, display_prefix, credential_fingerprint, verifier_generation, verifier_digest,
          workload_principal_id, workload_display_name, organization_node_id,
          organization_lineage_digest, organization_revision_at_issue, policy_json,
          policy_fingerprint, status, lifecycle_revision, max_uses, requests_per_window,
          window_seconds, max_concurrent_effects, created_at, expires_at
        ) VALUES (
          'key-preserved', 'mxak1.synthetic', 'fingerprint-preserved', 'generation-preserved', X'0102',
          'workload-preserved', 'Synthetic workload', 'organization-preserved',
          'lineage-preserved', 1, '{"protocol":"mcp"}', 'policy-preserved', 'active', 1,
          5, 5, 60, 1, 'synthetic', 'synthetic-future'
        );
        INSERT INTO api_key_usage_windows (key_id, window_start, request_count, expires_at)
          VALUES ('key-preserved', 1, 1, 2);
        INSERT INTO api_key_effect_leases (key_id, lease_id, lifecycle_revision, policy_fingerprint, expires_at, created_at)
          VALUES ('key-preserved', 'lease-preserved', 1, 'policy-preserved', 2, 'synthetic');
        INSERT INTO api_key_lifecycle_events (
          event_id, key_id, event_type, reason_code, lifecycle_revision,
          policy_fingerprint, organization_revision, use_count, created_at
        ) VALUES (
          'lifecycle-preserved', 'key-preserved', 'created', 'created', 1,
          'policy-preserved', 1, 0, 'synthetic'
        );
        INSERT INTO tool_pending_operations (pending_operation_id, tool_id, grant_id, created_at)
          VALUES ('pending-preserved', 'tool.write', 'grant-preserved', 'synthetic');
        CREATE TABLE mcp_authorization_requests (
          request_id TEXT PRIMARY KEY,
          claim_token_hash TEXT NOT NULL,
          replay_envelope_json TEXT NOT NULL
        );
        CREATE INDEX idx_mcp_authorization_requests_status
          ON mcp_authorization_requests(request_id);
        INSERT INTO mcp_authorization_requests
          VALUES ('retired-request', 'retired-claim', 'retired-replay');
        PRAGMA user_version = 12;
      `);
      const before: any = snapshot();

      ensureSchema(db);

      expect(db.pragma("user_version", { simple: true })).toBe(14);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%mcp_authorization_requests%'").all())
        .toEqual([]);
      expect(snapshot()).toEqual(before);
      expect(() : any => ensureSchema(db)).not.toThrow();
      expect(snapshot()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
