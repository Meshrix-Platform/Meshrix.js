import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.mjs";
import {
  hashLocalMcpAuthorizationClaim
} from "../../../packages/capabilities/src/skills/tool-skill-management-provider-local-mcp.mjs";
import { handleLicoMcpHttpRequest } from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.mjs";
import { createWorkQueueHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-work-queue-handlers.mjs";
import {
  buildConsoleState,
  buildRuntimeInfo
} from "../../../packages/protocols/http/api-facade.mjs";
import {
  createPolicyEnforcementPoint
} from "../../../packages/foundation/src/security/authorization/pdp/policy-enforcement-point.mjs";
import { executeDiscoveryOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/discovery-executor.mjs";
import { executeStorageOperation } from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/storage-client-monitor-executors.mjs";

const TOOLSET_RISK = Object.freeze({
  "meshrix.runtime.read": "read_only",
  "meshrix.storage.read": "read_only",
  "meshrix.jobs.read": "read_only",
  "meshrix.gateway.read": "read_only",
  "meshrix.agent.workspace.read": "read_only",
  "meshrix.result.export": "read_only",
  "meshrix.gateway.write": "safe_write",
  "meshrix.storage.write": "safe_write",
  "meshrix.agent.workspace": "safe_write",
  "meshrix.gateway.maintain": "repair_write"
});

const RISK_RANK = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

function captureResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body || "");
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    }
  };
}

function localPairingRequest(headers = {}) {
  return {
    headers: {
      host: "127.0.0.1:7391",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function bridgeClientRequest(headers = {}) {
  return {
    headers: {
      host: "127.0.0.1:7391",
      ...headers
    },
    socket: { remoteAddress: "172.18.0.1" }
  };
}

function createRegistry() {
  let resolvedToolIds = [];
  const toolsets = Object.keys(TOOLSET_RISK).map((id) => ({ id, grantable: true }));
  return {
    setResolvedToolIds(toolIds = []) {
      resolvedToolIds = [...toolIds];
    },
    listToolsets: () => toolsets,
    resolveToolset(input = {}) {
      const selected = [...new Set(input.toolsets || [])];
      const maxRisk = selected.reduce((max, toolsetId) => {
        const risk = TOOLSET_RISK[toolsetId] || "read_only";
        return RISK_RANK[risk] > RISK_RANK[max] ? risk : max;
      }, "read_only");
      return {
        toolsets: selected,
        tools: [],
        toolIds: [...resolvedToolIds],
        requiredScopes: selected.map((toolsetId) => `${toolsetId}:scope`),
        maxRisk
      };
    }
  };
}

function createProvider({ securityPermissions } = {}) {
  let authorizationRequest = null;
  const registry = createRegistry();
  const store = {
    createGrant: vi.fn(async (grant) => {
      const target = grant.metadata?.mcpTarget || "target";
      return {
        grant: { id: `grant-${target}`, tokenPrefix: `tok_${target}_`, ...grant },
        token: `token-${target}`
      };
    }),
    revokeGrant: vi.fn(async () => ({ id: "revoked-grant" })),
    authorizeRequest: vi.fn(async () => ({
      ok: true,
      grant: {
        id: "grant-codex",
        type: "machine",
        enabled: true,
        metadata: {
          issuedBy: "meshrix-mcp-local-pairing",
          targets: ["codex"],
          mcpTarget: "codex"
        }
      }
    })),
    listGrants: vi.fn(() => [{
      id: "grant-codex",
      type: "machine",
      enabled: true,
      metadata: {
        issuedBy: "meshrix-mcp-local-pairing",
        targets: ["codex"],
        mcpTarget: "codex"
      }
    }]),
    updateGrant: vi.fn(async (grantId, patch) => ({ id: grantId, ...patch })),
    createMcpAuthorizationRequest: vi.fn((input) => {
      authorizationRequest = {
        requestId: "mcp_auth_req_test",
        status: "pending",
        requestKind: input.requestKind || "generic",
        requestedTools: input.requestedTools || [],
        requestPayload: input.requestPayload || {},
        claimTokenHash: input.claimTokenHash || "",
        expiresAt: input.expiresAt || ""
      };
      return {
        requestId: authorizationRequest.requestId,
        status: authorizationRequest.status,
        expiresAt: authorizationRequest.expiresAt
      };
    }),
    getMcpAuthorizationRequest: vi.fn(() => authorizationRequest ? { ...authorizationRequest } : null),
    resolveMcpAuthorizationRequest: vi.fn(({ resolution, resolvedBy = "" }) => {
      if (!authorizationRequest || authorizationRequest.status !== "pending") return false;
      authorizationRequest.status = resolution;
      authorizationRequest.resolvedBy = resolvedBy;
      return true;
    }),
    claimMcpAuthorizationRequest: vi.fn(({ claimTokenHash }) => {
      if (!authorizationRequest || authorizationRequest.claimTokenHash !== claimTokenHash) {
        return { claimed: false, status: "not_found", request: null };
      }
      if (
        authorizationRequest.status === "consumed" &&
        authorizationRequest.replayEnvelope &&
        Date.parse(authorizationRequest.replayExpiresAt) > Date.now()
      ) {
        return {
          claimed: false,
          replayable: true,
          status: "consumed",
          request: { ...authorizationRequest }
        };
      }
      if (authorizationRequest.status !== "approved") {
        return { claimed: false, status: authorizationRequest.status, request: { ...authorizationRequest } };
      }
      authorizationRequest.status = "issuing";
      return { claimed: true, status: "issuing", request: { ...authorizationRequest } };
    }),
    completeMcpAuthorizationRequest: vi.fn(({ status, replayEnvelope = "", replayExpiresAt = "" }) => {
      if (!authorizationRequest || authorizationRequest.status !== "issuing") return false;
      authorizationRequest.status = status;
      authorizationRequest.replayEnvelope = replayEnvelope;
      authorizationRequest.replayExpiresAt = replayExpiresAt;
      return true;
    })
  };
  const provider = createToolSkillManagementProvider({
    operationPermissionPlatform: {
      registry,
      store,
      securityPermissions
    },
    securityPermissions
  });
  return { provider, registry, store };
}

function processIdentityPermissions(extra = {}) {
  return {
    ...extra,
    processIdentity: {
      issueLocalMcpClientIdentityPackage: vi.fn(async ({ input = {} } = {}) => ({
        ok: true,
        protocolVersion: "test-process-identity",
        serverIdentity: {},
        clientIdentityPackage: {
          packageId: `pkg-${input.clientId || "client"}`,
          clientId: input.clientId || "client",
          processKey: { processKeyId: `process-key-${input.clientId || "client"}` }
        }
      })),
      revokeIssuedLocalMcpClientIdentityPackage: vi.fn(async () => ({ ok: true }))
    }
  };
}

async function createLocalGrant(provider, body, headers = {}) {
  return provider.createLocalMcpGrant({
    request: localPairingRequest(headers),
    requestBody: Buffer.from(JSON.stringify(body)),
    url: new URL("http://127.0.0.1:7391/api/mcp/local-grant")
  });
}

describe("P2 security boundaries", () => {
  it("does not treat a system actor or a caller-provided skip flag as authority", async () => {
    const auditStore = { recordDecision: vi.fn(async () => {}) };
    const pep = createPolicyEnforcementPoint({ auditStore });
    const result = await pep.enforce({
      operation: {
        id: "security.system_actor_boundary",
        risk: "safe_write",
        requiredScopes: ["security:write"],
        requiredCapabilities: ["cap:api:security.system_actor_boundary"]
      },
      subject: {
        type: "system",
        subjectId: "system-worker",
        scopes: [],
        capabilities: []
      },
      skipAuthorization: true
    });

    expect(result.allowed).toBe(false);
    expect(result.decision.reasonCode).toBe("missing_scopes");
    expect(auditStore.recordDecision).toHaveBeenCalledOnce();
  });

  it("defaults authenticated known local MCP targets to read-only toolsets", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: true }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });

    const result = await createLocalGrant(provider, {
      targets: ["codex"],
      processIdentity: { processPublicKeyPem: "public-key" }
    });

    expect(result.status).toBe(201);
    expect(result.body.maxRisk).toBe("read_only");
    expect(result.body.toolsets).toEqual([
      "meshrix.runtime.read",
      "meshrix.storage.read",
      "meshrix.jobs.read",
      "meshrix.gateway.read",
      "meshrix.agent.workspace.read",
      "meshrix.result.export"
    ]);
    expect(result.body.toolsets).not.toContain("meshrix.gateway.write");
    expect(result.body.toolsets).not.toContain("upstream-mcp");
    expect(result.body.targetMatch.matchedTargetDetails[0].maxRisk).toBe("read_only");
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(store.createGrant).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated read-only local MCP grants before identity or grant issuance", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: false, status: 401, error: "unauthenticated" }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });

    const result = await createLocalGrant(provider, {
      targets: ["codex"],
      processIdentity: { processPublicKeyPem: "caller-owned-public-key" }
    });

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("console_unauthenticated");
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage).not.toHaveBeenCalled();
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("rejects forged local pairing Host and Origin headers before authorization", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: true }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });
    const body = {
      targets: ["codex"],
      processIdentity: { processPublicKeyPem: "public-key" }
    };

    const forgedHost = await createLocalGrant(provider, body, { host: "example.invalid" });
    const forgedOrigin = await createLocalGrant(provider, body, { origin: "http://example.invalid" });

    expect(forgedHost.status).toBe(403);
    expect(forgedHost.body.error.code).toBe("local_pairing_required");
    expect(forgedOrigin.status).toBe(403);
    expect(forgedOrigin.body.error.code).toBe("local_pairing_required");
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("rejects every proxied local pairing request including multi-hop loopback-first spoofing", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: true }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });
    const result = await createLocalGrant(provider, {
      targets: ["codex"],
      processIdentity: { processPublicKeyPem: "public-key" }
    }, {
      "x-forwarded-for": "127.0.0.1, 198.51.100.44",
      "x-real-ip": "198.51.100.44"
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("local_pairing_required");
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("admits direct bridge peers only to the approved device flow, not direct grant issuance", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: true }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });
    const claimToken = "bridge_peer_device_claim_abcdefghijklmnopqrstuvwxyz";
    const body = {
      targets: ["codex"],
      processIdentity: { processPublicKeyPem: "bridge-public-key" }
    };

    const directGrant = await provider.createLocalMcpGrant({
      request: bridgeClientRequest(),
      requestBody: Buffer.from(JSON.stringify(body)),
      url: new URL("http://127.0.0.1:7391/api/mcp/local-grant")
    });
    const deviceRequest = provider.createLocalMcpGrantAuthorizationRequest({
      request: bridgeClientRequest(),
      requestBody: Buffer.from(JSON.stringify({
        ...body,
        claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
      }))
    });

    await provider.resolveMcpAuthorizationRequest({
      requestId: deviceRequest.body.requestId,
      resolution: "approved"
    }, {
      authSession: { user: { username: "owner" } }
    });
    const consumed = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: bridgeClientRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: deviceRequest.body.requestId
    });

    expect(directGrant.status).toBe(403);
    expect(deviceRequest.status).toBe(202);
    expect(consumed.status).toBe(201);
    expect(consumed.body.targets).toEqual(["codex"]);
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(store.createGrant).toHaveBeenCalledOnce();
  });

  it("rejects forwarded metadata on bridge device authorization requests", () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const result = provider.createLocalMcpGrantAuthorizationRequest({
      request: bridgeClientRequest({
        "x-forwarded-for": "127.0.0.1, 198.51.100.44",
        "x-forwarded-port": "7391"
      }),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "public-key" },
        claimTokenHash: hashLocalMcpAuthorizationClaim(
          "forwarded_bridge_claim_abcdefghijklmnopqrstuvwxyz"
        )
      }))
    });
    const originMismatch = provider.createLocalMcpGrantAuthorizationRequest({
      request: bridgeClientRequest({ origin: "https://example.invalid" }),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "public-key" },
        claimTokenHash: hashLocalMcpAuthorizationClaim(
          "origin_bridge_claim_abcdefghijklmnopqrstuvwxyz"
        )
      }))
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("local_pairing_required");
    expect(originMismatch.status).toBe(403);
    expect(originMismatch.body.error.code).toBe("local_pairing_required");
    expect(store.createMcpAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("allows a direct bridge uninstall only with the bound grant authorization path", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const requestBody = Buffer.from(JSON.stringify({
      targets: ["codex"],
      connectorVersion: "test"
    }));

    const result = await provider.markLocalMcpGrantUninstalled({
      request: bridgeClientRequest({
        authorization: "Bearer test-token",
        "x-meshrix-mcp-target": "codex",
        "x-meshrix-process-key-id": "process-key"
      }),
      requestBody,
      url: new URL("http://127.0.0.1:7391/api/mcp/local-uninstall"),
      method: "POST"
    });
    const originMismatch = await provider.markLocalMcpGrantUninstalled({
      request: bridgeClientRequest({
        authorization: "Bearer test-token",
        "x-meshrix-mcp-target": "codex",
        "x-meshrix-process-key-id": "process-key",
        origin: "https://example.invalid"
      }),
      requestBody,
      url: new URL("http://127.0.0.1:7391/api/mcp/local-uninstall"),
      method: "POST"
    });
    const forwarded = await provider.markLocalMcpGrantUninstalled({
      request: bridgeClientRequest({
        authorization: "Bearer test-token",
        "x-meshrix-mcp-target": "codex",
        "x-meshrix-process-key-id": "process-key",
        "x-forwarded-port": "7391"
      }),
      requestBody,
      url: new URL("http://127.0.0.1:7391/api/mcp/local-uninstall"),
      method: "POST"
    });

    expect(result.status).toBe(200);
    expect(originMismatch.status).toBe(403);
    expect(originMismatch.body.error.code).toBe("local_pairing_required");
    expect(forwarded.status).toBe(403);
    expect(forwarded.body.error.code).toBe("local_pairing_required");
    expect(store.authorizeRequest).toHaveBeenCalledOnce();
    expect(store.updateGrant).toHaveBeenCalledOnce();
  });

  it("uninstalls only the authenticated installation when another grant shares the target", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const authorizedGrant = {
      id: "grant-codex-device-a",
      type: "machine",
      enabled: true,
      metadata: {
        issuedBy: "meshrix-mcp-local-pairing",
        targets: ["codex"],
        mcpTarget: "codex"
      }
    };
    store.authorizeRequest.mockResolvedValueOnce({ ok: true, grant: authorizedGrant });
    store.listGrants.mockReturnValueOnce([
      authorizedGrant,
      {
        ...authorizedGrant,
        id: "grant-codex-device-b"
      }
    ]);

    const result = await provider.markLocalMcpGrantUninstalled({
      request: bridgeClientRequest({ authorization: "Bearer test-token" }),
      requestBody: Buffer.from(JSON.stringify({ targets: ["codex"] })),
      url: new URL("http://127.0.0.1:7391/api/mcp/local-uninstall"),
      method: "POST"
    });

    expect(result.status).toBe(200);
    expect(result.body.authorizedGrantId).toBe("grant-codex-device-a");
    expect(store.updateGrant).toHaveBeenCalledOnce();
    expect(store.updateGrant).toHaveBeenCalledWith(
      "grant-codex-device-a",
      expect.objectContaining({ enabled: false })
    );
    expect(store.listGrants).not.toHaveBeenCalled();
  });

  it("issues multi-target local MCP grants in one authorization batch while keeping per-target identity binding", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: true }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });

    const result = await createLocalGrant(provider, {
      targets: ["codex", "opencode"],
      toolsets: ["meshrix.gateway.write"],
      processIdentities: {
        codex: { processPublicKeyPem: "codex-public-key" },
        opencode: { processPublicKeyPem: "opencode-public-key" }
      }
    }, {
      "x-meshrix-safety-confirm": "true"
    });

    expect(result.status).toBe(201);
    expect(result.body.batch).toBe(true);
    expect(result.body.authorizationBatch).toMatchObject({
      singleAuthorizationRequest: true,
      perTargetGrantIsolation: true,
      targetCount: 2
    });
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(store.createGrant).toHaveBeenCalledTimes(2);
    expect(securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.body.targetGrants).sort()).toEqual(["codex", "opencode"]);
    expect(result.body.targetGrants.codex.token).toBe("token-codex");
    expect(result.body.targetGrants.opencode.token).toBe("token-opencode");
    expect(result.body.targetGrants.codex.targets).toEqual(["codex"]);
    expect(result.body.targetGrants.opencode.targets).toEqual(["opencode"]);
    expect(result.body.targetGrants.codex.processIdentity.clientIdentityPackage.clientId).toBe("codex");
    expect(result.body.targetGrants.opencode.processIdentity.clientIdentityPackage.clientId).toBe("opencode");
  });

  it("rejects write-capable local MCP grants when console authorization is unavailable", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });

    const result = await createLocalGrant(provider, {
      targets: ["codex"],
      toolsets: ["meshrix.gateway.write"],
      processIdentity: { processPublicKeyPem: "public-key" }
    }, {
      "x-meshrix-safety-confirm": "true"
    });

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("console_authorization_unavailable");
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("creates an immutable device authorization request and replays the same encrypted result after response loss", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const claimToken = "device_claim_abcdefghijklmnopqrstuvwxyz0123456789";
    const requestBody = {
      targets: ["codex"],
      processIdentity: { processPublicKeyPem: "device-public-key" },
      claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
    };

    const pending = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify(requestBody))
    });

    expect(pending.status).toBe(202);
    expect(store.createGrant).not.toHaveBeenCalled();
    expect(securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage).not.toHaveBeenCalled();
    expect(store.createMcpAuthorizationRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestKind: "local_mcp_install",
      requestPayload: expect.objectContaining({
        body: expect.objectContaining({
          targets: ["codex"],
          toolsets: [],
          scopes: [],
          maxRisk: ""
        }),
        summary: expect.objectContaining({
          targets: ["codex"],
          toolsets: expect.arrayContaining(["meshrix.runtime.read"]),
          maxRisk: "read_only"
        })
      })
    }));

    await expect(provider.resolveMcpAuthorizationRequest({
      requestId: pending.body.requestId,
      resolution: "approved"
    }, {
      authSession: { user: { username: "owner" } }
    })).resolves.toMatchObject({ success: true, requestKind: "local_mcp_install" });
    expect(store.createGrant).not.toHaveBeenCalled();

    const wrongClaim = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": `${claimToken}x` }),
      requestId: pending.body.requestId
    });
    expect(wrongClaim.status).toBe(404);
    expect(store.createGrant).not.toHaveBeenCalled();

    const issued = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: pending.body.requestId
    });
    expect(issued.status).toBe(201);
    expect(issued.body.targets).toEqual(["codex"]);
    expect(issued.body.authorizationRequestId).toBe(pending.body.requestId);
    expect(store.createGrant).toHaveBeenCalledOnce();

    const replay = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: pending.body.requestId
    });
    expect(replay).toEqual(issued);
    expect(store.createGrant).toHaveBeenCalledOnce();
  });

  it("rejects oversized or non-canonical process identity payloads before persistence", () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const claimTokenHash = hashLocalMcpAuthorizationClaim(
      "bounded_device_claim_abcdefghijklmnopqrstuvwxyz"
    );
    const oversized = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: {
          processPublicKeyPem: "x".repeat(64 * 1024)
        },
        claimTokenHash
      }))
    });
    const unknownNestedField = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: {
          processPublicKeyPem: "public-key",
          retainedPayload: "not-canonical"
        },
        claimTokenHash
      }))
    });

    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe("local_grant_request_too_large");
    expect(unknownNestedField.status).toBe(400);
    expect(unknownNestedField.body.error.code).toBe("process_identity_schema_invalid");
    expect(store.createMcpAuthorizationRequest).not.toHaveBeenCalled();
  });

  it("assigns distinct verification codes to concurrent same-name installation requests", () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const body = (claimToken) => Buffer.from(JSON.stringify({
      targets: ["codex"],
      label: "same visible client",
      processIdentity: { processPublicKeyPem: "same-public-key-label" },
      claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
    }));

    const first = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: body("first_device_claim_abcdefghijklmnopqrstuvwxyz")
    });
    const second = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: body("second_device_claim_abcdefghijklmnopqrstuvwxyz")
    });

    expect(first.body.verificationCode).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/u);
    expect(second.body.verificationCode).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/u);
    expect(first.body.verificationCode).not.toBe(second.body.verificationCode);
    expect(store.createMcpAuthorizationRequest.mock.calls[0][0].requestPayload.summary.verificationCode)
      .toBe(first.body.verificationCode);
    expect(store.createMcpAuthorizationRequest.mock.calls[1][0].requestPayload.summary.verificationCode)
      .toBe(second.body.verificationCode);
  });

  it("revokes issued credentials when authorization completion loses its CAS", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const claimToken = "completion_conflict_claim_abcdefghijklmnopqrstuvwxyz";
    const pending = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "public-key" },
        claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
      }))
    });
    await provider.resolveMcpAuthorizationRequest({
      requestId: pending.body.requestId,
      resolution: "approved"
    }, {
      authSession: { user: { username: "owner" } }
    });
    store.completeMcpAuthorizationRequest.mockReturnValueOnce(false);

    const result = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: pending.body.requestId
    });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("authorization_request_completion_conflict");
    expect(store.revokeGrant).toHaveBeenCalledWith(
      "grant-codex",
      "local_mcp_authorization_batch_rolled_back"
    );
    expect(securityPermissions.processIdentity.revokeIssuedLocalMcpClientIdentityPackage)
      .toHaveBeenCalledOnce();
  });

  it("revokes issued credentials when authorization completion persistence throws", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const claimToken = "completion_throw_claim_abcdefghijklmnopqrstuvwxyz";
    const pending = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "public-key" },
        claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
      }))
    });
    await provider.resolveMcpAuthorizationRequest({
      requestId: pending.body.requestId,
      resolution: "approved"
    }, {
      authSession: { user: { username: "owner" } }
    });
    store.completeMcpAuthorizationRequest.mockImplementation(() => {
      throw new Error("completion persistence failed");
    });

    await expect(provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: pending.body.requestId
    })).rejects.toThrow("completion persistence failed");
    expect(store.revokeGrant).toHaveBeenCalledWith(
      "grant-codex",
      "local_mcp_authorization_batch_rolled_back"
    );
    expect(securityPermissions.processIdentity.revokeIssuedLocalMcpClientIdentityPackage)
      .toHaveBeenCalledOnce();
  });

  it("fails closed when an approved request payload is rebound before consumption", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, store } = createProvider({ securityPermissions });
    const claimToken = "immutable_request_claim_abcdefghijklmnopqrstuvwxyz";
    const pending = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "codex-public-key" },
        claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
      }))
    });
    const stored = store.getMcpAuthorizationRequest();
    stored.requestPayload.body.targets = ["opencode"];
    stored.requestPayload.body.processIdentities = {
      opencode: { processPublicKeyPem: "attacker-public-key" }
    };
    await provider.resolveMcpAuthorizationRequest({
      requestId: pending.body.requestId,
      resolution: "approved"
    }, {
      authSession: { user: { username: "owner" } }
    });

    const result = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: pending.body.requestId
    });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("authorization_request_policy_changed");
    expect(store.createGrant).not.toHaveBeenCalled();
    expect(securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage).not.toHaveBeenCalled();
  });

  it("fails closed when a toolset resolves to different tool IDs after approval", async () => {
    const securityPermissions = processIdentityPermissions();
    const { provider, registry, store } = createProvider({ securityPermissions });
    registry.setResolvedToolIds(["tool.before-approval"]);
    const claimToken = "tool_catalog_drift_claim_abcdefghijklmnopqrstuvwxyz";
    const pending = provider.createLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest(),
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "public-key" },
        claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
      }))
    });
    await provider.resolveMcpAuthorizationRequest({
      requestId: pending.body.requestId,
      resolution: "approved"
    }, {
      authSession: { user: { username: "owner" } }
    });
    registry.setResolvedToolIds(["tool.after-approval"]);

    const result = await provider.consumeLocalMcpGrantAuthorizationRequest({
      request: localPairingRequest({ "x-meshrix-authorization-claim": claimToken }),
      requestId: pending.body.requestId
    });

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("authorization_request_policy_changed");
    expect(store.createGrant).not.toHaveBeenCalled();
    expect(securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage).not.toHaveBeenCalled();
  });

  it("denies unauthenticated direct local grants at the HTTP adapter boundary", async () => {
    const securityPermissions = processIdentityPermissions({
      authorizeOperation: vi.fn(async () => ({ ok: false, status: 401, error: "unauthenticated" }))
    });
    const { provider, store } = createProvider({ securityPermissions });
    const response = captureResponse();

    const handled = await handleLicoMcpHttpRequest({
      request: localPairingRequest(),
      response,
      requestBody: Buffer.from(JSON.stringify({
        targets: ["codex"],
        processIdentity: { processPublicKeyPem: "caller-owned-public-key" }
      })),
      method: "POST",
      url: new URL("http://127.0.0.1:7391/api/mcp/local-grant"),
      toolSkillManagementProvider: provider
    });

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("console_unauthenticated");
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("rolls back earlier grants and all issued process identities when a multi-target batch fails", async () => {
    const authorizeOperation = vi.fn(async () => ({ ok: true }));
    const securityPermissions = processIdentityPermissions({ authorizeOperation });
    const { provider, store } = createProvider({ securityPermissions });
    store.createGrant
      .mockResolvedValueOnce({
        grant: { id: "grant-codex", tokenPrefix: "tok_codex_" },
        token: "token-codex"
      })
      .mockRejectedValueOnce(new Error("grant write failed"));

    await expect(createLocalGrant(provider, {
      targets: ["codex", "opencode"],
      processIdentities: {
        codex: { processPublicKeyPem: "codex-public-key" },
        opencode: { processPublicKeyPem: "opencode-public-key" }
      }
    })).rejects.toThrow("grant write failed");

    expect(store.revokeGrant).toHaveBeenCalledWith(
      "grant-codex",
      "local_mcp_authorization_batch_rolled_back"
    );
    expect(securityPermissions.processIdentity.revokeIssuedLocalMcpClientIdentityPackage)
      .toHaveBeenCalledTimes(2);
  });

  it("requires maintenance admin for global work queue control at the controller boundary", async () => {
    const pauseWorkQueue = vi.fn(async () => ({ ok: true }));
    const handlers = createWorkQueueHandlers({ jobWorkflow: { pauseWorkQueue } });
    const denied = captureResponse();

    await handlers.handlePauseWorkQueue({
      requestBody: Buffer.from("{}"),
      response: denied,
      authSession: {
        user: {
          roleId: "operator",
          scopes: ["jobs:read", "jobs:write"]
        }
      }
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("work_queue_admin_required");
    expect(pauseWorkQueue).not.toHaveBeenCalled();

    const allowed = captureResponse();
    await handlers.handlePauseWorkQueue({
      requestBody: Buffer.from("{}"),
      response: allowed,
      authSession: {
        user: {
          roleId: "operator",
          scopes: ["jobs:read", "jobs:write", "maintenance:admin"]
        }
      }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ ok: true });
    expect(pauseWorkQueue).toHaveBeenCalledOnce();
  });

  it("redacts local diagnostic fields from console and runtime status projections", async () => {
    const userDataPath = path.resolve("<user-data>");
    const distPath = path.resolve("<console-dist>");
    const context = {
      userDataPath,
      distPath,
      runtime: null,
      moduleManagement: null,
      discoveryState: {
        offlineAfterSeconds: 30,
        manifestPath: path.join(userDataPath, "device", "servers.json"),
        backendLocation: path.join(userDataPath, "discovery")
      },
      storageProvider: {
        getStorageSummary: () => ({
          databasePath: path.join(userDataPath, "metadata", "meshrix.sqlite"),
          objectRootPath: path.join(userDataPath, "objects"),
          backendLocation: path.join(userDataPath, "storage"),
          databaseExists: true,
          objectCount: 7,
          ownedObjectCount: 6,
          deletionOperationCount: 1,
          objectFileCount: 7,
          objectBytes: 4096
        })
      },
      features: {
        activeFeatureIds: ["sample-extension"],
        plugins: {
          consoleEntries: [{
            id: "admin.sample-extension",
            routePath: "/admin/sample-extension",
            filePath: path.join(userDataPath, "plugins", "sample-extension.json"),
            userDataPath,
            path: path.join(userDataPath, "plugins"),
            manifestPath: path.join(userDataPath, "plugins", "sample-extension-manifest.json")
          }]
        }
      },
      serverUrl: "http://127.0.0.1:7391",
      consoleDomainServices: {
        buildAgentSettingsConsoleProjection: async () => ({
          settings: { path: path.join(userDataPath, "settings.json"), value: {} },
          agentSelector: {},
          agentConfigs: {
            rootPath: path.join(userDataPath, "agents"),
            modelListPath: path.join(userDataPath, "models.json"),
            agentListPath: path.join(userDataPath, "agents.json")
          }
        }),
        buildRuntimeConsoleSummary: async () => ({
          rootPath: path.join(userDataPath, "runtime"),
          ok: true
        })
      }
    };

    const consoleState = await buildConsoleState(context);
    const runtimeInfo = await buildRuntimeInfo(context);
    const serialized = JSON.stringify({ consoleState, runtimeInfo });

    expect(serialized).not.toContain(userDataPath);
    expect(serialized).not.toContain(distPath);
    expect(serialized).not.toContain("hostname");
    expect(consoleState.server).toEqual({
      url: "http://127.0.0.1:7391",
      localDiagnostics: false
    });
    expect(runtimeInfo.server).toEqual({
      url: "http://127.0.0.1:7391",
      localDiagnostics: false
    });
    expect(consoleState.discovery.value).toEqual({ offlineAfterSeconds: 30 });
    expect(consoleState.storage).toEqual({
      databaseExists: true,
      objectCount: 7,
      ownedObjectCount: 6,
      deletionOperationCount: 1,
      objectFileCount: 7,
      objectBytes: 4096
    });
    expect(runtimeInfo.storage).toEqual(consoleState.storage);
    expect(consoleState.features.plugins.consoleEntries[0]).toEqual({
      id: "admin.sample-extension",
      routePath: "/admin/sample-extension"
    });
  });

  it("projects console-readable storage and discovery operations without server filesystem paths", async () => {
    const privateRoot = path.resolve("<user-data>");
    const storageProvider = {
      getStorageSummary: () => ({
        databasePath: `${privateRoot}/metadata/meshrix.sqlite`,
        objectRootPath: `${privateRoot}/objects`,
        databaseExists: true,
        objectCount: 2,
        ownedObjectCount: 1,
        deletionOperationCount: 0,
        objectFileCount: 2,
        objectBytes: 256
      }),
      runDoctor: async () => ({
        userDataPath: privateRoot,
        databasePath: `${privateRoot}/metadata/meshrix.sqlite`,
        jobsRootPath: `${privateRoot}/jobs`,
        objectRootPath: `${privateRoot}/objects`,
        databasePresent: true,
        summary: {
          objectCount: 2,
          ownedObjectCount: 1,
          deletionOperationCount: 0,
          objectFileCount: 2,
          objectBytes: 256,
          jobDirectoryCount: 1
        },
        issues: {
          missingJobMeta: [{ jobId: "job-1", path: `${privateRoot}/jobs/job-1/meta.json` }],
          databaseMissing: [{ databasePath: `${privateRoot}/metadata/meshrix.sqlite` }]
        },
        healthy: false
      })
    };

    const summary = await executeStorageOperation({
      operationId: "storage.summary",
      input: {},
      context: { storageProvider }
    });
    const doctor = await executeStorageOperation({
      operationId: "storage.doctor",
      input: {},
      context: { storageProvider }
    });
    const discovery = await executeDiscoveryOperation({
      operationId: "discovery.get_config",
      input: {},
      context: {
        userDataPath: privateRoot,
        discoveryState: {
          serverId: "server-1",
          serverLabel: "Primary",
          mode: "active",
          configVersion: "revision-1",
          offlineAfterSeconds: 30,
          configFile: `${privateRoot}/discovery.json`
        }
      }
    });

    expect(summary).toEqual({
      status: 200,
      payload: {
        databaseExists: true,
        objectCount: 2,
        ownedObjectCount: 1,
        deletionOperationCount: 0,
        objectFileCount: 2,
        objectBytes: 256
      }
    });
    expect(doctor).toMatchObject({
      status: 200,
      payload: {
        databasePresent: true,
        summary: { objectCount: 2, jobDirectoryCount: 1 },
        issues: {
          missingJobMeta: [{ jobId: "job-1" }],
          databaseMissing: [{}]
        },
        healthy: false
      }
    });
    expect(discovery.payload).not.toHaveProperty("path");
    expect(discovery.payload.value).toEqual({
      serverId: "server-1",
      serverLabel: "Primary",
      mode: "active",
      configVersion: "revision-1",
      offlineAfterSeconds: 30
    });
    expect(JSON.stringify({ summary, doctor, discovery })).not.toContain(privateRoot);
  });
});
