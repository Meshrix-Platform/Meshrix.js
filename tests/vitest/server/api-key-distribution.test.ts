import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";
import { createMemoryApiKeyVerifierKeyProvider } from "../../../packages/foundation/src/security/authorization/api-key-verifier-key-provider.ts";
import {
  API_KEY_MANAGEMENT_ACTION,
  evaluateApiKeyIssuerScopes
} from "../../../packages/foundation/src/security/authorization/api-key-issuer-authority.ts";
import {
  createApiKeyDistributionProvider,
  parseApiKeyCredential,
  registerApiKeyOwnerRecoveryAssignmentSync
} from "../../../packages/capabilities/src/operation-permission-core/api-key-distribution.ts";
import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { ensureSchema } from "../../../packages/capabilities/src/operation-permission-core/store-schema.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { STRATEGY_PERMISSION_OPERATION_DEFINITIONS } from "../../../packages/contracts/src/operations/strategy-permission-operation-definitions.ts";

const temporaryDirectories: string[] = [];

afterEach(() : any => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function governanceFixture(): any {
  let configured: any = true;
  let organizationRevision: any = 7;
  let authorizationRevision: any = 11;
  let nodes: any[] = [
    { nodeId: "root", nodeType: "group", parentId: "", name: "Root" },
    { nodeId: "issuer", nodeType: "organization", parentId: "root", name: "Issuer" },
    { nodeId: "child", nodeType: "department", parentId: "issuer", name: "Child" },
    { nodeId: "peer", nodeType: "organization", parentId: "root", name: "Peer" }
  ];
  const roles: any[] = [{
    roleId: "key-manager",
    name: "Key manager",
    scopeNodeId: "issuer",
    scopeNodeType: "organization",
    managementActions: [API_KEY_MANAGEMENT_ACTION]
  }];
  return {
    securityPermissions: {
      getOrganizationGovernance: () : any => ({
        configured,
        revision: organizationRevision,
        nodes,
        roles
      }),
      getGovernanceSummary: () : any => ({
        policyRevision: { revision: authorizationRevision, updatedAt: "2026-08-03T00:00:00.000Z" },
        roles: roles.map((role?: any) : any => ({ ...role, enabled: true })),
        userPolicies: [{ userId: "admin", enabled: true, roleIds: ["key-manager"] }],
        apiKeyRecoveryAssignments: []
      }),
      getGovernancePolicyRevision: () : any => ({ revision: authorizationRevision }),
      verifyProcessIdentity: (evidence: any) : any => evidence
    },
    setUnconfigured() : any { configured = false; organizationRevision = 0; nodes = []; },
    moveChildToPeer() : any {
      nodes = nodes.map((node?: any) : any => node.nodeId === "child" ? { ...node, parentId: "peer" } : node);
      organizationRevision += 1;
    },
    bumpAuthorization() : any { authorizationRevision += 1; }
  };
}

function policy(catalogFingerprint = "catalog-1", overrides: Record<string, any> = {}): any {
  return {
    protocol: "mcp",
    serviceIds: [],
    capabilityIds: [],
    toolsetIds: [],
    allowedTools: ["tools.echo"],
    deniedTools: [],
    scopeIds: [],
    maximumRisk: "high",
    audience: {
      serverAudience: "https://meshrix.invalid",
      targetIds: ["server"],
      connectorPackageIds: []
    },
    resources: {
      mode: "restricted",
      workspaceIds: ["workspace-1"],
      dataClassifications: [],
      egressClasses: [],
      semanticFamilies: [],
      capabilityDomains: [],
      capabilityVerbs: [],
      resourceKinds: [],
      effectKinds: [],
      secretBindingIds: [],
      allowedOrigins: [],
      allowedCidrs: []
    },
    processIdentity: { mode: "optional" },
    limits: {
      maxUses: 2,
      requestsPerWindow: 2,
      windowSeconds: 60,
      maxConcurrentEffects: 1
    },
    catalogFingerprint,
    ...overrides
  };
}

function harness(): any {
  const directory: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-api-key-"));
  temporaryDirectories.push(directory);
  const db: any = openSqliteDatabase(path.join(directory, "permission.sqlite"));
  ensureSchema(db);
  const governance: any = governanceFixture();
  let timestamp: any = Date.parse("2026-08-03T00:00:00.000Z");
  let randomCounter: any = 0;
  const registry: any = {
    getCatalog: () : any => ({
      fingerprint: "catalog-1",
      tools: [{ id: "tools.echo" }],
      toolsets: [],
      scopes: []
    })
  };
  const provider: any = createApiKeyDistributionProvider({
    store: { db },
    registry,
    securityPermissions: governance.securityPermissions,
    verifierKeyProvider: createMemoryApiKeyVerifierKeyProvider(Buffer.alloc(32, 91)),
    now: () : any => timestamp,
    randomBytes(size: number) : any {
      randomCounter += 1;
      return Buffer.alloc(size, randomCounter);
    }
  });
  return {
    db,
    governance,
    provider,
    advance(ms: number) : any { timestamp += ms; },
    close() : any { db.close(); }
  };
}

describe("scoped API Key distribution", () : any => {
  it("grants the enabled owner a server-authored recovery scope when organization governance is published after startup", () : any => {
    let organization: any = { configured: false, revision: 0, nodes: [] };
    let listener: any = null;
    const assignments: any[] = [];
    const unsubscribe: any = registerApiKeyOwnerRecoveryAssignmentSync({
      securityPermissions: {
        getOrganizationGovernance: () : any => organization,
        listUsers: () : any => [
          { userId: "owner-user", roleId: "owner", enabled: true },
          { userId: "viewer-user", roleId: "viewer", enabled: true }
        ],
        authorizationGovernanceStore: {
          listApiKeyRecoveryAssignments: () : any => assignments,
          upsertApiKeyRecoveryAssignment(input: any) : any {
            assignments.push({ ...input, serverAuthored: true });
          }
        },
        tagManagementStore: {
          registerChangeHandler(handler: any) : any {
            listener = handler;
            return () : any => { listener = null; };
          }
        }
      }
    });

    expect(assignments).toEqual([]);
    organization = {
      configured: true,
      revision: 1,
      nodes: [
        { nodeId: "organization:group", nodeType: "group", parentId: "" },
        { nodeId: "group:team", nodeType: "team", parentId: "organization:group" }
      ]
    };
    listener({ eventType: "organization-governance-published" });
    listener({ eventType: "organization-governance-published" });
    expect(assignments).toEqual([{
      subjectId: "owner-user",
      rootNodeId: "organization:group",
      action: API_KEY_MANAGEMENT_ACTION,
      enabled: true,
      serverAuthored: true
    }]);
    unsubscribe();
    expect(listener).toBeNull();
  });

  it("projects an uninitialized organization as an empty issuer scope instead of a service failure", async () : Promise<any> => {
    const fixture: any = harness();
    fixture.governance.setUnconfigured();
    await expect(fixture.provider.getIssuerScopes({ subjectId: "admin" })).resolves.toMatchObject({
      organizationRevision: 0,
      eligibleRoots: [],
      eligibleNodes: []
    });
    await expect(fixture.provider.list({ subjectId: "admin", limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: ""
    });
    fixture.close();
  });

  it("catalogs the owner-bound upload operations used by scoped API keys", () : any => {
    const tools: any = createToolCatalog({ operations: SERVER_API_OPERATIONS }).tools;
    const uploadTools: any = tools
      .filter((tool: any) => String(tool.operationId || "").startsWith("uploads."))
      .map((tool: any) => tool.id);
    expect(uploadTools).toEqual([
      "uploads.create_session",
      "uploads.get_session",
      "uploads.upload_chunk"
    ]);
  });

  it("uses login as the outer gate and delegates write authority to organization governance", () : any => {
    const operations: any[] = STRATEGY_PERMISSION_OPERATION_DEFINITIONS.filter((operation: any) =>
      String(operation.id || "").startsWith("operation_permission.api_keys."));
    expect(operations.map((operation: any) => operation.id)).toEqual([
      "operation_permission.api_keys.issuer_scopes",
      "operation_permission.api_keys.list",
      "operation_permission.api_keys.create",
      "operation_permission.api_keys.rotate",
      "operation_permission.api_keys.revoke"
    ]);
    expect(operations.every((operation: any) =>
      JSON.stringify(operation.requiredScopes) === JSON.stringify(["console:read"]))).toBe(true);
  });

  it("derives restricted issuer roots only from current explicit assignments", () : any => {
    const governance: any = governanceFixture();
    const allowed: any = evaluateApiKeyIssuerScopes({
      subjectId: "admin",
      organizationSnapshot: governance.securityPermissions.getOrganizationGovernance(),
      governanceSummary: governance.securityPermissions.getGovernanceSummary()
    });
    expect(allowed.roots.map((node: any) : any => node.nodeId)).toEqual(["issuer"]);
    expect(allowed.eligibleNodeIds).toEqual(["child", "issuer"]);
    const denied: any = evaluateApiKeyIssuerScopes({
      subjectId: "peer-user",
      organizationSnapshot: governance.securityPermissions.getOrganizationGovernance(),
      governanceSummary: governance.securityPermissions.getGovernanceSummary()
    });
    expect(denied.eligibleNodeIds).toEqual([]);

    const staleRole: any = evaluateApiKeyIssuerScopes({
      subjectId: "admin",
      organizationSnapshot: governance.securityPermissions.getOrganizationGovernance(),
      governanceSummary: {
        ...governance.securityPermissions.getGovernanceSummary(),
        roles: [{ roleId: "key-manager", enabled: true, scopeNodeId: "issuer", managementActions: [] }]
      }
    });
    expect(staleRole.eligibleNodeIds).toEqual([]);

    expect(() : any => evaluateApiKeyIssuerScopes({
      subjectId: "admin",
      organizationSnapshot: {
        ...governance.securityPermissions.getOrganizationGovernance(),
        nodes: [
          ...governance.securityPermissions.getOrganizationGovernance().nodes,
          { nodeId: "second-root", nodeType: "group", parentId: "", name: "Second root" }
        ]
      },
      governanceSummary: governance.securityPermissions.getGovernanceSummary()
    })).toThrowError(expect.objectContaining({ code: "api_key_authority_unavailable", statusCode: 503 }));
  });

  it("parses only the canonical mxak1 envelope", () : any => {
    const keyId: any = Buffer.alloc(16, 1).toString("base64url");
    const secret: any = Buffer.alloc(32, 2).toString("base64url");
    const valid: any = `mxak1.${keyId}.${secret}`;
    expect(parseApiKeyCredential(valid)).toEqual({ keyId, secret });
    for (const invalid of [
      ` ${valid}`,
      `${valid} `,
      valid.replace("mxak1", "mxak2"),
      `${valid}.extra`,
      valid.replace(keyId, `${keyId}=`),
      valid.replace(secret, secret.slice(0, -1)),
      valid.replace(secret[0], "+")
    ]) {
      expect(parseApiKeyCredential(invalid)).toBeNull();
    }
  });

  it("stores only an indexed irreversible verifier and returns plaintext once", async () : Promise<any> => {
    const current: any = harness();
    try {
      const created: any = await current.provider.create({
        subjectId: "admin",
        workloadDisplayName: "Neutral worker",
        organizationNodeId: "child",
        expiresAt: "2026-08-04T00:00:00.000Z",
        policy: policy()
      });
      const issuerScopes: any = await current.provider.getIssuerScopes({ subjectId: "admin" });
      expect(issuerScopes).toMatchObject({
        organizationRevision: 7,
        authorizationRevision: 11,
        catalogFingerprint: "catalog-1",
        eligibleRoots: [{ nodeId: "issuer", breadcrumb: ["Root", "Issuer"] }]
      });
      expect(Object.keys(issuerScopes).sort()).toEqual([
        "authorizationRevision", "authorizationUpdatedAt", "catalogFingerprint",
        "eligibleNodes", "eligibleRoots", "organizationRevision"
      ]);
      expect(issuerScopes.eligibleNodes.map((node: any) : any => node.nodeId)).toEqual(["child", "issuer"]);
      expect(parseApiKeyCredential(created.apiKey)?.keyId).toBe(created.record.keyId);
      expect(JSON.stringify(created.record)).not.toContain(created.apiKey);
      const durable: any = current.db.prepare("SELECT * FROM api_key_records WHERE key_id = ?").get(created.record.keyId);
      expect(JSON.stringify(durable)).not.toContain(created.apiKey);
      expect(durable.verifier_digest).toBeInstanceOf(Buffer);
      expect(current.provider.explainLookupPlan().some((entry: any) : any =>
        /primary key|index/i.test(String(entry.detail || "")))).toBe(true);
      const authorization: any = await current.provider.authenticateRuntime({
        credential: created.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      });
      expect(authorization.workloadPrincipalId).toBe(created.record.workloadPrincipalId);
      expect(authorization).not.toHaveProperty("grantProjection");
      await expect(current.provider.authenticateRuntime({
        credential: `${created.apiKey.slice(0, -1)}A`,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      })).rejects.toMatchObject({ code: "api_key_invalid", statusCode: 401 });
    } finally {
      current.close();
    }
  });

  it("fences rotation, lineage, use, rate, and concurrency atomically", async () : Promise<any> => {
    const current: any = harness();
    try {
      const created: any = await current.provider.create({
        subjectId: "admin",
        workloadDisplayName: "Neutral worker",
        organizationNodeId: "child",
        expiresAt: "2026-08-04T00:00:00.000Z",
        policy: policy()
      });
      const authorization: any = await current.provider.authenticateRuntime({
        credential: created.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      });
      const lease: any = await current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "low", resourceContext: { workspaceId: "workspace-1" } }
      });
      await expect(current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "low", resourceContext: { workspaceId: "workspace-1" } }
      })).rejects.toMatchObject({ code: "api_key_concurrency_limit_reached" });
      await current.provider.releaseEffect(lease);
      const rotated: any = await current.provider.rotate({
        subjectId: "admin",
        keyId: created.record.keyId,
        expectedLifecycleRevision: 1
      });
      expect(rotated.record.useCount).toBe(1);
      expect(rotated.record.policyFingerprint).toBe(created.record.policyFingerprint);
      await expect(current.provider.revalidateEffect(lease)).rejects.toMatchObject({ code: "api_key_revision_stale" });
      await expect(current.provider.authenticateRuntime({
        credential: created.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      })).rejects.toMatchObject({ code: "api_key_invalid" });
      const rotatedAuthorization: any = await current.provider.authenticateRuntime({
        credential: rotated.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      });
      current.governance.moveChildToPeer();
      await expect(current.provider.reserveEffect({
        authorization: rotatedAuthorization,
        operation: { toolId: "tools.echo", risk: "low", resourceContext: { workspaceId: "workspace-1" } }
      })).rejects.toMatchObject({ code: "api_key_inactive" });
    } finally {
      current.close();
    }
  });

  it("enforces restricted resources, risk, rate, max-use, expiry, and terminal revocation", async () : Promise<any> => {
    const current: any = harness();
    try {
      const created: any = await current.provider.create({
        subjectId: "admin",
        workloadDisplayName: "Bound worker",
        organizationNodeId: "child",
        expiresAt: "2026-08-03T00:02:00.000Z",
        policy: policy("catalog-1", {
          maximumRisk: "low",
          limits: { maxUses: 2, requestsPerWindow: 1, windowSeconds: 60, maxConcurrentEffects: 2 }
        })
      });
      const authorization: any = await current.provider.authenticateRuntime({
        credential: created.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      });
      await expect(current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "read_only", resourceContext: {} }
      })).rejects.toMatchObject({ code: "api_key_policy_denied" });
      await expect(current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "safe_write", resourceContext: { workspaceId: "workspace-1" } }
      })).rejects.toMatchObject({ code: "api_key_policy_denied" });
      const first: any = await current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "read_only", resourceContext: { workspaceId: "workspace-1" } }
      });
      await expect(current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "read_only", resourceContext: { workspaceId: "workspace-1" } }
      })).rejects.toMatchObject({ code: "api_key_rate_limited" });
      await current.provider.releaseEffect(first);
      current.advance(60_000);
      const second: any = await current.provider.reserveEffect({
        authorization,
        operation: { toolId: "tools.echo", risk: "read_only", resourceContext: { workspaceId: "workspace-1" } }
      });
      await current.provider.revalidateEffect(second);
      await current.provider.releaseEffect(second);
      await expect(current.provider.authenticateRuntime({
        credential: created.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      })).rejects.toMatchObject({ code: "api_key_use_limit_reached" });

      const expiring: any = await current.provider.create({
        subjectId: "admin",
        workloadDisplayName: "Expiring worker",
        organizationNodeId: "issuer",
        expiresAt: "2026-08-03T00:01:01.000Z",
        policy: policy()
      });
      current.advance(1_000);
      await expect(current.provider.list({ subjectId: "admin", status: "expired" }))
        .resolves.toMatchObject({ items: [expect.objectContaining({ keyId: expiring.record.keyId, status: "expired" })] });
      const activePage: any = await current.provider.list({ subjectId: "admin", status: "active" });
      expect(activePage.items.some((record: any) : any => record.keyId === expiring.record.keyId)).toBe(false);
      await expect(current.provider.authenticateRuntime({
        credential: expiring.apiKey,
        serverAudience: "https://meshrix.invalid",
        targetId: "server",
        connectorPackageId: null,
        processIdentityEvidence: null
      })).rejects.toMatchObject({ code: "api_key_inactive" });

      const revocable: any = await current.provider.create({
        subjectId: "admin",
        workloadDisplayName: "Revocable worker",
        organizationNodeId: "issuer",
        expiresAt: "2026-08-04T00:00:00.000Z",
        policy: policy()
      });
      const revoked: any = await current.provider.revoke({
        subjectId: "admin",
        keyId: revocable.record.keyId,
        expectedLifecycleRevision: revocable.record.lifecycleRevision,
        reasonCode: "administrator_request"
      });
      expect(revoked.status).toBe("revoked");
      await expect(current.provider.rotate({
        subjectId: "admin",
        keyId: revocable.record.keyId,
        expectedLifecycleRevision: revoked.lifecycleRevision
      })).rejects.toMatchObject({ code: "api_key_inactive" });
    } finally {
      current.close();
    }
  });
});
