import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDataStructureSubstrate } from "#lico/foundation/checkpoint/tree/data-structure-substrate";

const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-merkle-state-"));

try {
  const provider = createDataStructureSubstrate({ userDataPath });
  const substrate = provider.merkleStateSubstrate;
  assert.ok(substrate, "merkleStateSubstrate should be registered");
  assert.equal(provider.provider, "pactium");
  assert.equal(substrate.protocolVersion, provider.providerProtocolVersion);

  const canonicalA = substrate.canonicalCodec.hash({
    b: "two\nlines",
    a: 1,
    nested: { z: true, y: ["k"] }
  });
  const canonicalB = substrate.canonicalCodec.hash({
    nested: { y: ["k"], z: true },
    a: 1,
    b: "two\nlines"
  });
  assert.equal(canonicalA, canonicalB, "canonical hash must ignore object order");

  const chunkA = await substrate.cas.putBlock(Buffer.from("alpha chunk"), {
    codec: "raw",
    metadata: { path: "docs/a.txt" }
  });
  const chunkADedup = await substrate.cas.putBlock(Buffer.from("alpha chunk"), {
    codec: "raw",
    metadata: { path: "other/path.txt" }
  });
  const chunkB = await substrate.cas.putBlock(Buffer.from("beta chunk"), {
    codec: "raw",
    metadata: { path: "docs/b.txt" }
  });
  assert.equal(chunkA.cid, chunkADedup.cid, "same bytes should dedupe to the same cid");
  assert.equal(chunkADedup.deduped, true);
  assert.equal((await substrate.cas.getBlock(chunkA.cid)).bytes.toString("utf8"), "alpha chunk");

  const manifest = await substrate.merkleDag.buildManifest("workspace-file-set", [
    { path: "docs/a.txt", cid: chunkA.cid, byteLength: chunkA.byteLength },
    { path: "docs/b.txt", cid: chunkB.cid, byteLength: chunkB.byteLength }
  ], {
    workspaceId: "verify-workspace"
  });
  assert.equal(manifest.refs.length, 2);
  const verifiedManifest = await substrate.merkleDag.verify(manifest.rootCid);
  assert.equal(verifiedManifest.ok, true, "manifest refs should be fully present");

  const missingManifest = await substrate.cas.putBlock({
    type: "fixture.missing-ref",
    refs: ["cid:sha256:0000000000000000000000000000000000000000000000000000000000000000"]
  }, {
    codec: "dag-json",
    refs: ["cid:sha256:0000000000000000000000000000000000000000000000000000000000000000"]
  });
  const missingRefs = await substrate.cas.listMissing(missingManifest.cid);
  assert.deepEqual(missingRefs, ["cid:sha256:0000000000000000000000000000000000000000000000000000000000000000"]);

  const emptyIndex = await substrate.merkleIndex.create("workspace-paths", []);
  const indexWithA = await substrate.merkleIndex.put(emptyIndex.indexRootCid, "docs/a.txt", chunkA.cid);
  const indexWithAB = await substrate.merkleIndex.put(indexWithA.indexRootCid, "docs/b.txt", chunkB.cid);
  assert.equal((await substrate.merkleIndex.get(indexWithAB.indexRootCid, "docs/a.txt")).valueRef, chunkA.cid);
  assert.deepEqual((await substrate.merkleIndex.prefix(indexWithAB.indexRootCid, "docs")).map((item) => item.key), ["docs/a.txt", "docs/b.txt"]);
  assert.equal((await substrate.merkleIndex.prove(indexWithAB.indexRootCid, "missing.txt")).exists, false);
  assert.deepEqual((await substrate.merkleIndex.diff(indexWithA.indexRootCid, indexWithAB.indexRootCid)).map((item) => item.action), ["create"]);

  const session = await substrate.lsmIngest.beginUploadSession({
    scope: "workspace:verify",
    files: [{ relativePath: "docs/a.txt" }]
  });
  await substrate.lsmIngest.appendChunkRecord(session.uploadSessionId, {
    fileId: "docs/a.txt",
    relativePath: "docs/a.txt",
    chunkIndex: 0,
    offset: 0,
    byteLength: chunkA.byteLength,
    chunkCid: chunkA.cid,
    chunkHash: chunkA.payloadHash
  });
  await substrate.lsmIngest.appendChunkRecord(session.uploadSessionId, {
    fileId: "docs/a.txt",
    relativePath: "docs/a.txt",
    chunkIndex: 1,
    offset: chunkA.byteLength,
    byteLength: chunkB.byteLength,
    chunkCid: chunkB.cid,
    chunkHash: chunkB.payloadHash
  });
  const recovered = await substrate.lsmIngest.recoverSession(session.uploadSessionId);
  assert.equal(recovered.recordCount, 2, "LSM ingest recovery should replay WAL chunk records");
  const segment = await substrate.lsmIngest.flushMemTable(session.uploadSessionId);
  assert.equal(segment.recordCount, 2);
  assert.ok(segment.rootCid);
  const uploadManifest = await substrate.lsmIngest.materializeManifest(session.uploadSessionId);
  const compacted = await substrate.lsmIngest.compactSegments("workspace:verify");
  assert.equal(compacted.recordCount, 2);
  assert.equal((await substrate.merkleDag.verify(uploadManifest.rootCid)).ok, true);

  const commit = await substrate.stateCommit.commit({
    scope: "workspace:verify",
    operationId: "workspace.file.upload",
    mutations: [
      { action: "put", key: "docs/a.txt", valueRef: uploadManifest.rootCid, metadata: { operation: "upload" } }
    ],
    contentRefs: [uploadManifest.rootCid, chunkA.cid, chunkB.cid],
    payload: { actor: "verify", path: "docs/a.txt" }
  });
  assert.equal(commit.beforeRoot, "");
  assert.ok(commit.afterRoot);
  assert.ok(commit.eventHash.startsWith("sha256:"));
  assert.equal(commit.contentRefs.includes(uploadManifest.rootCid), true);
  const commitVerification = await substrate.stateCommit.verifyCommit(commit.commitId);
  assert.equal(commitVerification.ok, true, "state commit should verify event hash chain and index root");
  const partitionVerification = await substrate.eventLog.verifyPartition("workspace:verify");
  assert.equal(partitionVerification.ok, true);
  assert.equal(partitionVerification.eventCount, 1);

  const capabilities = provider.listCapabilities().capabilities.map((capability) => capability.id);
  assert.equal(capabilities.includes("merkle-state-substrate"), true);

  console.log("merkle state substrate verification passed");
} finally {
  await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
}
