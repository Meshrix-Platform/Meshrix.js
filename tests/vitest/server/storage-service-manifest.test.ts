import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.ts";
import {
  canonicalizeTypedReferenceManifest,
  SERVICE_MANIFEST_SCHEMA_VERSION,
  sha256ManifestBytes,
  stableManifestJson
} from "../../../packages/foundation/src/storage/storage-ports.ts";
import {
  SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS,
  serviceManifestSetDigest
} from "../../../packages/foundation/src/storage/service-manifest-transaction.ts";
import { openSqliteDatabase } from "../../../packages/foundation/src/storage/sqlite-database.ts";

const roots: any[] = [];

function digest(label?: any) : any {
  return createHash("sha256").update(label).digest("hex");
}

function manifest(label?: any, references: any = []) : any {
  return {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    references,
    payload: {
      operations: [{ key: "probe", method: "POST" }],
      label
    },
    metadata: { source: "verified-input" }
  };
}

async function tempRoot() : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-storage-manifest-"));
  roots.push(root);
  return root;
}

async function acknowledge(store?: any, outcome?: any) : Promise<any> {
  return store.acknowledgePublished({
    setRevision: outcome.setRevision,
    setDigest: outcome.setDigest
  });
}

async function waitForFile(filePath?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 200; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve?: any) : any => setTimeout(resolve, 5));
    }
  }
  throw new Error("competitor did not reach the publication barrier");
}

function startCommitCompetitor({ storageRoot, suffix, readyPath, releasePath }: Record<string, any>) : any {
  const source: any = `
    import fs from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { createServiceManifestStore } from "./packages/foundation/src/storage/service-manifest-store.ts";
    import { SERVICE_MANIFEST_SCHEMA_VERSION } from "./packages/foundation/src/storage/storage-ports.ts";
    const [storageRoot, suffix, readyPath, releasePath] = process.argv.slice(1);
    await fs.writeFile(readyPath, "ready");
    while (true) {
      try { await fs.access(releasePath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    const digest = createHash("sha256").update("process-" + suffix).digest("hex");
    try {
      await createServiceManifestStore({ storageRoot }).commitManifestSet({
        serviceId: "svc_01J00000000000000000000" + suffix,
        expectedServiceRevision: 0,
        expectedSetRevision: 0,
        requestDigest: digest,
        manifest: {
          schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
          references: [],
          payload: { operations: [{ key: "probe", method: "POST" }], label: suffix },
          metadata: { source: "verified-input" }
        }
      });
      process.stdout.write("committed");
    } catch (error) {
      const fenced = error?.code === "storage_manifest_cas_stale" ||
        error?.code === "storage_manifest_set_revision_stale";
      process.stdout.write(fenced ? "fenced" : "failed:" + String(error?.code || error?.name || "unknown"));
    }
  `;
  const child: any = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    source,
    storageRoot,
    suffix,
    readyPath,
    releasePath
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve?: any, reject?: any) : any => {
    let output: any = "";
    child.stdout.on("data", (chunk?: any) : any => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code?: any) : any => code === 0 ? resolve(output) : reject(new Error("competitor failed")));
  });
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("durable service manifest authority", () : any => {
  it("keeps an absent authority root absent during a reader-only snapshot", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    await expect(store.getSnapshot()).resolves.toMatchObject({ setRevision: 0, serviceCount: 0 });
    await expect(fs.stat(path.join(storageRoot, "service-manifests")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps candidates invisible until their exact digest is acknowledged", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const outcome: any = await store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000b",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("candidate-only"),
      manifest: manifest("candidate-only")
    });
    await expect(store.getSnapshot()).resolves.toMatchObject({ setRevision: 0, serviceCount: 0 });
    await expect(store.getCandidateSnapshot()).resolves.toMatchObject({ setRevision: 1, serviceCount: 1 });
    await expect(store.acknowledgePublished({
      setRevision: outcome.setRevision,
      setDigest: digest("wrong-candidate")
    })).rejects.toMatchObject({ code: "storage_manifest_acknowledgement_stale" });
    await acknowledge(store, outcome);
    await expect(store.getSnapshot()).resolves.toMatchObject({ setRevision: 1, serviceCount: 1 });
  });

  it("commits monotonic revisions and preserves immutable reader snapshots across restart", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const serviceId: any = "svc_01J0000000000000000000000";
    const store: any = createServiceManifestStore({ storageRoot });
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(store.writerPort)).toBe(true);
    expect(Object.isFrozen(store.readerPort)).toBe(true);

    const first: any = await store.writerPort.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("first-request"),
      manifest: manifest("first", [{
        type: "credential",
        reference: "credential://vault/service-one",
        revision: 1,
        use: "request-auth",
        operationKey: "probe",
        host: "service.example",
        protocol: "https",
        scopes: ["write", "read"]
      }])
    });
    expect(first).toMatchObject({ serviceRevision: 1, setRevision: 1, replayed: false });
    await acknowledge(store, first);

    const oldSnapshot: any = await store.readerPort.getSnapshot();
    expect(Object.isFrozen(oldSnapshot)).toBe(true);
    expect(Object.isFrozen(oldSnapshot.getService(serviceId))).toBe(true);
    expect(Object.isFrozen(oldSnapshot.getService(serviceId).manifest)).toBe(true);
    expect(oldSnapshot.getService(serviceId).manifest.payload.label).toBe("first");

    const second: any = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("second-request"),
      manifest: manifest("second")
    });
    expect(second).toMatchObject({ serviceRevision: 2, setRevision: 2, replayed: false });
    await acknowledge(store, second);
    expect(oldSnapshot.setRevision).toBe(1);
    expect(oldSnapshot.getService(serviceId).manifest.payload.label).toBe("first");

    const reopened: any = createServiceManifestStore({ storageRoot });
    const currentSnapshot: any = await reopened.getSnapshot();
    expect(currentSnapshot).toMatchObject({ setRevision: 2, serviceCount: 1 });
    expect(currentSnapshot.getService(serviceId)).toMatchObject({
      serviceRevision: 2,
      manifestDigest: second.manifestDigest
    });
    expect(currentSnapshot.getService(serviceId).manifest.payload.label).toBe("second");

    const authorityRoot: any = path.join(storageRoot, "service-manifests");
    const authorityEntries: any = await fs.readdir(authorityRoot);
    expect(authorityEntries).toContain("authority.sqlite");
    expect(authorityEntries).not.toContain("manifests");
    expect(authorityEntries).not.toContain("generations");
    if (process.platform !== "win32") {
      expect((await fs.stat(authorityRoot)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(authorityRoot, "authority.sqlite"))).mode &
          0o777
      ).toBe(0o600);
    }
  });

  it("returns an identical durable outcome for replay and rejects conflicting reuse", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const serviceId: any = "svc_01J0000000000000000000001";
    const requestDigest: any = digest("idempotent-request");
    const store: any = createServiceManifestStore({ storageRoot });
    const input: Record<string, any> = {
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest,
      manifest: manifest("stable")
    };
    const committed: any = await store.commitManifestSet(input);
    await acknowledge(store, committed);
    const replayed: any = await store.commitManifestSet(input);
    expect(replayed).toEqual({ ...committed, replayed: true });

    await expect(store.commitManifestSet({
      ...input,
      manifest: manifest("conflict")
    })).rejects.toMatchObject({ code: "storage_manifest_replay_conflict" });
    expect((await store.getSnapshot()).setRevision).toBe(1);

    const reopened: any = createServiceManifestStore({ storageRoot });
    await expect(reopened.commitManifestSet(input)).resolves.toEqual(replayed);

    const unchanged: any = await reopened.commitManifestSet({
      ...input,
      requestDigest: digest("same-content-new-request"),
      expectedServiceRevision: committed.serviceRevision,
      expectedSetRevision: committed.setRevision
    });
    expect(unchanged).toMatchObject({
      serviceRevision: committed.serviceRevision,
      setRevision: committed.setRevision,
      manifestDigest: committed.manifestDigest,
      replayed: false
    });
  });

  it("checks service and manifest-set revisions before replacement", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const firstServiceId: any = "svc_01J0000000000000000000002";
    const first: any = await store.commitManifestSet({
      serviceId: firstServiceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("cas-first"),
      manifest: manifest("first")
    });
    await acknowledge(store, first);
    await expect(store.commitManifestSet({
      serviceId: firstServiceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 1,
      requestDigest: digest("stale-service"),
      manifest: manifest("stale")
    })).rejects.toMatchObject({ code: "storage_manifest_service_revision_stale" });
    await expect(store.commitManifestSet({
      serviceId: "svc_01J0000000000000000000003",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("stale-set"),
      manifest: manifest("stale-set")
    })).rejects.toMatchObject({ code: "storage_manifest_set_revision_stale" });
    expect((await store.getSnapshot()).setRevision).toBe(1);
  });

  it("serializes concurrent CAS attempts without losing the accepted generation", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const commit: any = (suffix?: any) : any => store.commitManifestSet({
      serviceId: `svc_01J00000000000000000000${suffix}`,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest(`concurrent-${suffix}`),
      manifest: manifest(`concurrent-${suffix}`)
    });
    const outcomes: any = await Promise.allSettled([commit("04"), commit("05")]);
    expect(outcomes.filter((outcome?: any) : any => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome?: any) : any => outcome.status === "rejected")[0].reason)
      .toMatchObject({ code: "storage_manifest_set_revision_stale" });
    const accepted: any = outcomes.find((outcome?: any) : any => outcome.status === "fulfilled").value;
    await acknowledge(store, accepted);
    expect((await store.getSnapshot())).toMatchObject({ setRevision: 1, serviceCount: 1 });
  });

  it("bounds unpublished version and blob growth until acknowledgement", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const serviceId: any = "svc_01J00000000000000000000ba";
    const store: any = createServiceManifestStore({ storageRoot });
    let current: any = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("backlog-1"),
      manifest: manifest("backlog-1")
    });
    for (
      let revision: any = 2;
      revision <= SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS;
      revision += 1
    ) {
      current = await store.commitManifestSet({
        serviceId,
        expectedServiceRevision: revision - 1,
        expectedSetRevision: revision - 1,
        requestDigest: digest(`backlog-${revision}`),
        manifest: manifest(`backlog-${revision}`)
      });
    }
    await expect(store.commitManifestSet({
      serviceId,
      expectedServiceRevision:
        SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS,
      expectedSetRevision:
        SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS,
      requestDigest: digest("backlog-overflow"),
      manifest: manifest("backlog-overflow")
    })).rejects.toMatchObject({
      code: "storage_manifest_publication_backlog_exceeded"
    });
    await store.acknowledgePublished({
      setRevision: current.setRevision,
      setDigest: current.setDigest,
      budget: {
        maxCleanupEntries:
          SERVICE_MANIFEST_MAX_UNPUBLISHED_SET_REVISIONS
      }
    });
    const database: any = openSqliteDatabase(path.join(
      storageRoot,
      "service-manifests",
      "authority.sqlite"
    ), { readonly: true, fileMustExist: true });
    expect(database.prepare(`
      SELECT COUNT(*) AS value FROM manifest_service_versions
    `).get().value).toBe(1);
    expect(database.prepare(`
      SELECT COUNT(*) AS value FROM manifest_blobs
    `).get().value).toBe(1);
    const requestPlan: any = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM manifest_requests WHERE request_digest=?
    `).all(digest("backlog-1"))
      .map((row?: any) : any => String(row.detail || "")).join(" ");
    expect(requestPlan).toContain(
      "sqlite_autoindex_manifest_requests_1"
    );
    database.close();
  });

  it("fences competing writers across processes at the durable CAS boundary", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const readyOne: any = path.join(storageRoot, "ready-one");
    const readyTwo: any = path.join(storageRoot, "ready-two");
    const releasePath: any = path.join(storageRoot, "release");
    const competitors: any[] = [
      startCommitCompetitor({ storageRoot, suffix: "0c", readyPath: readyOne, releasePath }),
      startCommitCompetitor({ storageRoot, suffix: "0d", readyPath: readyTwo, releasePath })
    ];
    await Promise.all([waitForFile(readyOne), waitForFile(readyTwo)]);
    await fs.writeFile(releasePath, "go");
    const outcomes: any = await Promise.all(competitors);
    expect(outcomes.sort()).toEqual(["committed", "fenced"]);
    await expect(createServiceManifestStore({ storageRoot }).getCandidateSnapshot())
      .resolves.toMatchObject({ setRevision: 1, serviceCount: 1 });
  });

  it("evicts request history by count and age without permanent exhaustion", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    let clock: any = Date.UTC(2026, 6, 23);
    const store: any = createServiceManifestStore({
      storageRoot,
      now: () : any => clock
    });
    const serviceId: any = "svc_01J000000000000000000000e";
    const firstRequestDigest: any = digest("bounded-history-0");
    await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: firstRequestDigest,
      manifest: manifest("bounded-cleanup")
    });
    for (let index: any = 1; index < 5; index += 1) {
      await store.commitManifestSet({
        serviceId,
        expectedServiceRevision: 1,
        expectedSetRevision: 1,
        requestDigest: digest(`bounded-history-${index}`),
        manifest: manifest("bounded-cleanup"),
        budget: {
          maxRequestRecords: 3,
          maxRequestBytes: 64 * 1024,
          maxCleanupEntries: 1
        }
      });
    }
    const databasePath: any = path.join(
      storageRoot,
      "service-manifests",
      "authority.sqlite"
    );
    let database: any = openSqliteDatabase(databasePath, {
      readonly: true,
      fileMustExist: true
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS value FROM manifest_requests"
    ).get().value).toBe(3);
    database.close();
    await expect(store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: firstRequestDigest,
      manifest: manifest("bounded-cleanup")
    })).rejects.toMatchObject({
      code: "storage_manifest_service_revision_stale"
    });

    clock += 8 * 24 * 60 * 60 * 1000;
    await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("bounded-history-after-expiry"),
      manifest: manifest("bounded-cleanup"),
      budget: {
        maxRequestRecords: 3,
        maxRequestBytes: 64 * 1024,
        maxCleanupEntries: 3
      }
    });
    database = openSqliteDatabase(databasePath, {
      readonly: true,
      fileMustExist: true
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS value FROM manifest_requests"
    ).get().value).toBe(1);
    database.close();
  });

  it("enforces opaque identity, typed references, and the sensitive-material boundary", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const base: Record<string, any> = {
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("invalid-input")
    };
    await expect(store.commitManifestSet({
      ...base,
      serviceId: "../service",
      manifest: manifest("unsafe")
    })).rejects.toMatchObject({ code: "storage_manifest_service_id_invalid" });
    await expect(store.commitManifestSet({
      ...base,
      serviceId: "svc_01J0000000000000000000006",
      manifest: {
        schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
        references: [],
        payload: { accessToken: "not-persistable" }
      }
    })).rejects.toMatchObject({ code: "storage_manifest_sensitive_material" });
    await expect(store.commitManifestSet({
      ...base,
      serviceId: "svc_01J0000000000000000000006",
      manifest: manifest("unsafe-reference", [{
        type: "certificate",
        reference: "credential://wrong-kind",
        revision: 1,
        use: "server-auth"
      }])
    })).rejects.toMatchObject({ code: "storage_manifest_reference_invalid" });
    await expect(fs.stat(path.join(storageRoot, "service-manifests")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows sensitive field names in JSON Schema while rejecting material at runtime paths", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const serviceId: any = "svc_01J0000000000000000000007";
    await expect(store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("schema-sensitive-name"),
      manifest: {
        schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
        references: [],
        payload: {
          descriptor: {
            responseSchema: {
              type: "object",
              properties: {
                password: { type: "string" }
              }
            }
          }
        },
        metadata: {}
      }
    })).resolves.toMatchObject({ serviceRevision: 1, setRevision: 1 });

    await expect(store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("runtime-sensitive-value"),
      manifest: {
        schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
        references: [],
        payload: { password: "material-must-not-persist" },
        metadata: {}
      }
    })).rejects.toMatchObject({ code: "storage_manifest_sensitive_material" });
  });

  it("honors cancellation and resource budgets before the publication point", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const controller: any = new AbortController();
    const cancelled: any = Object.assign(new Error("cancelled by caller"), { code: "test_cancelled" });
    controller.abort(cancelled);
    await expect(store.commitManifestSet({
      serviceId: "svc_01J0000000000000000000007",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("cancelled-request"),
      manifest: manifest("cancelled"),
      signal: controller.signal
    })).rejects.toBe(cancelled);
    await expect(store.commitManifestSet({
      serviceId: "svc_01J0000000000000000000007",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("oversize-request"),
      manifest: manifest("x".repeat(512)),
      budget: { maxManifestBytes: 64 }
    })).rejects.toMatchObject({ code: "storage_manifest_budget_exceeded" });
    await expect(fs.stat(path.join(storageRoot, "service-manifests")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back service, digest, and request rows together on capacity failure", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const serviceId: any = "svc_01J0000000000000000000008";
    const store: any = createServiceManifestStore({ storageRoot });
    const baseline: any = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("recovery-baseline"),
      manifest: manifest("baseline")
    });
    await acknowledge(store, baseline);
    await expect(store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("interrupted-update"),
      manifest: manifest("interrupted"),
      budget: { maxRequestBytes: 1 }
    })).rejects.toMatchObject({
      code: "storage_manifest_request_capacity_exceeded"
    });

    const reopened: any = createServiceManifestStore({ storageRoot });
    const candidate: any = await reopened.getCandidateSnapshot();
    expect(candidate.setRevision).toBe(1);
    expect(candidate.getService(serviceId)).toMatchObject({
      serviceRevision: 1,
      manifestDigest: baseline.manifestDigest
    });
    const database: any = openSqliteDatabase(path.join(
      storageRoot,
      "service-manifests",
      "authority.sqlite"
    ), { readonly: true, fileMustExist: true });
    expect(database.prepare(
      "SELECT COUNT(*) AS value FROM manifest_blobs"
    ).get().value).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS value FROM manifest_requests"
    ).get().value).toBe(1);
    database.close();
  });

  it("rejects a partial normalized authority schema instead of repairing it", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const authorityRoot: any = path.join(storageRoot, "service-manifests");
    await fs.mkdir(authorityRoot, { recursive: true });
    const databasePath: any = path.join(authorityRoot, "authority.sqlite");
    const database: any = openSqliteDatabase(databasePath);
    database.exec("CREATE TABLE manifest_services(service_id TEXT PRIMARY KEY)");
    database.close();
    await expect(
      createServiceManifestStore({ storageRoot }).getSnapshot()
    ).rejects.toMatchObject({
      code: "storage_manifest_index_incomplete"
    });
  });

  it("publishes in O(1) pointer work and cleans obsolete versions in bounded batches", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const serviceId: any = "svc_01J0000000000000000000013";
    const store: any = createServiceManifestStore({ storageRoot });
    let current: any = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("cleanup-baseline"),
      manifest: manifest("baseline")
    });
    for (let revision: any = 2; revision <= 4; revision += 1) {
      current = await store.commitManifestSet({
        serviceId,
        expectedServiceRevision: revision - 1,
        expectedSetRevision: revision - 1,
        requestDigest: digest(`cleanup-candidate-${revision}`),
        manifest: manifest(`candidate-${revision}`)
      });
    }
    await store.acknowledgePublished({
      setRevision: current.setRevision,
      setDigest: current.setDigest,
      budget: { maxCleanupEntries: 1 }
    });
    const snapshot: any = await createServiceManifestStore({ storageRoot }).getSnapshot();
    expect(snapshot.setRevision).toBe(4);
    expect(snapshot.getService(serviceId).manifest.payload.label).toBe("candidate-4");
    const databasePath: any = path.join(
      storageRoot,
      "service-manifests",
      "authority.sqlite"
    );
    let database: any = openSqliteDatabase(databasePath, {
      readonly: true,
      fileMustExist: true
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS value FROM manifest_service_versions
    `).get().value).toBe(3);
    database.close();

    await store.acknowledgePublished({
      setRevision: current.setRevision,
      setDigest: current.setDigest,
      budget: { maxCleanupEntries: 16 }
    });
    database = openSqliteDatabase(databasePath, {
      readonly: true,
      fileMustExist: true
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS value FROM manifest_service_versions
    `).get().value).toBe(1);
    expect(database.prepare(`
      SELECT COUNT(*) AS value FROM manifest_blobs
    `).get().value).toBe(1);
    database.close();
  });

  it("rejects symlink or non-regular storage roots before persistence", async () : Promise<any> => {
    const parent: any = await tempRoot();
    const realRoot: any = path.join(parent, "real-root");
    const linkedRoot: any = path.join(parent, "linked-root");
    await fs.mkdir(realRoot, { recursive: true });
    await fs.symlink(realRoot, linkedRoot);
    const store: any = createServiceManifestStore({ storageRoot: linkedRoot });
    await expect(store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000a",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("symlink-root"),
      manifest: manifest("symlink")
    })).rejects.toMatchObject({ code: "storage_manifest_directory_unsafe" });
  });

  it("rejects a symlinked SQLite authority without advancing state", async () : Promise<any> => {
    const storageRoot: any = await tempRoot();
    const store: any = createServiceManifestStore({ storageRoot });
    const first: any = await store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000f",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("writer-fence-baseline"),
      manifest: manifest("baseline")
    });
    const authorityRoot: any = path.join(storageRoot, "service-manifests");
    const databasePath: any = path.join(authorityRoot, "authority.sqlite");
    const outside: any = path.join(await tempRoot(), "outside.sqlite");
    await fs.rename(databasePath, outside);
    await fs.symlink(outside, databasePath);

    await expect(store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000f",
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("writer-fence-rejected"),
      manifest: manifest("rejected")
    })).rejects.toMatchObject({ code: "storage_manifest_file_unsafe" });
    await fs.rm(databasePath, { force: true });
    await fs.rename(outside, databasePath);
    expect((await store.getCandidateSnapshot()).setRevision).toBe(
      first.setRevision
    );
    expect((await store.getSnapshot()).setRevision).toBe(0);
  });

});
