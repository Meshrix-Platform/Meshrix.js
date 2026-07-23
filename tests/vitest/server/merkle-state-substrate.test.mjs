import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PACTIUM_PROTOCOL } from "pactium";
import { describe, expect, it } from "vitest";
import {
  createPactiumStateSubstrate,
} from "#lico/foundation/checkpoint/tree/merkle-state-substrate";
import { createLicoPactiumRuntime } from "#lico/foundation/checkpoint/tree/pactium-substrate-preflight";

async function withTempSubstrate(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-merkle-state-vitest-"));
  const substrate = createPactiumStateSubstrate({ userDataPath });
  try {
    return await testCase({ userDataPath, substrate });
  } finally {
    await substrate.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

describe("merkle state substrate", () => {
  it("normalizes canonical data and stores raw/dag-json CAS blocks", async () => {
    await withTempSubstrate(async ({ substrate }) => {
      expect(substrate.protocolVersion).toBe(PACTIUM_PROTOCOL);
      expect(substrate.listCapabilities().capabilities).toContain("content-addressed-store");
      expect(substrate.canonicalCodec.normalize({
        b: undefined,
        a: Buffer.from("bytes"),
      })).toEqual({
        a: { $bytes: "Ynl0ZXM=" },
      });
      expect(substrate.canonicalCodec.normalize({
        c: Number.NaN,
        large: Number.MAX_SAFE_INTEGER + 10,
      })).toEqual({
        c: "NaN",
        large: String(Number.MAX_SAFE_INTEGER + 10),
      });
      expect(substrate.canonicalCodec.stableJson({
        z: "two\nlines",
        a: 1,
      })).toBe('{"a":1,"z":"two\\nlines"}');
      expect(substrate.canonicalCodec.hash({ b: 2, a: 1 })).toBe(substrate.canonicalCodec.hash({ a: 1, b: 2 }));
      expect(substrate.canonicalCodec.decode(substrate.canonicalCodec.encode({ x: 1 }))).toEqual({ x: 1 });
      expect(substrate.canonicalCodec.decode(substrate.canonicalCodec.encode("raw text", "raw"), "raw").toString("utf8")).toBe("raw text");

      const alpha = await substrate.cas.putBlock(Buffer.from("alpha"), {
        codec: "raw",
        metadata: { path: "docs/a.txt" },
      });
      const alphaAgain = await substrate.cas.putBlock(Buffer.from("alpha"), {
        codec: "raw",
        metadata: { path: "other" },
      });
      const object = await substrate.cas.putBlock({
        type: "object",
        refs: [alpha.cid],
      }, {
        refs: [alpha.cid],
        metadata: { kind: "object" },
      });

      expect(alpha.cid).toMatch(/^cid:sha256:/);
      expect(alpha.byteLength).toBe(5);
      expect(alphaAgain).toMatchObject({ cid: alpha.cid, deduped: true });
      expect(await substrate.cas.hasBlock(alpha.cid)).toBe(true);
      expect((await substrate.cas.getBlock(alpha.cid)).bytes.toString("utf8")).toBe("alpha");
      expect((await substrate.cas.getBlock(object.cid)).codec).toBe("pactium-canonical");
      expect(await substrate.cas.getBlock("cid:sha256:missing")).toBeNull();
      expect(await substrate.cas.listMissing(object.cid)).toEqual([]);

      const missingRoot = await substrate.cas.putBlock({ refs: ["cid:sha256:missing"] }, {
        refs: ["cid:sha256:missing"],
      });
      expect(await substrate.cas.listMissing(missingRoot.cid)).toEqual(["cid:sha256:missing"]);
      await expect(substrate.cas.walk("cid:sha256:missing")).resolves.toMatchObject({
        blockCount: 0,
        missing: ["cid:sha256:missing"],
      });
      await expect(substrate.cas.pin(object.cid, { retain: true })).resolves.toMatchObject({
        rootCid: object.cid,
        policy: { retain: true },
      });
      await expect(substrate.cas.gc()).resolves.toMatchObject({
        collected: 0,
        policy: "pactium-managed-retention",
      });
    });
  });

  it("builds manifests, indexes, events, state commits, and LSM ingest receipts", async () => {
    await withTempSubstrate(async ({ substrate }) => {
      const chunkA = await substrate.cas.putBlock(Buffer.from("alpha chunk"), {
        codec: "raw",
        metadata: { path: "docs/a.txt" },
      });
      const chunkB = await substrate.cas.putBlock(Buffer.from("beta chunk"), {
        codec: "raw",
        metadata: { path: "docs/b.txt" },
      });

      const manifest = await substrate.merkleDag.buildManifest("workspace-file-set", [
        { path: "docs/b.txt", cid: chunkB.cid, byteLength: chunkB.byteLength },
        { path: "/docs//a.txt", cid: chunkA.cid, byteLength: chunkA.byteLength },
        { path: "", cid: chunkA.cid },
      ], {
        workspaceId: "workspace-a",
      });
      expect(manifest.entries.map((entry) => entry.key)).toEqual(["docs/a.txt", "docs/b.txt"]);
      await expect(substrate.merkleDag.verify(manifest.rootCid)).resolves.toMatchObject({
        ok: true,
        blockCount: 3,
      });
      await expect(substrate.merkleDag.diff(chunkA.cid, manifest.rootCid)).resolves.toMatchObject({
        missing: [],
      });

      const emptyIndex = await substrate.merkleIndex.create("workspace-paths", []);
      const indexA = await substrate.merkleIndex.put(emptyIndex.indexRootCid, "docs/a.txt", chunkA.cid, { kind: "file" });
      const indexAB = await substrate.merkleIndex.put(indexA.indexRootCid, "/docs//b.txt", chunkB.cid);
      const indexBOnly = await substrate.merkleIndex.delete(indexAB.indexRootCid, "docs/a.txt");

      expect(await substrate.merkleIndex.get(indexAB.indexRootCid, "docs/a.txt")).toMatchObject({
        key: "docs/a.txt",
        valueRef: chunkA.cid,
      });
      expect(await substrate.merkleIndex.get(indexAB.indexRootCid, "missing")).toBeNull();
      expect((await substrate.merkleIndex.scan(indexAB.indexRootCid, { min: "docs/a", max: "docs/z", limit: 1 }))).toHaveLength(1);
      expect((await substrate.merkleIndex.prefix(indexAB.indexRootCid, "docs")).map((entry) => entry.key)).toEqual([
        "docs/a.txt",
        "docs/b.txt",
      ]);
      expect((await substrate.merkleIndex.prefix(indexAB.indexRootCid, "")).map((entry) => entry.key)).toEqual([
        "docs/a.txt",
        "docs/b.txt",
      ]);
      expect((await substrate.merkleIndex.diff(indexA.indexRootCid, indexAB.indexRootCid))).toEqual([
        expect.objectContaining({ key: "docs/b.txt", action: "create" }),
      ]);
      expect((await substrate.merkleIndex.diff(indexAB.indexRootCid, indexBOnly.indexRootCid))).toEqual([
        expect.objectContaining({ key: "docs/a.txt", action: "delete" }),
      ]);
      expect(await substrate.merkleIndex.prove(indexAB.indexRootCid, "docs/a.txt")).toMatchObject({
        exists: true,
        valueRef: chunkA.cid,
      });
      await expect(substrate.merkleIndex.get("cid:sha256:missing", "x")).rejects.toThrow("Index node missing");

      const firstEvent = await substrate.eventLog.appendEvent({
        partitionId: "workspace/a",
        operationId: "index.create",
        afterRoot: indexA.indexRootCid,
        contentRefs: [chunkA.cid],
        payload: { actor: "test" },
      });
      const secondEvent = await substrate.eventLog.appendEvent({
        partitionId: "workspace/a",
        operationId: "index.update",
        beforeRoot: indexA.indexRootCid,
        afterRoot: indexAB.indexRootCid,
        contentRefs: [chunkB.cid],
      });
      expect(secondEvent.offset).toBe(1);
      expect(secondEvent.prevEventHash).toBe(firstEvent.eventHash);
      expect(await substrate.eventLog.listEvents("workspace/a", { limit: 1 })).toEqual([
        expect.objectContaining({ eventHash: secondEvent.eventHash }),
      ]);
      await expect(substrate.eventLog.verifyPartition("workspace/a")).resolves.toMatchObject({
        ok: true,
        eventCount: 2,
      });

      const beginState = await substrate.stateCommit.begin({ scope: "workspace/commit" });
      expect(beginState.currentRoot).toBe("");
      const commit = await substrate.stateCommit.commit({
        scope: "workspace/commit",
        operationId: "workspace.file.upload",
        mutations: [
          { action: "put", key: "docs/a.txt", valueRef: manifest.rootCid, metadata: { op: "upload" } },
          { action: "delete", key: "docs/missing.txt" },
        ],
        contentRefs: [manifest.rootCid],
        payload: { actor: "unit" },
      });
      expect(commit.commitId).toMatch(/^state_commit_/);
      expect(commit.afterRoot).toBeTruthy();
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: true,
        commit: expect.objectContaining({ commitId: commit.commitId }),
      });
      await expect(substrate.stateCommit.verifyCommit("missing")).resolves.toEqual({
        ok: false,
        error: "commit_missing",
        commitId: "missing",
      });

      const session = await substrate.lsmIngest.beginUploadSession({
        scope: "workspace/a",
        files: [{ relativePath: "docs/a.txt" }],
      });
      await expect(substrate.lsmIngest.recoverSession("missing")).resolves.toBeNull();
      await expect(substrate.lsmIngest.appendChunkRecord("missing", {})).rejects.toThrow("upload session missing");
      await expect(substrate.lsmIngest.appendChunkRecord(session.uploadSessionId, {
        relativePath: "docs/a.txt",
        chunkCid: "cid:sha256:missing",
      })).rejects.toThrow("chunkCid must reference an existing CAS block");

      await substrate.lsmIngest.appendChunkRecord(session.uploadSessionId, {
        fileId: "docs/a.txt",
        relativePath: "docs/a.txt",
        chunkIndex: 1,
        offset: chunkA.byteLength,
        byteLength: chunkB.byteLength,
        chunkCid: chunkB.cid,
        chunkHash: chunkB.payloadHash,
      });
      await substrate.lsmIngest.appendChunkRecord(session.uploadSessionId, {
        fileId: "docs/a.txt",
        relativePath: "docs/a.txt",
        chunkIndex: 0,
        offset: 0,
        byteLength: chunkA.byteLength,
        chunkCid: chunkA.cid,
        chunkHash: chunkA.payloadHash,
      });

      const recovered = await substrate.lsmIngest.recoverSession(session.uploadSessionId);
      expect(recovered).toMatchObject({
        recordCount: 2,
        nextOffset: chunkA.byteLength + chunkB.byteLength,
      });
      expect(recovered.records.map((record) => record.chunkIndex)).toEqual([0, 1]);
      const segment = await substrate.lsmIngest.flushMemTable(session.uploadSessionId);
      expect(segment).toMatchObject({
        recordCount: 2,
        level: 0,
      });
      await expect(substrate.lsmIngest.flushMemTable("missing")).rejects.toThrow("upload session missing");
      const uploadManifest = await substrate.lsmIngest.materializeManifest(session.uploadSessionId);
      expect(uploadManifest.entries.map((entry) => entry.key)).toEqual([
        "docs/a.txt#000000000000",
        "docs/a.txt#000000000001",
      ]);
      const compacted = await substrate.lsmIngest.compactSegments("workspace/a");
      expect(compacted).toMatchObject({
        recordCount: 2,
        sourceSegmentIds: [segment.segmentId],
      });
      const emptyCompacted = await substrate.lsmIngest.compactSegments("missing-scope");
      expect(emptyCompacted.recordCount).toBe(0);
    });
  });

  it("rolls back state root, event, ledger, and receipt when a compound commit fails", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-merkle-state-rollback-"));
    const baseRuntime = createLicoPactiumRuntime({ userDataPath, storageBackend: "sqlite" });
    const failingRuntime = {
      ...baseRuntime,
      core: {
        ...baseRuntime.core,
        async recordOperation() {
          throw new Error("injected state evidence failure");
        }
      }
    };
    const substrate = createPactiumStateSubstrate({ userDataPath, pactiumRuntime: failingRuntime });
    try {
      await expect(substrate.stateCommit.commit({
        scope: "workspace/rollback",
        operationId: "workspace.rollback",
        mutations: [{ action: "put", key: "docs/a.txt", valueRef: "ref:a" }]
      })).rejects.toThrow("injected state evidence failure");
      await expect(substrate.stateCommit.begin({ scope: "workspace/rollback" }))
        .resolves.toMatchObject({ currentRoot: "" });
      await expect(substrate.eventLog.listEvents("workspace/rollback"))
        .resolves.toEqual([]);
      await expect(baseRuntime.core.doctor()).resolves.toMatchObject({ ledgerSize: 0 });
    } finally {
      await baseRuntime.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("serializes event, state, and LSM aggregate mutations across runtime instances", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-merkle-state-concurrent-"));
    const substrates = Array.from({ length: 16 }, () => createPactiumStateSubstrate({ userDataPath }));
    try {
      await Promise.all(Array.from({ length: 32 }, (_, index) =>
        substrates[index % substrates.length].eventLog.appendEvent({
          partitionId: "workspace/events",
          operationId: `event.${index}`,
          payload: { index }
        })
      )).catch((error) => {
        error.message = `event concurrency: ${error.message}`;
        throw error;
      });
      await expect(substrates[0].eventLog.verifyPartition("workspace/events"))
        .resolves.toMatchObject({ ok: true, eventCount: 32 });

      await Promise.all([
        substrates[0].stateCommit.commit({
          scope: "workspace/state",
          operationId: "state.a",
          mutations: [{ action: "put", key: "docs/a.txt", valueRef: "ref:a" }]
        }),
        substrates[1].stateCommit.commit({
          scope: "workspace/state",
          operationId: "state.b",
          mutations: [{ action: "put", key: "docs/b.txt", valueRef: "ref:b" }]
        })
      ]).catch((error) => {
        error.message = `state concurrency: ${error.message}`;
        throw error;
      });
      const { currentRoot } = await substrates[2].stateCommit.begin({ scope: "workspace/state" });
      await expect(substrates[2].merkleIndex.get(currentRoot, "docs/a.txt"))
        .resolves.toMatchObject({ valueRef: "ref:a" });
      await expect(substrates[2].merkleIndex.get(currentRoot, "docs/b.txt"))
        .resolves.toMatchObject({ valueRef: "ref:b" });

      const sessions = await Promise.all(substrates.map((substrate, index) =>
        substrate.lsmIngest.beginUploadSession({ scope: `workspace/${index}` })
      )).catch((error) => {
        error.message = `LSM concurrency: ${error.message}`;
        throw error;
      });
      const recovered = await Promise.all(sessions.map((session, index) =>
        substrates[(index + 1) % substrates.length].lsmIngest.recoverSession(session.uploadSessionId)
      ));
      expect(recovered.filter(Boolean)).toHaveLength(16);
    } finally {
      await Promise.allSettled(substrates.map((substrate) => substrate.close()));
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects durable state commits on non-transactional Pactium JSON storage", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-merkle-state-json-gate-"));
    const runtime = createLicoPactiumRuntime({ userDataPath, storageBackend: "json" });
    const substrate = createPactiumStateSubstrate({ userDataPath, pactiumRuntime: runtime });
    try {
      await expect(substrate.stateCommit.commit({
        scope: "workspace/json",
        mutations: [{ action: "put", key: "docs/a.txt", valueRef: "ref:a" }]
      })).rejects.toMatchObject({ code: "pactium_transactional_storage_required" });
    } finally {
      await runtime.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
