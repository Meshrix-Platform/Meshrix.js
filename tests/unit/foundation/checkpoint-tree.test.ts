#!/usr/bin/env node
/**
 * Checkpoint Tree — substrate-backed unit tests.
 *
 * Proves projection import lands trees in the Pactium checkpoint projection
 * with substrate proof references, and that no local Merkle authority remains.
 *
 * Run: node tests/unit/foundation/checkpoint-tree.test.ts
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
} from "../../../packages/foundation/src/checkpoint/tree/index.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function* walkMjs(directory?: any) : AsyncGenerator<any, any, any> {
  const entries: any = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "build", "node_modules", "tmp"].includes(entry.name)) continue;
    const full: any = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkMjs(full);
      continue;
    }
    if (entry.isFile() && full.endsWith(".ts")) yield full;
  }
}

async function assertNoLocalCheckpointMerkleAuthority() : Promise<any> {
  const foundationRoot: any = path.join(repoRoot, "packages/foundation");
  const offenders: any[] = [];
  for await (const filePath of walkMjs(foundationRoot)) {
    const relative: any = path.relative(repoRoot, filePath).replace(/\\/g, "/");
    if (relative.includes("/checkpoint/tree/merkle-state-substrate")) continue;
    if (relative.includes("/checkpoint/tree/pactium-")) continue;
    const source: any = await fs.readFile(filePath, "utf8");
    if (
      source.includes("computeMerkleRoot") ||
      source.includes("computeMerkleTree") ||
      source.includes("createCheckpointTree(") ||
      relative.endsWith("checkpoint/tree/merkle-summary.ts") ||
      relative.includes("checkpoint/tree/event-log/")
    ) {
      offenders.push(relative);
    }
  }
  assert.deepEqual(offenders, [], "foundation must not compute checkpoint Merkle roots outside Pactium facade");
}

async function withTempDir(run?: any) : Promise<any> {
  const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-checkpoint-tree-unit-"));
  try {
    return await run(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});
  }
}

async function main() : Promise<any> {
  await assertNoLocalCheckpointMerkleAuthority();

  await withTempDir(async (userDataPath?: any) : Promise<any> => {
    const substrate: any = createDataStructureSubstrate({ userDataPath });
    try {
      assert.equal(substrate.provider, "pactium");
      assert.ok(substrate.checkpointTreeProjection);

      const treeId: any = checkpointTreeId("unit-import", createHash("sha256").update("unit").digest("hex").slice(0, 16));
      const importResult: any = await importCheckpointTreeProjection({
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
        importResult.proofRefs.every((proof?: any) : any => proof.ledgerEventId || proof.envelopeId),
        "proof refs carry ledger or envelope ids"
      );

      const loaded: any = await loadCheckpointTree({
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

      const exported: any = await exportCheckpointTreeProjection({
        userDataPath,
        treeId,
        pactiumRuntime: substrate.pactiumRuntime
      });
      assert.ok(exported.tree);
      assert.equal(exported.records.length >= 2, true);
      assert.ok(exported.proofRefs.length > 0);

      const resetImport: any = await importCheckpointTreeProjection({
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

      // Owned-runtime export/import must release their storage lifecycle
      // lease so a later restore quiescence check passes in this process.
      const ownedExport: any = await exportCheckpointTreeProjection({ userDataPath, treeId });
      assert.ok(ownedExport.tree, "owned-runtime export succeeds");
      const ownedImport: any = await importCheckpointTreeProjection({
        userDataPath,
        treeId: checkpointTreeId("unit-import-owned", createHash("sha256").update("unit-owned").digest("hex").slice(0, 16)),
        records: [
          { nodeId: "owned-child", parentId: "root", label: "Owned child", status: "completed" }
        ]
      });
      assert.equal(ownedImport.imported >= 1, true, "owned-runtime import succeeds");
    } finally {
      await substrate.close();
    }
  });

  console.log("checkpoint tree substrate unit verification passed");
}

main().catch((error?: any) : any => {
  console.error(error);
  process.exitCode = 1;
});
