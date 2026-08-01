import { describe, expect, it, vi } from "vitest";
import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestSnapshotCommitter,
  compileUpstreamOperationProjection
} from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createOperationPermissionPlatform } from "../../../packages/capabilities/src/operation-permission-core/index.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

const roots: any[] = [];

async function temporaryRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-snapshot-commit-"));
  roots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

function serviceEntry({
  serviceId = "svc_01J0000000000000000000000",
  revision = 1,
  disabled = false,
  operations = [{
    operationKey: "read",
    method: "GET",
    path: "/read",
    risk: "read_only",
    payloadTransport: structuredJsonPayloadTransport()
  }]
}: Record<string, any> = {}) : any {
  return Object.freeze([
    serviceId,
    Object.freeze({
      serviceId,
      serviceRevision: revision,
      manifestDigest: String(revision).repeat(64).slice(0, 64),
      disabled,
      label: "Fixture",
      serviceProtocol: "http",
      baseUrl: "https://service.invalid:443",
      credentialRefs: Object.freeze(["credential://vault/fixture"]),
      operations: Object.freeze(operations.map((operation?: any) : any => Object.freeze(operation)))
    })
  ]);
}

function snapshot(setRevision?: any, entries?: any) : any {
  return Object.freeze({
    setRevision,
    setDigest: String(setRevision).padStart(64, "0"),
    serviceEntries: Object.freeze(entries),
    serviceCount: entries.length
  });
}

const BASE_OPERATION: Readonly<Record<string, any>> = Object.freeze({
  id: "gateway.health",
  toolId: "meshrix.gateway.health",
  label: "Gateway health",
  featureId: "core-platform",
  requiredScopes: ["gateway:read"],
  readOnly: true,
  safety: { risk: "read_only" },
  target: { controller: "system", method: "health" },
  http: { method: "GET", path: "/api/gateway/v1/health" },
  toolsets: ["meshrix.gateway.read"]
});

async function platformHarness() : Promise<any> {
  const userDataPath: any = await temporaryRoot();
  const platform: any = createOperationPermissionPlatform({
    userDataPath,
    operations: [BASE_OPERATION],
    featureRuntime: null,
    operationDispatcher: async () : Promise<any> => ({ ok: true }),
    controllers: {}
  });
  return { platform, userDataPath };
}

describe("upstream manifest snapshot commit", () : any => {
  it("commits one projected capability per operation with gateway/catalog revision agreement", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const publications: any[] = [];
    const protocolEventBus: Record<string, any> = {
      publish(topic?: any, event?: any) : any {
        publications.push({ topic, event });
      }
    };
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [BASE_OPERATION],
      getOperationPermissionPlatform: () : any => platform,
      protocolEventBus
    });
    const candidate: any = snapshot(1, [serviceEntry()]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    expect(projection.operations).toHaveLength(1);
    expect(projection.operations[0].id).toMatch(/^upstream_operation\./u);
    expect(projection.operations[0]._meta.dynamicCapability.capabilityId).toMatch(/^cap:upstream:/u);

    const result: any = await committer.commitManifestSnapshot(candidate);
    expect(result).toMatchObject({
      outcome: "committed",
      sourceRevision: 1,
      operationCount: 1,
      catalogPublication: { emitted: true, replayed: false }
    });
    expect(registry.getManifestSnapshotRevision()).toEqual({
      sourceRevision: 1,
      sourceDigest: candidate.setDigest
    });
    const catalog: any = platform.catalog();
    const projected: any = catalog.tools.filter((tool?: any) : any => tool.operationId === projection.operations[0].id);
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe(projection.operations[0].toolId);
    expect(publications.map((item?: any) : any => item.topic)).toEqual([
      "upstream.catalog_published",
      "upstream.audiences_published"
    ]);
    expect(publications[0].event).toMatchObject({
      sourceRevision: 1,
      sourceDigest: candidate.setDigest
    });
    expect(committer.getPublicationFacts()).toMatchObject({
      ready: true,
      sourceRevision: 1,
      sourceDigest: candidate.setDigest,
      audienceRevision: expect.any(Number),
      protocolRevision: expect.any(Number)
    });
    expect(JSON.stringify(publications[0].event)).not.toContain("credential://vault");
    expect(JSON.stringify(publications[0].event)).not.toContain("service.invalid");
    expect(JSON.stringify(publications[1].event)).not.toContain("credential://vault");
    platform.close();
  });

  it("replays identical snapshots without duplicate catalog publication events", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const publications: any[] = [];
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform,
      protocolEventBus: { publish: (_topic?: any, event?: any) : any => publications.push(event) }
    });
    const candidate: any = snapshot(2, [serviceEntry({ revision: 2 })]);
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");
    expect(await committer.commitManifestSnapshot(candidate)).toMatchObject({
      outcome: "unchanged",
      replayed: true,
      catalogPublication: { emitted: false, replayed: true }
    });
    expect(publications).toHaveLength(2);
    platform.close();
  });

  it("publishes an audience-only revision after a grant projection changes", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const candidate: any = snapshot(2, [serviceEntry({ revision: 2 })]);
    const operation: any = compileUpstreamOperationProjection(candidate).operations[0];
    const capability: any = operation._meta.dynamicCapability;
    let grants: any[] = [{
      id: "grant-audience-refresh",
      scopes: ["gateway:read"],
      toolsets: ["meshrix.gateway.read"],
      maxRisk: "read_only",
      dynamicCapabilities: [],
      allowedServiceIds: [operation._meta.serviceId]
    }];
    const publications: any[] = [];
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform,
      getGrants: () : any => grants,
      protocolEventBus: { publish: (topic?: any, event?: any) : any => publications.push({ topic, event }) }
    });
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");
    const firstAudience: any = committer.getAudienceProjection();
    expect(firstAudience.partitionSnapshot[0][1].visibleOperationIds).toEqual([
      BASE_OPERATION.id
    ]);

    grants = [{
      ...grants[0],
      dynamicCapabilities: [capability.capabilityId],
      allowedSecretBindings: capability.credentialBindingIds
    }];
    const refreshed: any = await committer.refreshAudienceProjection();
    expect(refreshed).toMatchObject({
      outcome: "refreshed",
      emitted: true,
      audienceRevision: firstAudience.audienceRevision + 1
    });
    expect(committer.getAudienceProjection().partitionSnapshot[0][1].visibleOperationIds)
      .toEqual([BASE_OPERATION.id, operation.id].sort());
    expect(committer.getAudiencePartitionKeysForGrant("grant-audience-refresh")).toEqual([
      committer.getAudienceProjection().partitionSnapshot[0][0]
    ]);
    expect(committer.getAudiencePartitionKeysForGrant("grant-other")).toEqual([]);
    expect(committer.getAudienceCatalogFactsForGrant("grant-audience-refresh")).toEqual({
      sourceRevision: candidate.setRevision,
      catalogRevision: committer.getAudienceProjection().catalogRevision,
      audienceRevision: committer.getAudienceProjection().audienceRevision,
      partitionKeys: [committer.getAudienceProjection().partitionSnapshot[0][0]]
    });
    expect(committer.getAudienceCatalogFactsForGrant("grant-other")).toBeNull();
    expect(publications.map(({ topic }: Record<string, any>) : any => topic)).toEqual([
      "upstream.catalog_published",
      "upstream.audiences_published",
      "upstream.audiences_published"
    ]);
    expect(await committer.refreshAudienceProjection()).toMatchObject({
      outcome: "unchanged",
      emitted: false
    });
    platform.close();
  });

  it("preserves the paired upstream catalog when base or plugin operations refresh", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [BASE_OPERATION],
      getOperationPermissionPlatform: () : any => platform
    });
    const candidate: any = snapshot(1, [serviceEntry()]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");

    const pluginOperation: Readonly<Record<string, any>> = Object.freeze({
      ...BASE_OPERATION,
      id: "plugin.fixture.read",
      toolId: "plugin.fixture.read",
      label: "Plugin fixture read",
      featureId: "core-platform",
      pluginId: "fixture-plugin",
      toolsets: ["meshrix.gateway.read"]
    });
    platform.refreshOperations([BASE_OPERATION, pluginOperation]);
    const toolIds: any = new Set<any>(platform.catalog().tools.map((tool?: any) : any => tool.id));
    expect(toolIds.has(pluginOperation.toolId)).toBe(true);
    expect(toolIds.has(projection.operations[0].toolId)).toBe(true);
    expect(platform.upstreamCatalogState()).toMatchObject({
      sourceRevision: 1,
      sourceDigest: candidate.setDigest,
      operationCount: 1
    });
    platform.close();
  });

  it("rolls back the gateway snapshot when Operation Permission refresh fails", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [BASE_OPERATION],
      getOperationPermissionPlatform: () : any => platform
    });
    const first: any = snapshot(1, [serviceEntry()]);
    expect((await committer.commitManifestSnapshot(first)).outcome).toBe("committed");

    const failing: Record<string, any> = {
      refreshOperations() : any {
        throw Object.assign(new Error("catalog rejected"), { code: "catalog_refresh_failed" });
      },
      catalog: () : any => platform.catalog()
    };
    const failingCommitter: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [BASE_OPERATION],
      getOperationPermissionPlatform: () : any => failing
    });
    await expect(failingCommitter.commitManifestSnapshot(snapshot(3, [
      serviceEntry({
        revision: 3,
        operations: [{
          operationKey: "write",
          method: "POST",
          path: "/write",
          risk: "safe_write",
          payloadTransport: structuredJsonPayloadTransport()
        }]
      })
    ]))).rejects.toThrow(/catalog rejected/u);
    expect(registry.getManifestSnapshotRevision()).toEqual({
      sourceRevision: 1,
      sourceDigest: first.setDigest
    });
    expect(registry.listServices().count).toBe(1);
    platform.close();
  });

  it("emits no publication when gateway finalization fails and restores the paired state", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const baseRegistry: any = createUpstreamGatewayRegistry({});
    const firstCommitter: any = createUpstreamManifestSnapshotCommitter({
      registry: baseRegistry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform
    });
    const first: any = snapshot(1, [serviceEntry()]);
    await firstCommitter.commitManifestSnapshot(first);
    const publications: any[] = [];
    const failingRegistry: Readonly<Record<string, any>> = Object.freeze({
      ...baseRegistry,
      async finalizeManifestSnapshot() : Promise<any> {
        throw new Error("finalization rejected");
      }
    });
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry: failingRegistry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform,
      protocolEventBus: { publish: async (topic?: any) : Promise<any> => publications.push(topic) }
    });
    await expect(committer.commitManifestSnapshot(snapshot(2, [serviceEntry({ revision: 2 })])))
      .rejects.toThrow(/finalization rejected/u);
    expect(publications).toEqual([]);
    expect(baseRegistry.getManifestSnapshotRevision()).toEqual({
      sourceRevision: first.setRevision,
      sourceDigest: first.setDigest
    });
    expect(platform.upstreamCatalogState()).toMatchObject({
      sourceRevision: first.setRevision,
      sourceDigest: first.setDigest
    });
    platform.close();
  });

  it("keeps paired state pending and retries durable publication without repeating finalization", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const retireScope: any = vi.fn(async () : Promise<any> => ({ retired: 1 }));
    const registry: any = createUpstreamGatewayRegistry({
      mcpSessionManager: {
        retireScope,
        close: async () : Promise<any> => {},
        listTools: async () : Promise<any> => ({ tools: [] }),
        callTool: async () : Promise<any> => ({})
      }
    });
    let rejectCatalog: any = false;
    let rejectAudience: any = false;
    const publications: any[] = [];
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform,
      protocolEventBus: {
        async publish(topic?: any, event?: any) : Promise<any> {
          if (rejectCatalog && topic === "upstream.catalog_published") {
            throw new Error("catalog persistence rejected");
          }
          if (rejectAudience && topic === "upstream.audiences_published") {
            throw new Error("audience persistence rejected");
          }
          publications.push({ topic, revision: event.sourceRevision });
        }
      }
    });
    const first: any = snapshot(1, [serviceEntry()]);
    await committer.commitManifestSnapshot(first);
    retireScope.mockClear();
    const second: any = snapshot(2, [serviceEntry({ revision: 2 })]);
    rejectCatalog = true;
    await expect(committer.commitManifestSnapshot(second)).rejects.toThrow(/catalog persistence rejected/u);
    expect(retireScope).toHaveBeenCalledTimes(1);
    expect(registry.getManifestSnapshotRevision()).toEqual({
      sourceRevision: second.setRevision,
      sourceDigest: second.setDigest
    });

    rejectCatalog = false;
    rejectAudience = true;
    await expect(committer.commitManifestSnapshot(second)).rejects.toThrow(/persistence rejected/u);
    expect(retireScope).toHaveBeenCalledTimes(1);
    expect(registry.getManifestSnapshotRevision()).toEqual({
      sourceRevision: second.setRevision,
      sourceDigest: second.setDigest
    });

    rejectAudience = false;
    await expect(committer.commitManifestSnapshot(second)).resolves.toMatchObject({ outcome: "committed" });
    expect(retireScope).toHaveBeenCalledTimes(1);
    expect(publications.filter((item?: any) : any =>
      item.topic === "upstream.catalog_published" && item.revision === 2
    )).toHaveLength(1);
    platform.close();
  });

  it("retries audience admission without duplicating its durable event or finalization", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const retireScope: any = vi.fn(async () : Promise<any> => ({ retired: 1 }));
    const registry: any = createUpstreamGatewayRegistry({
      mcpSessionManager: {
        retireScope,
        close: async () : Promise<any> => {},
        listTools: async () : Promise<any> => ({ tools: [] }),
        callTool: async () : Promise<any> => ({})
      }
    });
    const publications: any[] = [];
    let rejectAdmission: any = false;
    const admissions: any[] = [];
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform,
      protocolEventBus: {
        async publish(topic?: any, event?: any) : Promise<any> {
          publications.push({ topic, revision: event.sourceRevision });
        }
      },
      async onAudiencePublished({ projection }: Record<string, any>) : Promise<any> {
        admissions.push(projection.sourceRevision);
        if (rejectAdmission) throw new Error("audience admission rejected");
      }
    });
    await committer.commitManifestSnapshot(snapshot(1, [serviceEntry()]));
    retireScope.mockClear();
    const second: any = snapshot(2, [serviceEntry({ revision: 2 })]);
    rejectAdmission = true;
    await expect(committer.commitManifestSnapshot(second)).rejects.toThrow(/admission rejected/u);
    expect(retireScope).toHaveBeenCalledTimes(1);

    rejectAdmission = false;
    await committer.commitManifestSnapshot(second);
    expect(retireScope).toHaveBeenCalledTimes(1);
    expect(admissions.filter((revision?: any) : any => revision === 2)).toHaveLength(2);
    expect(publications.filter((item?: any) : any =>
      item.topic === "upstream.audiences_published" && item.revision === 2
    )).toHaveLength(1);
    platform.close();
  });

  it("ignores stale revisions and does not emit a publication event", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const publications: any[] = [];
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform,
      protocolEventBus: { publish: (_topic?: any, event?: any) : any => publications.push(event) }
    });
    expect((await committer.commitManifestSnapshot(snapshot(2, [serviceEntry({ revision: 2 })]))).outcome).toBe("committed");
    expect(await committer.commitManifestSnapshot(snapshot(1, [serviceEntry()]))).toMatchObject({
      outcome: "stale",
      replayed: true,
      catalogPublication: { emitted: false }
    });
    expect(publications).toHaveLength(2);
    platform.close();
  });

  it("forwards projected operations through the same governed path and denies before network side effects", async () : Promise<any> => {
    const { platform } = await platformHarness();
    const registry: any = createUpstreamGatewayRegistry({});
    const committer: any = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [BASE_OPERATION],
      getOperationPermissionPlatform: () : any => platform
    });
    const candidate: any = snapshot(4, [serviceEntry({
      revision: 4,
      operations: [{
        operationKey: "read",
        method: "GET",
        path: "/read",
        risk: "read_only",
        requiredScopes: ["gateway:read"],
        requiresApproval: true
      }]
    })]);
    const projection: any = compileUpstreamOperationProjection(candidate);
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");
    const denied: any = await registry.forwardProjectedOperation(
      projection.operations[0].id,
      {},
      { subjectId: "tester", scopes: [] }
    ).catch((error?: any) : any => error);
    expect(denied).toMatchObject({ status: 403 });
    const pending: any = await registry.forwardProjectedOperation(
      projection.operations[0].id,
      {},
      { subjectId: "tester", scopes: ["gateway:read"] }
    );
    expect(pending).toMatchObject({ status: "pending_approval" });
    platform.close();
  });
});
