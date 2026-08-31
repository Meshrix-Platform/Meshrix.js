import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PACTIUM_PROTOCOL, protocolHash } from "pactium";
import { describe, expect, it } from "vitest";
import {
  createPactiumStateSubstrate,
} from "#meshrix/foundation/checkpoint/tree/merkle-state-substrate";
import { createMeshrixPactiumRuntime } from "#meshrix/foundation/checkpoint/tree/pactium-runtime";

async function withTempSubstrate(testCase?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-merkle-state-vitest-"));
  const substrate: any = createPactiumStateSubstrate({ userDataPath });
  try {
    return await testCase({ userDataPath, substrate });
  } finally {
    await substrate.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

describe("merkle state substrate", () : any => {
  it("normalizes canonical data and stores raw/dag-json CAS blocks", async () : Promise<any> => {
    await withTempSubstrate(async ({ substrate }: Record<string, any>) : Promise<any> => {
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

      const alpha: any = await substrate.cas.putBlock(Buffer.from("alpha"), {
        codec: "raw",
        metadata: { path: "docs/a.txt" },
      });
      const alphaAgain: any = await substrate.cas.putBlock(Buffer.from("alpha"), {
        codec: "raw",
        metadata: { path: "other" },
      });
      const object: any = await substrate.cas.putBlock({
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

      const missingRoot: any = await substrate.cas.putBlock({ refs: ["cid:sha256:missing"] }, {
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

  it("builds manifests, indexes, events, state commits, and LSM ingest receipts", async () : Promise<any> => {
    await withTempSubstrate(async ({ substrate }: Record<string, any>) : Promise<any> => {
      const chunkA: any = await substrate.cas.putBlock(Buffer.from("alpha chunk"), {
        codec: "raw",
        metadata: { path: "docs/a.txt" },
      });
      const chunkB: any = await substrate.cas.putBlock(Buffer.from("beta chunk"), {
        codec: "raw",
        metadata: { path: "docs/b.txt" },
      });

      const manifest: any = await substrate.merkleDag.buildManifest("workspace-file-set", [
        { path: "docs/b.txt", cid: chunkB.cid, byteLength: chunkB.byteLength },
        { path: "/docs//a.txt", cid: chunkA.cid, byteLength: chunkA.byteLength },
        { path: "", cid: chunkA.cid },
      ], {
        workspaceId: "workspace-a",
      });
      expect(manifest.entries.map((entry?: any) : any => entry.key)).toEqual(["docs/a.txt", "docs/b.txt"]);
      await expect(substrate.merkleDag.verify(manifest.rootCid)).resolves.toMatchObject({
        ok: true,
        blockCount: 3,
      });
      await expect(substrate.merkleDag.diff(chunkA.cid, manifest.rootCid)).resolves.toMatchObject({
        missing: [],
      });

      const emptyIndex: any = await substrate.merkleIndex.create("workspace-paths", []);
      const indexA: any = await substrate.merkleIndex.put(emptyIndex.indexRootCid, "docs/a.txt", chunkA.cid, { kind: "file" });
      const indexAB: any = await substrate.merkleIndex.put(indexA.indexRootCid, "/docs//b.txt", chunkB.cid);
      const indexBOnly: any = await substrate.merkleIndex.delete(indexAB.indexRootCid, "docs/a.txt");

      expect(await substrate.merkleIndex.get(indexAB.indexRootCid, "docs/a.txt")).toMatchObject({
        key: "docs/a.txt",
        valueRef: chunkA.cid,
      });
      expect(await substrate.merkleIndex.get(indexAB.indexRootCid, "missing")).toBeNull();
      expect((await substrate.merkleIndex.scan(indexAB.indexRootCid, { min: "docs/a", max: "docs/z", limit: 1 }))).toHaveLength(1);
      expect((await substrate.merkleIndex.prefix(indexAB.indexRootCid, "docs")).map((entry?: any) : any => entry.key)).toEqual([
        "docs/a.txt",
        "docs/b.txt",
      ]);
      expect((await substrate.merkleIndex.prefix(indexAB.indexRootCid, "")).map((entry?: any) : any => entry.key)).toEqual([
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

      const firstEvent: any = await substrate.eventLog.appendEvent({
        partitionId: "workspace/a",
        operationId: "index.create",
        afterRoot: indexA.indexRootCid,
        contentRefs: [chunkA.cid],
        payload: { actor: "test" },
      });
      const secondEvent: any = await substrate.eventLog.appendEvent({
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

      const beginState: any = await substrate.stateCommit.begin({ scope: "workspace/commit" });
      expect(beginState.currentRoot).toBe("");
      const commit: any = await substrate.stateCommit.commit({
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

      const idempotentInput: Record<string, any> = {
        scope: "workspace/idempotent",
        operationId: "workspace.file.materialize",
        expectedCurrentRoot: "",
        idempotencyKey: "publication-proof-a",
        mutations: [
          {
            action: "put",
            key: "docs/a.txt",
            valueRef: manifest.rootCid,
            metadata: { op: "materialize" },
          },
        ],
        contentRefs: [manifest.rootCid],
        payload: { publicationProofDigest: "proof-a" },
      };
      const idempotentCommit: any = await substrate.stateCommit.commit(idempotentInput);
      const idempotentReplay: any = await substrate.stateCommit.commit(idempotentInput);
      expect(idempotentReplay).toMatchObject({
        commitId: idempotentCommit.commitId,
        eventHash: idempotentCommit.eventHash,
        replayed: true,
      });
      expect(
        await substrate.eventLog.listEvents("workspace/idempotent", {
          limit: 10,
        }),
      ).toHaveLength(1);
      const idempotentEvent: any = await substrate.eventLog.getEvent(
        "workspace/idempotent",
        0,
      );
      expect(idempotentEvent).toMatchObject({
        eventHash: idempotentCommit.eventHash,
        operationId: idempotentCommit.operationId,
      });
      await expect(substrate.stateCommit.getCommitByEventHash({
        scope: "workspace/idempotent",
        eventHash: idempotentEvent.eventHash,
      })).resolves.toMatchObject({
        commitId: idempotentCommit.commitId,
      });
      await expect(substrate.stateCommit.commit({
        ...idempotentInput,
        payload: { publicationProofDigest: "proof-b" },
      })).rejects.toMatchObject({
        code: "state_mutation_idempotency_conflict",
      });

      await expect(substrate.uploadManifest.materialize({
        scope: "workspace/a",
        records: [{ relativePath: "docs/a.txt", chunkCid: "cid:sha256:missing" }]
      })).rejects.toThrow("chunkCid must reference an existing CAS block");

      const uploadManifest: any = await substrate.uploadManifest.materialize({
        scope: "workspace/a",
        files: [{ relativePath: "docs/a.txt" }],
        records: [{
          fileId: "docs/a.txt",
          relativePath: "docs/a.txt",
          chunkIndex: 1,
          offset: chunkA.byteLength,
          byteLength: chunkB.byteLength,
          chunkCid: chunkB.cid,
          chunkHash: chunkB.payloadHash,
        }, {
          fileId: "docs/a.txt",
          relativePath: "docs/a.txt",
          chunkIndex: 0,
          offset: 0,
          byteLength: chunkA.byteLength,
          chunkCid: chunkA.cid,
          chunkHash: chunkA.payloadHash,
        }]
      });
      expect(uploadManifest.entries.map((entry?: any) : any => entry.key)).toEqual([
        "docs/a.txt#000000000000",
        "docs/a.txt#000000000001",
      ]);
      expect(uploadManifest).toMatchObject({
        recordCount: 2,
        nextOffset: chunkA.byteLength + chunkB.byteLength,
      });
    });
  });

  it("rolls back state root, event, ledger, and receipt when a compound commit fails", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-merkle-state-rollback-"));
    const baseRuntime: any = createMeshrixPactiumRuntime({ userDataPath, storageBackend: "sqlite" });
    const failingRuntime: Record<string, any> = {
      ...baseRuntime,
      core: {
        ...baseRuntime.core,
        async recordOperation() : Promise<any> {
          throw new Error("injected state evidence failure");
        }
      }
    };
    const substrate: any = createPactiumStateSubstrate({ userDataPath, pactiumRuntime: failingRuntime });
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

  it("rejects weak or tampered state commit records, event chains, and Pactium bindings", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-merkle-state-integrity-"));
    const runtime: any = createMeshrixPactiumRuntime({ userDataPath, storageBackend: "sqlite" });
    const substrate: any = createPactiumStateSubstrate({ userDataPath, pactiumRuntime: runtime });
    const scope: any = "workspace/integrity";
    async function store(scopeName: string, key: string, value: unknown) : Promise<any> {
      await runtime.core.withMutationTransaction(() : any =>
        runtime.storage.putProtocolObject(scopeName, key, value));
      runtime.storage.clearCache?.();
    }
    try {
      const commit: any = await substrate.stateCommit.commit({
        scope,
        operationId: "workspace.integrity.first",
        mutations: [
          { action: "put", key: "docs/a.txt", valueRef: "ref:a" },
          { action: "put", key: "docs/empty", valueRef: "", metadata: { type: "directory" } },
        ],
      });
      await substrate.stateCommit.commit({
        scope,
        operationId: "workspace.integrity.second",
        mutations: [{ action: "put", key: "docs/b.txt", valueRef: "ref:b" }],
      });
      expect(commit).toMatchObject({
        commitKind: "mutation",
        eventOffset: 0,
        mutations: expect.arrayContaining([
          expect.objectContaining({
            key: "docs/empty",
            valueRef: "meshrix:value-ref:none",
          }),
        ]),
        pactium: {
          envelopeId: expect.stringMatching(/^proof_envelope_/u),
          intentId: expect.stringMatching(/^operation_intent_/u),
          outcomeId: expect.stringMatching(/^operation_outcome_/u),
          ledgerEventId: expect.stringMatching(/^ledger_event_/u),
          ledgerIndex: expect.any(Number),
        },
      });
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({ ok: true });

      const weakRecord: any = structuredClone(commit);
      delete weakRecord.commitKind;
      await store("meshrix-state-commit", commit.commitId, weakRecord);
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: false,
        error: "commit_malformed",
      });

      const replayTampered: any = structuredClone(commit);
      replayTampered.mutations[0] = {
        ...replayTampered.mutations[0],
        valueRef: "ref:tampered",
        valueHash: protocolHash("meshrix.value", { valueRef: "ref:tampered" }),
      };
      await store("meshrix-state-commit", commit.commitId, replayTampered);
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: false,
        error: "state_commit_replay_mismatch",
      });

      const proofTampered: any = structuredClone(commit);
      proofTampered.mutations.push({
        action: "delete",
        key: "docs/missing.txt",
        valueRef: "",
        valueHash: "",
        metadata: {},
      });
      proofTampered.mutations.sort((left: any, right: any) : any => left.key.localeCompare(right.key));
      await store("meshrix-state-commit", commit.commitId, proofTampered);
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: false,
        error: "state_commit_pactium_state_mismatch",
      });

      await store("meshrix-state-commit", commit.commitId, {
        ...commit,
        eventHash: protocolHash("meshrix.state-event", { tampered: true }),
      });
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: false,
        error: "state_commit_event_mismatch",
      });

      await store("meshrix-state-commit", commit.commitId, {
        ...commit,
        pactium: { ...commit.pactium, outcomeId: "operation_outcome_tampered" },
      });
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: false,
        error: "state_commit_pactium_ledger_mismatch",
      });

      await store("meshrix-state-commit", commit.commitId, commit);
      const segmentKey: any = `event-log-segment:${scope}:0`;
      const originalSegment: any = await runtime.storage.getProtocolObject(
        "meshrix-event-log",
        segmentKey,
        [],
      );
      const brokenSegment: any = structuredClone(originalSegment);
      brokenSegment[1].prevEventHash = protocolHash("meshrix.state-event", { broken: true });
      brokenSegment[1].eventHash = protocolHash("meshrix.state-event", {
        ...brokenSegment[1],
        eventHash: undefined,
      });
      await store("meshrix-event-log", segmentKey, brokenSegment);
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({
        ok: false,
        error: "state_commit_event_chain_invalid",
      });

      await store("meshrix-event-log", segmentKey, originalSegment);
      await expect(substrate.stateCommit.verifyCommit(commit.commitId)).resolves.toMatchObject({ ok: true });

      const restored: any = await substrate.stateCommit.restoreRoot({
        scope,
        operationId: "workspace.integrity.restore",
        targetRoot: commit.afterRoot,
        anchor: { offset: commit.eventOffset, eventHash: commit.eventHash },
        allowedOperationIds: ["workspace.integrity.second"],
        payload: { actor: "integrity-test" },
      });
      expect(restored).toMatchObject({ commitKind: "restore", mutations: [] });
      await expect(substrate.stateCommit.verifyCommit(restored.commitId)).resolves.toMatchObject({ ok: true });
    } finally {
      await runtime.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("serializes event, state, and LSM aggregate mutations across runtime instances", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-merkle-state-concurrent-"));
    const substrates: any = Array.from({ length: 16 }, () : any => createPactiumStateSubstrate({ userDataPath }));
    try {
      await Promise.all(Array.from({ length: 32 }, (_?: any, index?: any) : any =>
        substrates[index % substrates.length].eventLog.appendEvent({
          partitionId: "workspace/events",
          operationId: `event.${index}`,
          payload: { index }
        })
      )).catch((error?: any) : any => {
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
      ]).catch((error?: any) : any => {
        error.message = `state concurrency: ${error.message}`;
        throw error;
      });
      const { currentRoot } = await substrates[2].stateCommit.begin({ scope: "workspace/state" });
      await expect(substrates[2].merkleIndex.get(currentRoot, "docs/a.txt"))
        .resolves.toMatchObject({ valueRef: "ref:a" });
      await expect(substrates[2].merkleIndex.get(currentRoot, "docs/b.txt"))
        .resolves.toMatchObject({ valueRef: "ref:b" });

      const manifests: any = await Promise.all(substrates.map((substrate?: any, index?: any) : any =>
        substrate.uploadManifest.materialize({ scope: `workspace/${index}`, records: [] })
      )).catch((error?: any) : any => {
        error.message = `upload manifest concurrency: ${error.message}`;
        throw error;
      });
      expect(manifests.filter((manifest?: any) : any => manifest.rootCid)).toHaveLength(16);
    } finally {
      await Promise.allSettled(substrates.map((substrate?: any) : any => substrate.close()));
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects durable state commits on non-transactional Pactium JSON storage", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-merkle-state-json-gate-"));
    const runtime: any = createMeshrixPactiumRuntime({ userDataPath, storageBackend: "json" });
    const substrate: any = createPactiumStateSubstrate({ userDataPath, pactiumRuntime: runtime });
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
