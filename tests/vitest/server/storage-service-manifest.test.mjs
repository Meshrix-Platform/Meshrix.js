import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceManifestStore } from "../../../packages/foundation/src/storage/service-manifest-store.mjs";
import { SERVICE_MANIFEST_SCHEMA_VERSION } from "../../../packages/foundation/src/storage/storage-ports.mjs";

const roots = [];

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

function manifest(label, references = []) {
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

function injectedIoFailure() {
  return Object.assign(new Error("injected storage phase failure"), { code: "EIO" });
}

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-storage-manifest-"));
  roots.push(root);
  return root;
}

async function acknowledge(store, outcome) {
  return store.acknowledgePublished({
    setRevision: outcome.setRevision,
    setDigest: outcome.setDigest
  });
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("competitor did not reach the publication barrier");
}

function startCommitCompetitor({ storageRoot, suffix, readyPath, releasePath }) {
  const source = `
    import fs from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { createServiceManifestStore } from "./packages/foundation/src/storage/service-manifest-store.mjs";
    import { SERVICE_MANIFEST_SCHEMA_VERSION } from "./packages/foundation/src/storage/storage-ports.mjs";
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
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    source,
    storageRoot,
    suffix,
    readyPath,
    releasePath
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error("competitor failed")));
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("durable service manifest authority", () => {
  it("keeps an absent authority root absent during a reader-only snapshot", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    await expect(store.getSnapshot()).resolves.toMatchObject({ setRevision: 0, serviceCount: 0 });
    await expect(fs.stat(path.join(storageRoot, "service-manifests")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps candidates invisible until their exact digest is acknowledged", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const outcome = await store.commitManifestSet({
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

  it("commits monotonic revisions and preserves immutable reader snapshots across restart", async () => {
    const storageRoot = await tempRoot();
    const serviceId = "svc_01J0000000000000000000000";
    const store = createServiceManifestStore({ storageRoot });
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(store.writerPort)).toBe(true);
    expect(Object.isFrozen(store.readerPort)).toBe(true);

    const first = await store.writerPort.commitManifestSet({
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

    const oldSnapshot = await store.readerPort.getSnapshot();
    expect(Object.isFrozen(oldSnapshot)).toBe(true);
    expect(Object.isFrozen(oldSnapshot.getService(serviceId))).toBe(true);
    expect(Object.isFrozen(oldSnapshot.getService(serviceId).manifest)).toBe(true);
    expect(oldSnapshot.getService(serviceId).manifest.payload.label).toBe("first");

    const second = await store.commitManifestSet({
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

    const reopened = createServiceManifestStore({ storageRoot });
    const currentSnapshot = await reopened.getSnapshot();
    expect(currentSnapshot).toMatchObject({ setRevision: 2, serviceCount: 1 });
    expect(currentSnapshot.getService(serviceId)).toMatchObject({
      serviceRevision: 2,
      manifestDigest: second.manifestDigest
    });
    expect(currentSnapshot.getService(serviceId).manifest.payload.label).toBe("second");

    const authorityRoot = path.join(storageRoot, "service-manifests");
    const manifestNames = await fs.readdir(path.join(authorityRoot, "manifests"));
    const generationNames = await fs.readdir(path.join(authorityRoot, "generations"));
    expect([...manifestNames, ...generationNames].some((name) => name.includes(serviceId))).toBe(false);
    if (process.platform !== "win32") {
      expect((await fs.stat(authorityRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(authorityRoot, "latest.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("returns an identical durable outcome for replay and rejects conflicting reuse", async () => {
    const storageRoot = await tempRoot();
    const serviceId = "svc_01J0000000000000000000001";
    const requestDigest = digest("idempotent-request");
    const store = createServiceManifestStore({ storageRoot });
    const input = {
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest,
      manifest: manifest("stable")
    };
    const committed = await store.commitManifestSet(input);
    await acknowledge(store, committed);
    const replayed = await store.commitManifestSet(input);
    expect(replayed).toEqual({ ...committed, replayed: true });

    await expect(store.commitManifestSet({
      ...input,
      manifest: manifest("conflict")
    })).rejects.toMatchObject({ code: "storage_manifest_replay_conflict" });
    expect((await store.getSnapshot()).setRevision).toBe(1);

    const reopened = createServiceManifestStore({ storageRoot });
    await expect(reopened.commitManifestSet(input)).resolves.toEqual(replayed);

    const unchanged = await reopened.commitManifestSet({
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

  it("checks service and manifest-set revisions before replacement", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const firstServiceId = "svc_01J0000000000000000000002";
    const first = await store.commitManifestSet({
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

  it("serializes concurrent CAS attempts without losing the accepted generation", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const commit = (suffix) => store.commitManifestSet({
      serviceId: `svc_01J00000000000000000000${suffix}`,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest(`concurrent-${suffix}`),
      manifest: manifest(`concurrent-${suffix}`)
    });
    const outcomes = await Promise.allSettled([commit("04"), commit("05")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")[0].reason)
      .toMatchObject({ code: "storage_manifest_set_revision_stale" });
    const accepted = outcomes.find((outcome) => outcome.status === "fulfilled").value;
    await acknowledge(store, accepted);
    expect((await store.getSnapshot())).toMatchObject({ setRevision: 1, serviceCount: 1 });
  });

  it("fences competing writers across processes at the durable CAS boundary", async () => {
    const storageRoot = await tempRoot();
    const readyOne = path.join(storageRoot, "ready-one");
    const readyTwo = path.join(storageRoot, "ready-two");
    const releasePath = path.join(storageRoot, "release");
    const competitors = [
      startCommitCompetitor({ storageRoot, suffix: "0c", readyPath: readyOne, releasePath }),
      startCommitCompetitor({ storageRoot, suffix: "0d", readyPath: readyTwo, releasePath })
    ];
    await Promise.all([waitForFile(readyOne), waitForFile(readyTwo)]);
    await fs.writeFile(releasePath, "go");
    const outcomes = await Promise.all(competitors);
    expect(outcomes.sort()).toEqual(["committed", "fenced"]);
    await expect(createServiceManifestStore({ storageRoot }).getCandidateSnapshot())
      .resolves.toMatchObject({ setRevision: 1, serviceCount: 1 });
  });

  it("bounds cleanup discovery before deleting any staged entry", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const outcome = await store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000e",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("bounded-cleanup"),
      manifest: manifest("bounded-cleanup")
    });
    const authorityRoot = path.join(storageRoot, "service-manifests");
    const stagedNames = Array.from({ length: 257 }, (_, index) =>
      `.manifest.${index.toString(16).padStart(16, "0")}.tmp`);
    await Promise.all(stagedNames.map((name) => fs.writeFile(path.join(authorityRoot, name), "staged")));
    await store.acknowledgePublished({
      setRevision: outcome.setRevision,
      setDigest: outcome.setDigest,
      budget: { maxCleanupEntries: 256 }
    });
    const remaining = new Set(await fs.readdir(authorityRoot));
    expect(stagedNames.every((name) => remaining.has(name))).toBe(true);
    await expect(store.getSnapshot()).resolves.toMatchObject({ setRevision: 1, serviceCount: 1 });
  });

  it("enforces opaque identity, typed references, and the sensitive-material boundary", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const base = {
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

  it("allows sensitive field names in JSON Schema while rejecting material at runtime paths", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const serviceId = "svc_01J0000000000000000000007";
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

  it("honors cancellation and resource budgets before the publication point", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const controller = new AbortController();
    const cancelled = Object.assign(new Error("cancelled by caller"), { code: "test_cancelled" });
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

  it("recovers the previous generation when pointer publication is interrupted", async () => {
    const storageRoot = await tempRoot();
    const serviceId = "svc_01J0000000000000000000008";
    const store = createServiceManifestStore({ storageRoot });
    const baseline = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("recovery-baseline"),
      manifest: manifest("baseline")
    });
    await acknowledge(store, baseline);

    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.basename(String(target)) === "latest.json") {
        const error = new Error("injected pointer publication failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, target);
    });
    await expect(store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("interrupted-update"),
      manifest: manifest("interrupted")
    })).rejects.toMatchObject({ code: "EIO" });
    renameSpy.mockRestore();

    const authorityRoot = path.join(storageRoot, "service-manifests");
    await expect(fs.stat(path.join(authorityRoot, "journal.json"))).resolves.toBeTruthy();
    const recovered = await createServiceManifestStore({ storageRoot }).getSnapshot();
    expect(recovered.setRevision).toBe(1);
    expect(recovered.getService(serviceId).manifest.payload.label).toBe("baseline");
    await expect(fs.stat(path.join(authorityRoot, "journal.json"))).resolves.toBeTruthy();
    expect(await fs.readdir(path.join(authorityRoot, "generations"))).toHaveLength(2);
    expect(await fs.readdir(path.join(authorityRoot, "manifests"))).toHaveLength(2);
  });

  it("preserves the accepted snapshot across stage, sync, and journal faults", async () => {
    const phases = ["stage", "sync", "journal"];
    for (const phase of phases) {
      const storageRoot = await tempRoot();
      const serviceId = `svc_01J0000000000000000000${phase === "stage" ? "10" : phase === "sync" ? "11" : "12"}`;
      const store = createServiceManifestStore({ storageRoot });
      const baseline = await store.commitManifestSet({
        serviceId,
        expectedServiceRevision: 0,
        expectedSetRevision: 0,
        requestDigest: digest(`fault-${phase}-baseline`),
        manifest: manifest("baseline")
      });
      await acknowledge(store, baseline);

      if (phase === "journal") {
        const originalRename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
          if (path.basename(String(target)) === "journal.json") throw injectedIoFailure();
          return originalRename(source, target);
        });
      } else {
        const originalOpen = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (target, ...args) => {
          const handle = await originalOpen(target, ...args);
          const name = path.basename(String(target));
          if (phase === "stage" && name.startsWith(".manifest.")) {
            vi.spyOn(handle, "writeFile").mockRejectedValueOnce(injectedIoFailure());
          }
          if (phase === "sync" && name.startsWith(".generation.")) {
            vi.spyOn(handle, "sync").mockRejectedValueOnce(injectedIoFailure());
          }
          return handle;
        });
      }

      await expect(store.commitManifestSet({
        serviceId,
        expectedServiceRevision: 1,
        expectedSetRevision: 1,
        requestDigest: digest(`fault-${phase}-candidate`),
        manifest: manifest(`candidate-${phase}`)
      })).rejects.toMatchObject({ code: "EIO" });
      vi.restoreAllMocks();
      const snapshot = await createServiceManifestStore({ storageRoot }).getSnapshot();
      expect(snapshot.setRevision).toBe(1);
      expect(snapshot.getService(serviceId).manifest.payload.label).toBe("baseline");
    }
  });

  it("keeps the new complete snapshot authoritative when post-ack cleanup fails", async () => {
    const storageRoot = await tempRoot();
    const serviceId = "svc_01J0000000000000000000013";
    const store = createServiceManifestStore({ storageRoot });
    const baseline = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("cleanup-baseline"),
      manifest: manifest("baseline")
    });
    await acknowledge(store, baseline);
    const candidate = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("cleanup-candidate"),
      manifest: manifest("candidate")
    });
    const originalUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (path.dirname(String(target)).endsWith("generations")) throw injectedIoFailure();
      return originalUnlink(target);
    });
    await acknowledge(store, candidate);
    vi.restoreAllMocks();
    const snapshot = await createServiceManifestStore({ storageRoot }).getSnapshot();
    expect(snapshot.setRevision).toBe(2);
    expect(snapshot.getService(serviceId).manifest.payload.label).toBe("candidate");
  });

  it("rejects symlink or non-regular storage roots before persistence", async () => {
    const parent = await tempRoot();
    const realRoot = path.join(parent, "real-root");
    const linkedRoot = path.join(parent, "linked-root");
    await fs.mkdir(realRoot, { recursive: true });
    await fs.symlink(realRoot, linkedRoot);
    const store = createServiceManifestStore({ storageRoot: linkedRoot });
    await expect(store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000a",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("symlink-root"),
      manifest: manifest("symlink")
    })).rejects.toMatchObject({ code: "storage_manifest_directory_unsafe" });
  });

  it("rejects a symlinked writer fence without advancing candidate or published authority", async () => {
    const storageRoot = await tempRoot();
    const store = createServiceManifestStore({ storageRoot });
    const first = await store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000f",
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("writer-fence-baseline"),
      manifest: manifest("baseline")
    });
    const outside = path.join(await tempRoot(), "outside-fence");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(storageRoot, "service-manifests", ".writer-fence"));

    await expect(store.commitManifestSet({
      serviceId: "svc_01J000000000000000000000f",
      expectedServiceRevision: 1,
      expectedSetRevision: 1,
      requestDigest: digest("writer-fence-rejected"),
      manifest: manifest("rejected")
    })).rejects.toMatchObject({ code: "storage_manifest_file_unsafe" });
    expect((await store.getCandidateSnapshot()).setRevision).toBe(first.setRevision);
    expect((await store.getSnapshot()).setRevision).toBe(0);
  });

  it("finalizes a committed generation when journal cleanup was interrupted", async () => {
    const storageRoot = await tempRoot();
    const serviceId = "svc_01J0000000000000000000009";
    const store = createServiceManifestStore({ storageRoot });
    const originalUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (path.basename(String(target)) === "journal.json") {
        const error = new Error("injected journal cleanup failure");
        error.code = "EIO";
        throw error;
      }
      return originalUnlink(target);
    });
    const committed = await store.commitManifestSet({
      serviceId,
      expectedServiceRevision: 0,
      expectedSetRevision: 0,
      requestDigest: digest("commit-before-cleanup"),
      manifest: manifest("committed")
    });
    expect(committed.setRevision).toBe(1);
    await acknowledge(store, committed);
    unlinkSpy.mockRestore();

    const authorityRoot = path.join(storageRoot, "service-manifests");
    await expect(fs.stat(path.join(authorityRoot, "journal.json"))).resolves.toBeTruthy();
    const recovered = await createServiceManifestStore({ storageRoot }).getSnapshot();
    expect(recovered.getService(serviceId).manifest.payload.label).toBe("committed");
    await expect(fs.stat(path.join(authorityRoot, "journal.json"))).resolves.toBeTruthy();
  });
});
