import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOperationPermissionStore } from "../../../packages/capabilities/src/operation-permission-core/store.ts";
import { createToolCatalogRegistry } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";

const roots: any[] = [];
const tool: Readonly<Record<string, any>> = Object.freeze({
  id: "system.health",
  operationId: "system.health",
  status: "active",
  toolsets: [],
  requiredScopes: [],
  risk: "read_only"
});

async function fixture(grantInput: Record<string, any> = {}) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-grant-security-"));
  roots.push(userDataPath);
  const store: any = createOperationPermissionStore({
    userDataPath,
    capabilityBindingGuard: false,
    capabilityResolver: () : any => ["cap:tool:*"]
  });
  const issued: any = await store.createGrant({
    label: "Security regression grant",
    scopes: [],
    toolsets: [],
    capabilities: ["cap:tool:*"],
    ...grantInput
  });
  const request: Record<string, any> = {
    headers: { authorization: `Bearer ${issued.token}` },
    socket: { remoteAddress: "127.0.0.1" }
  };
  return { store, issued, request };
}

async function delegatedFixture() : Promise<any> {
  const parent: any = await fixture({ label: "Delegated parent" });
  const child: any = await parent.store.createGrant({
    label: "Delegated child",
    type: "delegated-mcp-child",
    capabilities: ["cap:tool:*"],
    metadata: {
      delegatedMcp: { sourceGrantId: parent.issued.grant.id }
    }
  });
  return {
    ...parent,
    child,
    childRequest: {
      headers: { authorization: `Bearer ${child.token}` },
      socket: { remoteAddress: "127.0.0.1" }
    }
  };
}

afterEach(async () : Promise<any> => {
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("Operation Permission grant security invariants", () : any => {
  it("revalidates an unchanged captured grant and rejects a changed projection", async () : Promise<any> => {
    const { store, issued } = await fixture();
    try {
      expect(store.authorizeGrantForExecution({
        grantId: issued.grant.id,
        expectedProjectionFingerprint: issued.grant.projectionFingerprint
      })).toMatchObject({
        ok: true,
        grant: {
          id: issued.grant.id,
          projectionFingerprint: issued.grant.projectionFingerprint
        }
      });

      const changed: any = await store.updateGrant(issued.grant.id, {
        scopes: ["gateway:read"],
        reason: "grant_projection_regression"
      });
      expect(changed.projectionFingerprint).not.toBe(issued.grant.projectionFingerprint);
      expect(store.authorizeGrantForExecution({
        grantId: issued.grant.id,
        expectedProjectionFingerprint: issued.grant.projectionFingerprint
      })).toMatchObject({
        ok: false,
        status: 409,
        reasonCode: "execution_grant_revision_changed"
      });
    } finally {
      store.close();
    }
  });

  it("drops successful health probes and automatically bounds raw metric history", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-metric-retention-"));
    roots.push(userDataPath);
    const store: any = createOperationPermissionStore({
      userDataPath,
      capabilityBindingGuard: false,
      metricRetention: {
        retentionDays: 14,
        maxToolMetricRows: 3,
        maxHttpRequestMetricRows: 3,
        maintenanceInterval: 1
      }
    });
    try {
      expect(store.appendHttpRequestMetric({
        method: "GET",
        route: "/api/healthz",
        statusCode: 200,
        completionStatus: "completed"
      })).toBeNull();

      for (let index: any = 0; index < 5; index += 1) {
        store.appendHttpRequestMetric({
          method: "GET",
          route: "/api/workspaces",
          statusCode: 200,
          completionStatus: "completed",
          createdAt: `2030-01-01T00:00:0${index}.000Z`
        });
        store.appendMetric({
          toolId: `tool-${index}`,
          status: "completed",
          createdAt: `2030-01-01T00:00:0${index}.000Z`
        });
      }

      expect(store.db.prepare("SELECT count(*) AS count FROM http_request_metric_events").get().count).toBe(3);
      expect(store.db.prepare("SELECT count(*) AS count FROM tool_metric_events").get().count).toBe(3);
      expect(store.db.prepare(`
        SELECT route FROM http_request_metric_events ORDER BY created_at ASC
      `).all().map((row?: any) : any => row.route)).toEqual([
        "/api/workspaces",
        "/api/workspaces",
        "/api/workspaces"
      ]);
    } finally {
      store.close();
    }
  });

  it("binds catalog owners and durably revokes plugin grants and delegated descendants", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-owner-grant-"));
    roots.push(userDataPath);
    const pluginTool: Readonly<Record<string, any>> = Object.freeze({
      id: "fixture.plugin.execute",
      owner: "fixture-plugin",
      ownerKind: "plugin",
      ownerId: "fixture-plugin",
      toolsets: ["fixture.toolset"],
      requiredScopes: ["fixture:execute"]
    });
    const registry: Record<string, any> = {
      getCatalog: () : any => ({
        fingerprint: "fixture-catalog",
        scopes: [{ id: "fixture:execute" }],
        toolsets: [{ id: "fixture.toolset" }],
        tools: [pluginTool]
      }),
      listTools: () : any => [pluginTool],
      resolveToolset: () : any => ({
        toolsets: ["fixture.toolset"],
        tools: [pluginTool],
        requiredScopes: ["fixture:execute"]
      })
    };
    const firstGeneration: any = "a".repeat(64);
    const nextGeneration: any = "b".repeat(64);
    let invalidationCalls: any = 0;
    const invalidated: any[] = [];
    const capabilityKeyProvider: Record<string, any> = {
      async issue({ credentialId }: Record<string, any>) : Promise<any> {
        return {
          capabilityKey: `ock_${credentialId}_fixture_credential_material`,
          credentialId,
          capabilitySetHash: "fixture-capability-set",
          capabilityCount: 1,
          expiresAt: "9999-12-31T23:59:59.999Z"
        };
      },
      async invalidateCredential({ credentialId }: Record<string, any>) : Promise<any> {
        invalidationCalls += 1;
        if (invalidationCalls === 2) {
          throw new Error("fixture invalidation failure");
        }
        invalidated.push(credentialId);
      },
      close() : any {}
    };
    const openStore: any = () : any => createOperationPermissionStore({
      userDataPath,
      registry,
      capabilityKeyProvider,
      capabilityBindingGuard: false
    });

    let store: any = openStore();
    expect(store.registerPluginGrantOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration
    })).toMatchObject({ ok: true, state: "active", ownerGenerationDigest: firstGeneration });
    const parent: any = await store.createGrant({
      id: "plugin-parent",
      label: "Plugin parent",
      toolsets: ["fixture.toolset"],
      capabilities: ["cap:tool:*"]
    });
    const child: any = await store.createGrant({
      id: "plugin-child",
      label: "Plugin child",
      type: "delegated-mcp-child",
      toolsets: ["fixture.toolset"],
      capabilities: ["cap:tool:*"],
      metadata: { delegatedMcp: { sourceGrantId: parent.grant.id } }
    });
    expect(parent.grant.owners).toEqual([{
      ownerKind: "plugin",
      ownerId: "fixture-plugin",
      ownerGeneration: firstGeneration
    }]);
    expect(child.grant.owners).toEqual(parent.grant.owners);
    expect(store.listGrantEvents({ grantId: parent.grant.id, eventType: "created" })[0]?.details?.scopes)
      .toEqual(["fixture:execute"]);
    await expect(store.createGrant({
      label: "Spoofed owner",
      ownerId: "fixture-plugin",
      capabilities: ["cap:tool:*"]
    })).rejects.toMatchObject({ code: "operation_permission_grant_owner_not_caller_controlled" });

    let receipt: any = await store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-disable",
      batchSize: 1
    });
    expect(receipt).toMatchObject({ complete: false, processedCount: 1, cursor: expect.any(String) });
    const committedCursor: any = receipt.cursor;
    const handshake: any = await store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-disable",
      batchSize: 1
    });
    expect(handshake).toEqual(receipt);
    await expect(store.authorizeRequest({
      request: {
        headers: { authorization: `Bearer ${parent.token}` },
        socket: { remoteAddress: "127.0.0.1" }
      }
    })).resolves.toMatchObject({
      ok: false,
      reasonCode: "grant_owner_generation_inactive"
    });
    expect(store.authorizeGrantForExecution({
      grantId: parent.grant.id,
      expectedProjectionFingerprint: parent.grant.projectionFingerprint,
      tool: pluginTool
    })).toMatchObject({
      ok: false,
      reasonCode: "grant_owner_generation_inactive"
    });
    await expect(store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-disable",
      cursor: committedCursor,
      batchSize: 1
    })).rejects.toMatchObject({ code: "operation_permission_plugin_owner_revocation_pending" });
    await expect(store.createGrant({
      id: "aaa-concurrent-old-generation",
      label: "Concurrent old generation",
      toolsets: ["fixture.toolset"],
      capabilities: ["cap:tool:*"]
    })).rejects.toMatchObject({ code: "operation_permission_plugin_owner_generation_inactive" });
    store.close();

    store = openStore();
    receipt = await store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-disable",
      cursor: committedCursor,
      batchSize: 1
    });
    while (!receipt.complete) {
      receipt = await store.revokeGrantsByPluginOwner({
        pluginId: "fixture-plugin",
        generationDigest: firstGeneration,
        idempotencyKey: "fixture-disable",
        cursor: receipt.cursor,
        batchSize: 1
      });
    }
    expect(receipt).toMatchObject({
      complete: true,
      processedCount: 2,
      revokedCount: 2,
      alreadyRevokedCount: 0,
      cursor: ""
    });
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(invalidated.sort()).toEqual(["plugin-child", "plugin-parent"]);
    expect(store.getGrant(parent.grant.id)).toMatchObject({ enabled: false, revokedAt: expect.any(String) });
    expect(store.getGrant(child.grant.id)).toMatchObject({ enabled: false, revokedAt: expect.any(String) });
    await expect(store.createGrant({
      id: parent.grant.id,
      label: "Reinstalled tool grant",
      toolsets: ["fixture.toolset"],
      capabilities: ["cap:tool:*"]
    })).rejects.toMatchObject({ code: "operation_permission_grant_id_reserved" });
    await expect(store.rotateGrantToken(parent.grant.id)).rejects.toMatchObject({
      code: "operation_permission_grant_terminal"
    });
    await expect(store.updateGrant(parent.grant.id, { enabled: true })).rejects.toMatchObject({
      code: "operation_permission_grant_terminal"
    });
    const replay: any = await store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-disable"
    });
    expect(replay).toEqual(receipt);
    expect(() : any => store.registerPluginGrantOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration
    })).toThrow(expect.objectContaining({
      code: "operation_permission_plugin_owner_generation_retired"
    }));
    expect(await store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-uninstall-after-disable"
    })).toMatchObject({ complete: true, processedCount: 0, revokedCount: 0 });
    expect(store.registerPluginGrantOwner({
      pluginId: "fixture-plugin",
      generationDigest: nextGeneration
    })).toMatchObject({ state: "active", ownerGenerationDigest: nextGeneration });
    const reinstalled: any = await store.createGrant({
      id: "aaa-new-generation",
      label: "New plugin generation",
      toolsets: ["fixture.toolset"],
      capabilities: ["cap:tool:*"]
    });
    expect(reinstalled.grant.owners).toEqual([{
      ownerKind: "plugin",
      ownerId: "fixture-plugin",
      ownerGeneration: nextGeneration
    }]);
    expect(store.getGrant(reinstalled.grant.id)).toMatchObject({ enabled: true, revokedAt: "" });
    expect(await store.revokeGrantsByPluginOwner({
      pluginId: "fixture-plugin",
      generationDigest: firstGeneration,
      idempotencyKey: "fixture-disable"
    })).toEqual(receipt);
    expect(store.getGrant(reinstalled.grant.id)).toMatchObject({ enabled: true, revokedAt: "" });
    await expect(store.revokeGrantsByPluginOwner({
      pluginId: "unknown-plugin",
      generationDigest: "c".repeat(64),
      idempotencyKey: "unknown-disable"
    })).rejects.toMatchObject({ code: "operation_permission_unknown_plugin_owner" });
    store.close();
  });

  it("atomically fences grant consumption when an owner retires during credential verification", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-plugin-owner-consume-fence-"));
    roots.push(userDataPath);
    const generationDigest: any = "f".repeat(64);
    const pluginTool: Readonly<Record<string, any>> = Object.freeze({
      id: "fixture.atomic.execute",
      operationId: "fixture.atomic.execute",
      status: "active",
      ownerKind: "plugin",
      ownerId: "atomic-plugin",
      toolsets: ["fixture.atomic"],
      requiredScopes: [],
      risk: "read_only"
    });
    const registry: Record<string, any> = {
      getCatalog: () : any => ({
        fingerprint: "atomic-owner-fence",
        scopes: [],
        toolsets: [{ id: "fixture.atomic" }],
        tools: [pluginTool]
      }),
      listTools: () : any => [pluginTool],
      resolveToolset: () : any => ({ tools: [pluginTool] })
    };
    let store: any = null;
    let retireDuringVerify: any = false;
    const capabilityKeyProvider: Record<string, any> = {
      async issue({ credentialId }: Record<string, any>) : Promise<any> {
        return {
          capabilityKey: `ock_${credentialId}_atomic_fixture`,
          credentialId,
          capabilitySetHash: "atomic-owner-fence",
          capabilityCount: 1,
          expiresAt: "9999-12-31T23:59:59.999Z"
        };
      },
      async verify({ capabilityKey }: Record<string, any>) : Promise<any> {
        if (retireDuringVerify) {
          store.db.prepare(`
            UPDATE tool_grant_owner_authorities SET state = 'retiring'
            WHERE owner_kind = 'plugin' AND owner_id = 'atomic-plugin' AND owner_generation = ?
          `).run(generationDigest);
        }
        return { ok: true, credentialId: "atomic-grant", capabilityKey };
      },
      async invalidateCredential() : Promise<any> {},
      close() : any {}
    };
    store = createOperationPermissionStore({
      userDataPath,
      registry,
      capabilityKeyProvider,
      capabilityBindingGuard: false
    });
    store.registerPluginGrantOwner({ pluginId: "atomic-plugin", generationDigest });
    const issued: any = await store.createGrant({
      id: "atomic-grant",
      toolsets: ["fixture.atomic"],
      capabilities: ["cap:tool:*"]
    });
    retireDuringVerify = true;
    await expect(store.authorizeRequest({
      request: {
        headers: { authorization: `Bearer ${issued.token}` },
        socket: { remoteAddress: "127.0.0.1" }
      },
      tool: pluginTool,
      recordUse: false
    })).resolves.toMatchObject({ ok: false, reasonCode: "grant_owner_generation_inactive" });
    expect(store.getRawGrant(issued.grant.id).useCount).toBe(0);
    store.db.prepare(`
      UPDATE tool_grant_owner_authorities SET state = 'active'
      WHERE owner_kind = 'plugin' AND owner_id = 'atomic-plugin' AND owner_generation = ?
    `).run(generationDigest);
    await expect(store.authorizeRequest({
      request: {
        headers: { authorization: `Bearer ${issued.token}` },
        socket: { remoteAddress: "127.0.0.1" }
      },
      tool: pluginTool
    })).resolves.toMatchObject({ ok: false, reasonCode: "grant_changed_during_authorization" });
    expect(store.getRawGrant(issued.grant.id).useCount).toBe(0);
    store.close();
  });

  it("rejects grant references outside the active operation catalog", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-inactive-grant-"));
    roots.push(userDataPath);
    const registry: any = createToolCatalogRegistry({
      operations: [],
      activeFeatureIds: [],
      profiles: []
    });
    const store: any = createOperationPermissionStore({
      userDataPath,
      registry,
      capabilityBindingGuard: false
    });
    try {
      await expect(store.createGrant({
        label: "Inactive plugin grant",
        scopes: ["sample_plugin:view"],
        capabilities: ["cap:tool:*"]
      })).rejects.toMatchObject({
        code: "operation_permission_inactive_catalog_reference",
        field: "scopes"
      });
      expect(store.listGrants()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("retains the native upload data-plane scope without projecting raw chunks as MCP tools", () : any => {
    const registry: any = createToolCatalogRegistry({
      operations: [],
      activeFeatureIds: [],
      profiles: []
    });
    expect(registry.listScopes()).toContainEqual(expect.objectContaining({ id: "uploads:write" }));
    expect(registry.listToolsets()).toContainEqual(expect.objectContaining({
      id: "meshrix.uploads.write",
      requiredScopes: ["uploads:write"],
      maxRisk: "safe_write"
    }));
    expect(registry.resolveToolset({
      toolsets: ["meshrix.uploads.write"],
      scopes: ["uploads:write"]
    })).toMatchObject({
      toolsets: ["meshrix.uploads.write"],
      requiredScopes: ["uploads:write"],
      tools: []
    });
  });

  it("does not expand an empty grant into wildcard tool capabilities", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-empty-grant-"));
    roots.push(userDataPath);
    const store: any = createOperationPermissionStore({ userDataPath, capabilityBindingGuard: false });
    try {
      await expect(store.createGrant({
        label: "Empty grant",
        scopes: [],
        toolsets: [],
        capabilities: []
      })).rejects.toThrow("at least one kernel capability");
      expect(store.listGrants()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("re-evaluates the current tool policy when an existing bearer is narrowed", async () : Promise<any> => {
    const { store, issued, request } = await fixture();
    try {
      await expect(store.authorizeRequest({ request, tool })).resolves.toMatchObject({ ok: true });

      await store.updateGrant(issued.grant.id, { toolDeny: [tool.id] });

      await expect(store.authorizeRequest({ request, tool })).resolves.toMatchObject({
        ok: false,
        reasonCode: "tool_denied"
      });
    } finally {
      store.close();
    }
  });

  it("atomically consumes maxUses across concurrent authorizations", async () : Promise<any> => {
    const { store, issued, request } = await fixture({ maxUses: 1 });
    try {
      const decisions: any = await Promise.all(
        Array.from({ length: 16 }, () : any => store.authorizeRequest({ request, tool }))
      );
      expect(decisions.filter((decision?: any) : any => decision.ok)).toHaveLength(1);
      expect(decisions.filter((decision?: any) : any => decision.reasonCode === "grant_max_uses")).toHaveLength(15);
      expect(store.getRawGrant(issued.grant.id).useCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects malformed persisted ACL state and prevents new malformed JSON writes", async () : Promise<any> => {
    const { store, issued, request } = await fixture({ allowedCidrs: ["10.0.0.0/8"] });
    try {
      expect(() : any => store.db.prepare("UPDATE tool_grants SET allowed_cidrs_json = ? WHERE id = ?")
        .run("not-json", issued.grant.id)).toThrow("tool_grant_policy_json_invalid");

      store.db.exec("DROP TRIGGER validate_tool_grants_json_update");
      store.db.prepare("UPDATE tool_grants SET allowed_cidrs_json = ? WHERE id = ?")
        .run("not-json", issued.grant.id);

      await expect(store.authorizeRequest({ request, tool })).resolves.toMatchObject({
        ok: false,
        reasonCode: "grant_policy_corrupt"
      });
    } finally {
      store.close();
    }
  });

  it.each([
    ["update", (store?: any, grantId?: any) : any => store.updateGrant(grantId, { label: "Changed parent" })],
    ["rotate", (store?: any, grantId?: any) : any => store.rotateGrantToken(grantId)],
    ["revoke", (store?: any, grantId?: any) : any => store.revokeGrant(grantId, "parent revoked")],
    ["delete", (store?: any, grantId?: any) : any => store.deleteGrant(grantId)]
  ])("cascades a parent %s to delegated child credentials", async (_action?: any, mutateParent?: any) : Promise<any> => {
    const { store, issued, child, childRequest } = await delegatedFixture();
    try {
      await expect(store.authorizeRequest({ request: childRequest, tool })).resolves.toMatchObject({ ok: true });

      await mutateParent(store, issued.grant.id);

      expect(store.getRawGrant(child.grant.id)).toMatchObject({ enabled: false });
      await expect(store.authorizeRequest({ request: childRequest, tool })).resolves.toMatchObject({
        ok: false,
        reasonCode: "invalid_token"
      });
    } finally {
      store.close();
    }
  });
});
