import { describe, expect, it, vi } from "vitest";

import {
  createDelegatedMcpGrantForPlatform
} from "../../../packages/capabilities/src/skills/tool-skill-management-provider-delegated-mcp.ts";

const DELEGATION: Readonly<Record<string, any>> = Object.freeze({
  issuer: "fixture-plugin",
  binding: "fixture-session",
  sessionId: "session-a",
  turnId: "turn-a",
  subjectId: "subject-a",
  targetId: "target-a",
  parentOperationId: "fixture.prompt",
  workspaceId: "workspace-a",
  traceId: "trace-a"
});

function canonicalParent(overrides: Record<string, any> = {}) : any {
  return {
    id: "parent-grant-a",
    type: "mcp-client",
    enabled: true,
    revokedAt: "",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    projectionFingerprint: "projection-parent-a",
    scopes: ["workspace:read", "workspace:write"],
    toolsets: ["workspace-read", "workspace-write"],
    toolAllow: ["workspace.files.read", "workspace.files.write"],
    toolDeny: ["workspace.files.delete"],
    capabilities: [],
    dynamicCapabilities: [
      "cap:upstream:service-a:read",
      "cap:upstream:service-b:write"
    ],
    allowedWorkspaceIds: ["workspace-a", "workspace-b"],
    allowedDataClasses: ["public", "internal"],
    allowedEgress: ["egress-a", "egress-b"],
    allowedStaticSemanticFamilies: ["semantic-a", "semantic-b"],
    allowedCapabilityDomains: ["domain-a", "domain-b"],
    allowedCapabilityVerbs: ["read", "write"],
    allowedResourceKinds: ["document", "artifact"],
    allowedEffectKinds: ["read", "mutate"],
    allowedServiceIds: ["service-a", "service-b"],
    allowedSecretBindings: ["binding-a", "binding-b"],
    allowedOrigins: ["origin-a", "origin-b"],
    allowedCidrs: ["cidr-a", "cidr-b"],
    ...overrides
  };
}

function verifiedAuthorization(parent?: any, grantPatch: Record<string, any> = {}) : any {
  return {
    ok: true,
    grant: {
      ...parent,
      ...grantPatch
    }
  };
}

function platformFor(parent?: any) : any {
  const created: any[] = [];
  const store: Record<string, any> = {
    getGrant: vi.fn((grantId?: any) : any => grantId === parent?.id ? parent : null),
    createGrant: vi.fn(async (input?: any) : Promise<any> => {
      created.push(input);
      return {
        grant: { id: input.id || "delegated-grant-a", ...input },
        token: "[redacted]"
      };
    })
  };
  return {
    current: { store },
    store,
    created
  };
}

async function issue(parent?: any, input: Record<string, any> = {}) : Promise<any> {
  const platform: any = platformFor(parent);
  const result: any = await createDelegatedMcpGrantForPlatform(platform.current, {
    delegation: DELEGATION,
    sourceAuthorization: verifiedAuthorization(parent),
    ...input
  });
  return { ...platform, result };
}

describe("delegated MCP parent grant authority", () : any => {
  it("requires a verified source authorization snapshot", async () : Promise<any> => {
    const parent: any = canonicalParent();
    const { current, store } = platformFor(parent);
    const result: any = await createDelegatedMcpGrantForPlatform(current, {
      delegation: DELEGATION,
      sourceAuthorization: { grant: parent }
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "delegated_mcp_source_grant_required" }
    });
    expect(store.getGrant).not.toHaveBeenCalled();
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("rejects a source grant that is absent from the canonical store", async () : Promise<any> => {
    const claimedParent: any = canonicalParent();
    const { current, store } = platformFor(null);
    const result: any = await createDelegatedMcpGrantForPlatform(current, {
      delegation: DELEGATION,
      sourceAuthorization: verifiedAuthorization(claimedParent)
    });

    expect(result.error.code).toBe("delegated_mcp_source_grant_not_found");
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { enabled: false }, "delegated_mcp_source_grant_disabled"],
    ["revoked", { revokedAt: "2025-01-01T00:00:00.000Z" }, "delegated_mcp_source_grant_revoked"],
    ["expired", { expiresAt: "2000-01-01T00:00:00.000Z" }, "delegated_mcp_source_grant_expired"],
    ["invalid expiry", { expiresAt: "invalid-expiry" }, "delegated_mcp_source_grant_invalid"]
  ])("rejects a %s canonical source grant", async (_label?: any, patch?: any, expectedCode?: any) : Promise<any> => {
    const parent: any = canonicalParent(patch);
    const { result, store } = await issue(parent);

    expect(result.error.code).toBe(expectedCode);
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("rejects a forged or stale source authorization snapshot", async () : Promise<any> => {
    const parent: any = canonicalParent();
    const { current, store } = platformFor(parent);
    const result: any = await createDelegatedMcpGrantForPlatform(current, {
      delegation: DELEGATION,
      sourceAuthorization: verifiedAuthorization(parent, {
        scopes: [...parent.scopes, "runtime:admin"]
      })
    });

    expect(result.error.code).toBe("delegated_mcp_source_grant_mismatch");
    expect(store.createGrant).not.toHaveBeenCalled();
  });
});

describe("delegated MCP child grant narrowing", () : any => {
  it("rejects an empty parent instead of allowing the store default capability", async () : Promise<any> => {
    const parent: any = canonicalParent({
      scopes: [],
      toolsets: [],
      toolAllow: [],
      capabilities: [],
      dynamicCapabilities: []
    });
    const { result, store } = await issue(parent);

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "delegated_mcp_source_grant_empty" }
    });
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("issues a child with strict resource subsets and the union of parent and child denies", async () : Promise<any> => {
    const parent: any = canonicalParent();
    const { result, created } = await issue(parent, {
      scopes: ["workspace:read"],
      toolsets: ["workspace-read"],
      toolAllow: ["workspace.files.read"],
      toolDeny: ["workspace.files.rename"],
      dynamicCapabilities: ["cap:upstream:service-a:read"],
      allowedWorkspaceIds: ["workspace-a"],
      allowedDataClasses: ["internal"],
      allowedEgress: ["egress-a"],
      allowedStaticSemanticFamilies: ["semantic-a"],
      allowedCapabilityDomains: ["domain-a"],
      allowedCapabilityVerbs: ["read"],
      allowedResourceKinds: ["document"],
      allowedEffectKinds: ["read"],
      allowedServiceIds: ["service-a"],
      allowedSecretBindings: ["binding-a"],
      allowedOrigins: ["origin-a"],
      allowedCidrs: ["cidr-a"]
    });

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scopes: ["workspace:read"],
      toolsets: ["workspace-read"],
      toolAllow: ["workspace.files.read"],
      toolDeny: ["workspace.files.delete", "workspace.files.rename"],
      dynamicCapabilities: ["cap:upstream:service-a:read"],
      allowedWorkspaceIds: ["workspace-a"],
      allowedDataClasses: ["internal"],
      allowedEgress: ["egress-a"],
      allowedStaticSemanticFamilies: ["semantic-a"],
      allowedCapabilityDomains: ["domain-a"],
      allowedCapabilityVerbs: ["read"],
      allowedResourceKinds: ["document"],
      allowedEffectKinds: ["read"],
      allowedServiceIds: ["service-a"],
      allowedSecretBindings: ["binding-a"],
      allowedOrigins: ["origin-a"],
      allowedCidrs: ["cidr-a"]
    });
    expect(Date.parse(created[0].expiresAt)).toBeLessThanOrEqual(Date.parse(parent.expiresAt));
  });

  it("inherits every parent constraint when the child does not request narrower values", async () : Promise<any> => {
    const parent: any = canonicalParent();
    const { result, created } = await issue(parent);

    expect(result.ok).toBe(true);
    expect(created[0].toolDeny).toEqual(parent.toolDeny);
    for (const field of [
      "dynamicCapabilities",
      "allowedWorkspaceIds",
      "allowedDataClasses",
      "allowedEgress",
      "allowedStaticSemanticFamilies",
      "allowedCapabilityDomains",
      "allowedCapabilityVerbs",
      "allowedResourceKinds",
      "allowedEffectKinds",
      "allowedServiceIds",
      "allowedSecretBindings"
    ]) {
      expect(created[0][field]).toEqual(parent[field]);
    }
  });

  it.each([
    ["workspace", "allowedWorkspaceIds", ["workspace-outside"]],
    ["resource", "allowedResourceKinds", ["resource-outside"]],
    ["service", "allowedServiceIds", ["service-outside"]],
    ["secret", "allowedSecretBindings", ["binding-outside"]],
    ["egress", "allowedEgress", ["egress-outside"]],
    ["dynamic capability", "dynamicCapabilities", ["cap:upstream:service-outside:read"]]
  ])("rejects a child %s constraint outside the parent", async (_label?: any, field?: any, values?: any) : Promise<any> => {
    const parent: any = canonicalParent();
    const { result, store } = await issue(parent, { [field]: values });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_source_grant_subset_violation",
        details: { fields: [field] }
      }
    });
    expect(store.createGrant).not.toHaveBeenCalled();
  });

  it("allows an unrestricted parent to be narrowed by the child", async () : Promise<any> => {
    const parent: any = canonicalParent({
      allowedWorkspaceIds: [],
      allowedServiceIds: [],
      allowedSecretBindings: [],
      allowedEgress: []
    });
    const { result, created } = await issue(parent, {
      allowedWorkspaceIds: ["workspace-a"],
      allowedServiceIds: ["service-a"],
      allowedSecretBindings: ["binding-a"],
      allowedEgress: ["egress-a"]
    });

    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({
      allowedWorkspaceIds: ["workspace-a"],
      allowedServiceIds: ["service-a"],
      allowedSecretBindings: ["binding-a"],
      allowedEgress: ["egress-a"]
    });
  });

  it("rejects a delegated workspace outside the inherited parent workspace constraint", async () : Promise<any> => {
    const parent: any = canonicalParent({ allowedWorkspaceIds: ["workspace-b"] });
    const { result, store } = await issue(parent);

    expect(result.error.code).toBe("delegated_mcp_workspace_not_allowed");
    expect(store.createGrant).not.toHaveBeenCalled();
  });
});
