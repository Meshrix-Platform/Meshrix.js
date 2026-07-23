#!/usr/bin/env node
/**
 * Checkpoint Tree — substrate-backed unit tests.
 *
 * Proves projection import lands trees in the Pactium checkpoint projection
 * with substrate proof references, and that no local Merkle authority remains.
 *
 * Run: node tests/unit/foundation/checkpoint-tree.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  checkpointTreeId,
  createDataStructureSubstrate,
  importCheckpointTreeProjection,
  exportCheckpointTreeProjection,
  loadCheckpointTree
} from "../../../packages/foundation/src/checkpoint/tree/index.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function* walkMjs(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "build", "node_modules", "tmp"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkMjs(full);
      continue;
    }
    if (entry.isFile() && full.endsWith(".mjs")) yield full;
  }
}

async function assertNoLocalCheckpointMerkleAuthority() {
  const foundationRoot = path.join(repoRoot, "packages/foundation");
  const offenders = [];
  for await (const filePath of walkMjs(foundationRoot)) {
    const relative = path.relative(repoRoot, filePath).replace(/\\/g, "/");
    if (relative.includes("/checkpoint/tree/merkle-state-substrate")) continue;
    if (relative.includes("/checkpoint/tree/pactium-")) continue;
    const source = await fs.readFile(filePath, "utf8");
    if (
      source.includes("computeMerkleRoot") ||
      source.includes("computeMerkleTree") ||
      source.includes("createCheckpointTree(") ||
      relative.endsWith("checkpoint/tree/merkle-summary.mjs") ||
      relative.includes("checkpoint/tree/event-log/")
    ) {
      offenders.push(relative);
    }
  }
  assert.deepEqual(offenders, [], "foundation must not compute checkpoint Merkle roots outside Pactium facade");
}

async function withTempDir(run) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "lico-checkpoint-tree-unit-"));
  try {
    return await run(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await assertNoLocalCheckpointMerkleAuthority();

  await withTempDir(async (userDataPath) => {
    const substrate = createDataStructureSubstrate({ userDataPath });
    try {
      assert.equal(substrate.provider, "pactium");
      assert.ok(substrate.checkpointTreeProjection);

      const treeId = checkpointTreeId("unit-import", createHash("sha256").update("unit").digest("hex").slice(0, 16));
      const importResult = await importCheckpointTreeProjection({
        userDataPath,
        treeId,
        records: [
          {
            nodeId: "child-a",
            parentId: "root",
            label: "Child A",
            status: "completed",
            objectRefs: ["cid:sha256:aaa", "cid:sha256:bbb"],
            actor: "unit-test"
          },
          {
            nodeId: "child-b",
            parentId: "root",
            label: "Child B",
            status: "completed",
            objectRefs: ["cid:sha256:ccc"],
            actor: "unit-test"
          }
        ],
        metadata: { suite: "checkpoint-tree-unit" },
        pactiumRuntime: substrate.pactiumRuntime
      });

      assert.equal(importResult.imported >= 2, true, "imported child nodes");
      assert.equal(importResult.errors.length, 0, "no import errors");
      assert.ok(importResult.proofRefs.length > 0, "substrate proof refs present");
      assert.ok(
        importResult.proofRefs.every((proof) => proof.ledgerEventId || proof.envelopeId),
        "proof refs carry ledger or envelope ids"
      );

      const loaded = await loadCheckpointTree({
        userDataPath,
        treeId,
        pactiumRuntime: substrate.pactiumRuntime
      });
      assert.ok(loaded, "tree loaded from Pactium projection");
      assert.ok(loaded.nodes["child-a"], "child-a present");
      assert.ok(loaded.nodes["child-b"], "child-b present");
      assert.deepEqual(
        loaded.nodes["child-a"].metadata?.importedObjectRefs,
        ["cid:sha256:aaa", "cid:sha256:bbb"]
      );

      const exported = await exportCheckpointTreeProjection({
        userDataPath,
        treeId,
        pactiumRuntime: substrate.pactiumRuntime
      });
      assert.ok(exported.tree);
      assert.equal(exported.records.length >= 2, true);
      assert.ok(exported.proofRefs.length > 0);

      const resetImport = await importCheckpointTreeProjection({
        userDataPath,
        treeId,
        records: [
          {
            nodeId: "child-c",
            parentId: "root",
            label: "Child C",
            status: "completed",
            objectRefs: ["cid:sha256:ddd"]
          }
        ],
        metadata: { suite: "checkpoint-tree-unit-reset" },
        pactiumRuntime: substrate.pactiumRuntime,
        resumePolicy: { mode: "reset" }
      });
      assert.equal(resetImport.errors.length, 0, "reset import has no errors");
      assert.ok(resetImport.proofRefs.length > 0, "reset import keeps substrate proof refs");
    } finally {
      await substrate.close();
    }
  });

  console.log("checkpoint tree substrate unit verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
