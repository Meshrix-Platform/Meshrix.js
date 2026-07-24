import { describe, expect, it, vi } from "vitest";
import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestSnapshotCommitter,
  compileUpstreamOperationProjection
} from "../../../packages/agents/src/upstream-gateway/index.mjs";
import { createOperationPermissionPlatform } from "../../../packages/capabilities/src/operation-permission-core/index.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.mjs";

const roots = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-snapshot-commit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
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
} = {}) {
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
      operations: Object.freeze(operations.map((operation) => Object.freeze(operation)))
    })
  ]);
}

function snapshot(setRevision, entries) {
  return Object.freeze({
    setRevision,
    setDigest: String(setRevision).padStart(64, "0"),
    serviceEntries: Object.freeze(entries),
    serviceCount: entries.length
  });
}

const BASE_OPERATION = Object.freeze({
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

async function platformHarness() {
  const userDataPath = await temporaryRoot();
  const platform = createOperationPermissionPlatform({
    userDataPath,
    operations: [BASE_OPERATION],
    featureRuntime: null,
    operationDispatcher: async () => ({ ok: true }),
    controllers: {}
  });
  return { platform, userDataPath };
}

describe("upstream manifest snapshot commit", () => {
  it("commits one projected capability per operation with gateway/catalog revision agreement", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const publications = [];
    const protocolEventBus = {
      publish(topic, event) {
        publications.push({ topic, event });
      }
    };
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [BASE_OPERATION],
      getOperationPermissionPlatform: () => platform,
      protocolEventBus
    });
    const candidate = snapshot(1, [serviceEntry()]);
    const projection = compileUpstreamOperationProjection(candidate);
    expect(projection.operations).toHaveLength(1);
    expect(projection.operations[0].id).toMatch(/^upstream_operation\./u);
    expect(projection.operations[0]._meta.dynamicCapability.capabilityId).toMatch(/^cap:upstream:/u);

    const result = await committer.commitManifestSnapshot(candidate);
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
    const catalog = platform.catalog();
    const projected = catalog.tools.filter((tool) => tool.operationId === projection.operations[0].id);
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe(projection.operations[0].toolId);
    expect(publications.map((item) => item.topic)).toEqual([
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

  it("replays identical snapshots without duplicate catalog publication events", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const publications = [];
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform,
      protocolEventBus: { publish: (_topic, event) => publications.push(event) }
    });
    const candidate = snapshot(2, [serviceEntry({ revision: 2 })]);
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");
    expect(await committer.commitManifestSnapshot(candidate)).toMatchObject({
      outcome: "unchanged",
      replayed: true,
      catalogPublication: { emitted: false, replayed: true }
    });
    expect(publications).toHaveLength(2);
    platform.close();
  });

  it("publishes an audience-only revision after a grant projection changes", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const candidate = snapshot(2, [serviceEntry({ revision: 2 })]);
    const operation = compileUpstreamOperationProjection(candidate).operations[0];
    const capability = operation._meta.dynamicCapability;
    let grants = [{
      id: "grant-audience-refresh",
      scopes: ["gateway:read"],
      toolsets: ["meshrix.gateway.read"],
      maxRisk: "read_only",
      dynamicCapabilities: [],
      allowedServiceIds: [operation._meta.serviceId]
    }];
    const publications = [];
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform,
      getGrants: () => grants,
      protocolEventBus: { publish: (topic, event) => publications.push({ topic, event }) }
    });
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");
    const firstAudience = committer.getAudienceProjection();
    expect(firstAudience.partitionSnapshot[0][1].visibleOperationIds).toEqual([
      BASE_OPERATION.id
    ]);

    grants = [{
      ...grants[0],
      dynamicCapabilities: [capability.capabilityId],
      allowedSecretBindings: capability.credentialBindingIds
    }];
    const refreshed = await committer.refreshAudienceProjection();
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
    expect(publications.map(({ topic }) => topic)).toEqual([
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

  it("preserves the paired upstream catalog when base or plugin operations refresh", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [BASE_OPERATION],
      getOperationPermissionPlatform: () => platform
    });
    const candidate = snapshot(1, [serviceEntry()]);
    const projection = compileUpstreamOperationProjection(candidate);
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");

    const pluginOperation = Object.freeze({
      ...BASE_OPERATION,
      id: "plugin.fixture.read",
      toolId: "plugin.fixture.read",
      label: "Plugin fixture read",
      featureId: "core-platform",
      pluginId: "fixture-plugin",
      toolsets: ["meshrix.gateway.read"]
    });
    platform.refreshOperations([BASE_OPERATION, pluginOperation]);
    const toolIds = new Set(platform.catalog().tools.map((tool) => tool.id));
    expect(toolIds.has(pluginOperation.toolId)).toBe(true);
    expect(toolIds.has(projection.operations[0].toolId)).toBe(true);
    expect(platform.upstreamCatalogState()).toMatchObject({
      sourceRevision: 1,
      sourceDigest: candidate.setDigest,
      operationCount: 1
    });
    platform.close();
  });

  it("rolls back the gateway snapshot when Operation Permission refresh fails", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [BASE_OPERATION],
      getOperationPermissionPlatform: () => platform
    });
    const first = snapshot(1, [serviceEntry()]);
    expect((await committer.commitManifestSnapshot(first)).outcome).toBe("committed");

    const failing = {
      refreshOperations() {
        throw Object.assign(new Error("catalog rejected"), { code: "catalog_refresh_failed" });
      },
      catalog: () => platform.catalog()
    };
    const failingCommitter = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [BASE_OPERATION],
      getOperationPermissionPlatform: () => failing
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

  it("emits no publication when gateway finalization fails and restores the paired state", async () => {
    const { platform } = await platformHarness();
    const baseRegistry = createUpstreamGatewayRegistry({});
    const firstCommitter = createUpstreamManifestSnapshotCommitter({
      registry: baseRegistry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform
    });
    const first = snapshot(1, [serviceEntry()]);
    await firstCommitter.commitManifestSnapshot(first);
    const publications = [];
    const failingRegistry = Object.freeze({
      ...baseRegistry,
      async finalizeManifestSnapshot() {
        throw new Error("finalization rejected");
      }
    });
    const committer = createUpstreamManifestSnapshotCommitter({
      registry: failingRegistry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform,
      protocolEventBus: { publish: async (topic) => publications.push(topic) }
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

  it("keeps paired state pending and retries durable publication without repeating finalization", async () => {
    const { platform } = await platformHarness();
    const retireScope = vi.fn(async () => ({ retired: 1 }));
    const registry = createUpstreamGatewayRegistry({
      mcpSessionManager: {
        retireScope,
        close: async () => {},
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({})
      }
    });
    let rejectCatalog = false;
    let rejectAudience = false;
    const publications = [];
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform,
      protocolEventBus: {
        async publish(topic, event) {
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
    const first = snapshot(1, [serviceEntry()]);
    await committer.commitManifestSnapshot(first);
    retireScope.mockClear();
    const second = snapshot(2, [serviceEntry({ revision: 2 })]);
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
    expect(publications.filter((item) =>
      item.topic === "upstream.catalog_published" && item.revision === 2
    )).toHaveLength(1);
    platform.close();
  });

  it("retries audience admission without duplicating its durable event or finalization", async () => {
    const { platform } = await platformHarness();
    const retireScope = vi.fn(async () => ({ retired: 1 }));
    const registry = createUpstreamGatewayRegistry({
      mcpSessionManager: {
        retireScope,
        close: async () => {},
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({})
      }
    });
    const publications = [];
    let rejectAdmission = false;
    const admissions = [];
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform,
      protocolEventBus: {
        async publish(topic, event) {
          publications.push({ topic, revision: event.sourceRevision });
        }
      },
      async onAudiencePublished({ projection }) {
        admissions.push(projection.sourceRevision);
        if (rejectAdmission) throw new Error("audience admission rejected");
      }
    });
    await committer.commitManifestSnapshot(snapshot(1, [serviceEntry()]));
    retireScope.mockClear();
    const second = snapshot(2, [serviceEntry({ revision: 2 })]);
    rejectAdmission = true;
    await expect(committer.commitManifestSnapshot(second)).rejects.toThrow(/admission rejected/u);
    expect(retireScope).toHaveBeenCalledTimes(1);

    rejectAdmission = false;
    await committer.commitManifestSnapshot(second);
    expect(retireScope).toHaveBeenCalledTimes(1);
    expect(admissions.filter((revision) => revision === 2)).toHaveLength(2);
    expect(publications.filter((item) =>
      item.topic === "upstream.audiences_published" && item.revision === 2
    )).toHaveLength(1);
    platform.close();
  });

  it("ignores stale revisions and does not emit a publication event", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const publications = [];
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [],
      getOperationPermissionPlatform: () => platform,
      protocolEventBus: { publish: (_topic, event) => publications.push(event) }
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

  it("forwards projected operations through the same governed path and denies before network side effects", async () => {
    const { platform } = await platformHarness();
    const registry = createUpstreamGatewayRegistry({});
    const committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () => [BASE_OPERATION],
      getOperationPermissionPlatform: () => platform
    });
    const candidate = snapshot(4, [serviceEntry({
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
    const projection = compileUpstreamOperationProjection(candidate);
    expect((await committer.commitManifestSnapshot(candidate)).outcome).toBe("committed");
    const denied = await registry.forwardProjectedOperation(
      projection.operations[0].id,
      {},
      { subjectId: "tester", scopes: [] }
    ).catch((error) => error);
    expect(denied).toMatchObject({ status: 403 });
    const pending = await registry.forwardProjectedOperation(
      projection.operations[0].id,
      {},
      { subjectId: "tester", scopes: ["gateway:read"] }
    );
    expect(pending).toMatchObject({ status: "pending_approval" });
    platform.close();
  });
});
