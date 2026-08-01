import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestObserver,
  createUpstreamManifestSnapshotCommitter,
  createUpstreamPublishingApplication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "../../../packages/agents/src/upstream-gateway/index.ts";
import { createOperationPermissionPlatform } from "../../../packages/capabilities/src/operation-permission-core/index.ts";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.ts";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

const roots: any[] = [];

async function temporaryRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-upstream-observer-composition-"));
  roots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("upstream manifest observer composition", () : any => {
  it("starts from the durable manifest authority and swaps one immutable snapshot", async () : Promise<any> => {
    const storageRoot: any = await temporaryRoot();
    const userDataPath: any = await temporaryRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const audits: any[] = [];
    const registry: any = createUpstreamGatewayRegistry({ userDataPath });
    const candidateReaderPort: Readonly<Record<string, any>> = Object.freeze({ getSnapshot: store.getCandidateSnapshot });
    const observer: any = createUpstreamManifestObserver({
      readerPort: candidateReaderPort,
      async onSnapshot(snapshot?: any) : Promise<any> {
        registry.replaceFromManifestSnapshot(snapshot);
        await store.acknowledgePublished({
          setRevision: snapshot.setRevision,
          setDigest: snapshot.setDigest
        });
      },
      onError(event?: any) : any {
        audits.push(event);
      },
      pollIntervalMs: 60_000
    });

    expect(await observer.start()).toEqual({ outcome: "accepted", setRevision: 0 });
    expect(registry.listServices().count).toBe(0);

    const application: any = createUpstreamPublishingApplication({
      writerPort: {
        async commitManifestSet(input?: any) : Promise<any> {
          const outcome: any = await store.writerPort.commitManifestSet(input);
          if (!outcome.replayed) observer.invalidate();
          return outcome;
        }
      },
      readerPort: candidateReaderPort,
      auditPort: { append: async () : Promise<any> => {} }
    });
    const created: any = await application.execute(JSON.stringify({
      schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
      action: "create",
      serviceKey: "observed",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      idempotencyKey: "compose-create",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        references: [],
        operations: [{
          operationKey: "read", method: "GET", path: "/read",
          payloadTransport: structuredJsonPayloadTransport()
        }]
      }
    }), { subjectId: "developer", scopes: ["gateway:write", "gateway:maintain"] });

    expect(created).toMatchObject({ state: "publishing", serviceRevision: 1, setRevision: 1 });
    expect(await observer.scan()).toEqual({ outcome: "accepted", setRevision: 1 });
    expect(registry.listServices()).toMatchObject({ count: 1 });
    expect(registry.listServices().items[0].serviceId).toBe(created.serviceId);

    await observer.close();
    await registry.close();
  });

  it("restarts from the published snapshot and rejects a newer invalid candidate without moving the catalog", async () : Promise<any> => {
    const storageRoot: any = await temporaryRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const candidateReaderPort: Readonly<Record<string, any>> = Object.freeze({ getSnapshot: store.getCandidateSnapshot });
    const firstRegistry: any = createUpstreamGatewayRegistry({});
    const firstObserver: any = createUpstreamManifestObserver({
      readerPort: candidateReaderPort,
      async onSnapshot(snapshot?: any) : Promise<any> {
        firstRegistry.replaceFromManifestSnapshot(snapshot);
        await store.acknowledgePublished({
          setRevision: snapshot.setRevision,
          setDigest: snapshot.setDigest
        });
      },
      pollIntervalMs: 60_000
    });
    await firstObserver.start();
    const application: any = createUpstreamPublishingApplication({
      writerPort: store.writerPort,
      readerPort: candidateReaderPort,
      auditPort: { append: async () : Promise<any> => {} }
    });
    const created: any = await application.execute(JSON.stringify({
      schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
      action: "create",
      serviceKey: "restart-valid",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      idempotencyKey: "restart-valid-create",
      descriptor: {
        serviceProtocol: "http",
        baseUrl: "https://service.invalid:443",
        references: [],
        operations: [{
          operationKey: "read", method: "GET", path: "/read",
          payloadTransport: structuredJsonPayloadTransport()
        }]
      }
    }), { subjectId: "developer", scopes: ["gateway:write", "gateway:maintain"] });
    expect(await firstObserver.scan()).toMatchObject({ outcome: "accepted", setRevision: 1 });
    await firstObserver.close();
    await firstRegistry.close();

    const acceptedRecord: any = (await store.getCandidateSnapshot()).getService(created.serviceId);
    const invalidManifest: any = structuredClone(acceptedRecord.manifest);
    invalidManifest.payload.descriptor.operations = [];
    await store.commitManifestSet({
      serviceId: created.serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      manifest: invalidManifest,
      requestDigest: createHash("sha256").update("invalid-restart-candidate").digest("hex")
    });

    const registry: any = createUpstreamGatewayRegistry({});
    const platformRoot: any = await temporaryRoot();
    const platform: any = createOperationPermissionPlatform({
      userDataPath: platformRoot,
      operations: [],
      featureRuntime: null,
      operationDispatcher: async () : Promise<any> => ({ ok: true }),
      controllers: {}
    });
    let committer: any = null;
    let publishedBootstrap: any = null;
    let firstRead: any = true;
    const observer: any = createUpstreamManifestObserver({
      readerPort: {
        async getSnapshot(input?: any) : Promise<any> {
          if (firstRead) {
            firstRead = false;
            return store.getSnapshot(input);
          }
          return store.getCandidateSnapshot(input);
        }
      },
      async onSnapshot(snapshot?: any) : Promise<any> {
        if (!committer) {
          registry.replaceFromManifestSnapshot(snapshot);
          publishedBootstrap = snapshot;
          return;
        }
        await committer.commitManifestSnapshot(snapshot);
        await store.acknowledgePublished({
          setRevision: snapshot.setRevision,
          setDigest: snapshot.setDigest
        });
      },
      pollIntervalMs: 60_000
    });
    expect(await observer.start()).toMatchObject({ outcome: "accepted", setRevision: 1 });
    committer = createUpstreamManifestSnapshotCommitter({
      registry,
      getBaseOperations: () : any => [],
      getOperationPermissionPlatform: () : any => platform
    });
    await committer.commitManifestSnapshot(publishedBootstrap);
    expect(await observer.scan()).toMatchObject({ outcome: "rejected", setRevision: 1 });
    expect(registry.getManifestSnapshotRevision()).toMatchObject({ sourceRevision: 1 });
    expect(platform.upstreamCatalogState()).toMatchObject({ sourceRevision: 1, operationCount: 1 });
    expect((await store.getSnapshot()).setRevision).toBe(1);
    expect((await store.getCandidateSnapshot()).setRevision).toBe(2);

    await observer.close();
    await registry.close();
    platform.close();
  });
});
