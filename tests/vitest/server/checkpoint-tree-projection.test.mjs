import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStoragePort } from "pactium";

import {
  checkpointTreeId,
  checkpointTreeSummary,
  deleteCheckpointTree,
  diffCheckpointTree,
  finishCheckpointTree,
  listCheckpointTrees,
  loadCheckpointTree,
  previewCheckpointRestore,
  queryCheckpointScope,
  restoreCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
import { createLicoPactiumRuntime } from "#meshrix/foundation/checkpoint/tree/pactium-substrate-preflight";

async function withTempUserData(testCase) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-checkpoint-tree-projection-extra-"));
  try {
    return await testCase(userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

describe("checkpoint-tree store behavior", () => {
  it("rolls back Pactium evidence when checkpoint projection persistence fails", async () => {
    await withTempUserData(async (userDataPath) => {
      const baseStorage = createStoragePort({ dataDir: userDataPath, storageBackend: "sqlite" });
      const failingStorage = {
        ...baseStorage,
        async putProtocolObject(scope, key, value) {
          if (scope === "meshrix-checkpoint-tree") {
            throw new Error("injected checkpoint projection failure");
          }
          return baseStorage.putProtocolObject(scope, key, value);
        }
      };
      const runtime = createLicoPactiumRuntime({ userDataPath, storage: failingStorage });
      const treeId = checkpointTreeId("rollback", "projection-failure");
      try {
        await expect(startCheckpointTree({
          userDataPath,
          pactiumRuntime: runtime,
          treeId,
          kind: "rollback",
          ownerId: "owner-a"
        })).rejects.toThrow("injected checkpoint projection failure");
        await expect(loadCheckpointTree({ userDataPath, pactiumRuntime: runtime, treeId }))
          .resolves.toBeNull();
        await expect(runtime.core.doctor()).resolves.toMatchObject({ ledgerSize: 0 });
      } finally {
        await runtime.close();
        await baseStorage.close();
      }
    });
  });

  it("rejects durable checkpoint mutations on Pactium JSON storage", async () => {
    await withTempUserData(async (userDataPath) => {
      const runtime = createLicoPactiumRuntime({ userDataPath, storageBackend: "json" });
      try {
        await expect(startCheckpointTree({
          userDataPath,
          pactiumRuntime: runtime,
          treeId: checkpointTreeId("json", "unsupported"),
          kind: "json",
          ownerId: "owner-a"
        })).rejects.toMatchObject({ code: "pactium_transactional_storage_required" });
      } finally {
        await runtime.close();
      }
    });
  });

  it("serializes concurrent tree read-modify-write operations without losing nodes", async () => {
    await withTempUserData(async (userDataPath) => {
      const baseRuntime = createLicoPactiumRuntime({ userDataPath, inMemory: true });
      let activeRecordOperations = 0;
      let maxActiveRecordOperations = 0;
      const pactiumRuntime = {
        ...baseRuntime,
        core: {
          ...baseRuntime.core,
          async recordOperation(input) {
            activeRecordOperations += 1;
            maxActiveRecordOperations = Math.max(maxActiveRecordOperations, activeRecordOperations);
            try {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return await baseRuntime.core.recordOperation(input);
            } finally {
              activeRecordOperations -= 1;
            }
          }
        }
      };
      const treeId = checkpointTreeId("concurrency", "shared-tree");
      try {
        await startCheckpointTree({
          userDataPath,
          pactiumRuntime,
          treeId,
          kind: "concurrency",
          ownerId: "owner-a"
        });
        maxActiveRecordOperations = 0;

        await Promise.all([
          upsertCheckpointNode({
            userDataPath,
            pactiumRuntime,
            treeId,
            nodeId: "child-a",
            parentId: "root",
            status: "running"
          }),
          upsertCheckpointNode({
            userDataPath,
            pactiumRuntime,
            treeId,
            nodeId: "child-b",
            parentId: "root",
            status: "paused"
          })
        ]);

        const tree = await loadCheckpointTree({ userDataPath, pactiumRuntime, treeId });
        expect(maxActiveRecordOperations).toBe(1);
        expect(Object.keys(tree.nodes).sort()).toEqual(["child-a", "child-b", "root"]);
        expect(tree.events.filter((event) => event.type === "checkpoint.node.upserted")).toHaveLength(2);
      } finally {
        await baseRuntime.close();
      }
    });
  });

  it("covers lifecycle, resume, reset, scope, restore and diff behavior", async () => {
    await withTempUserData(async (userDataPath) => {
      const treeId = checkpointTreeId("workflow", "alpha");
      const siblingTreeId = checkpointTreeId("workflow", "beta");

      const started = await startCheckpointTree({
        userDataPath,
        treeId,
        kind: "workflow",
        ownerId: "owner-a",
        inputHash: "hash-a",
        rootNodeId: "root task",
        rootLabel: "Seed Root",
        metadata: { source: "seed" },
        resumePolicy: { mode: "cold" }
      });

      expect(started).toMatchObject({
        treeId,
        kind: "workflow",
        ownerId: "owner-a",
        inputHash: "hash-a",
        status: "running",
        attempt: 1,
        rootNodeId: "root_task"
      });

      const resumed = await startCheckpointTree({
        userDataPath,
        treeId,
        kind: "workflow",
        ownerId: "owner-a",
        inputHash: "hash-a",
        rootNodeId: "root task",
        rootLabel: "Seed Root"
      });
      expect(resumed.attempt).toBe(2);

      let tree = await loadCheckpointTree({ userDataPath, treeId });
      expect(tree.events.at(-1)).toMatchObject({
        type: "checkpoint.tree.resumed",
        nodeId: "root_task"
      });

      const reset = await startCheckpointTree({
        userDataPath,
        treeId,
        kind: "workflow",
        ownerId: "owner-b",
        inputHash: "hash-b",
        rootNodeId: "root task",
        rootLabel: "Reset Root",
        metadata: { source: "reset" },
        resumePolicy: { mode: "resume-after-reset" }
      });
      expect(reset).toMatchObject({
        attempt: 3,
        inputHash: "hash-b",
        ownerId: "owner-b"
      });

      tree = await loadCheckpointTree({ userDataPath, treeId });
      expect(tree.events).toHaveLength(2);
      expect(tree.events[0]).toMatchObject({
        type: "checkpoint.tree.reset",
        nodeId: "root_task"
      });
      expect(tree.events[1]).toMatchObject({
        type: "checkpoint.tree.resumed",
        nodeId: "root_task"
      });
      expect(tree.metadata).toMatchObject({ source: "reset" });
      expect(tree.resumePolicy).toMatchObject({ mode: "resume-after-reset" });

      const childRunning = await upsertCheckpointNode({
        userDataPath,
        treeId,
        nodeId: "child one",
        parentId: "root task",
        label: "Child One",
        status: "not-a-real-status",
        cursor: { page: 1 },
        totals: { done: 0 },
        metadata: { kind: "child" },
        eventType: "checkpoint.node.updated"
      });
      expect(childRunning).toMatchObject({
        nodeId: "child_one",
        parentId: "root_task",
        status: "running"
      });

      const childFailed = await upsertCheckpointNode({
        userDataPath,
        treeId,
        nodeId: "child one",
        parentId: "root task",
        status: "failed",
        error: "boom",
        eventType: "checkpoint.node.failed"
      });
      expect(childFailed).toMatchObject({
        status: "failed",
        error: "boom"
      });

      tree = await loadCheckpointTree({ userDataPath, treeId });
      expect(tree.status).toBe("failed");
      expect(tree.failedAt).not.toBe("");
      expect(tree.nodes.child_one).toMatchObject({
        status: "failed",
        completedAt: expect.any(String)
      });

      const finished = await finishCheckpointTree({
        userDataPath,
        treeId,
        status: "completed",
        message: "Workflow completed.",
        metadata: { result: "ok" }
      });
      expect(finished.status).toBe("completed");

      tree = await loadCheckpointTree({ userDataPath, treeId });
      expect(tree.status).toBe("completed");
      expect(tree.completedAt).not.toBe("");
      expect(tree.metadata).toMatchObject({ source: "reset", result: "ok" });
      expect(tree.nodes.root_task.status).toBe("completed");

      await expect(upsertCheckpointNode({
        userDataPath,
        treeId,
        nodeId: "late failed node",
        parentId: "root task",
        status: "failed"
      })).rejects.toMatchObject({ code: "checkpoint_tree_terminal" });
      tree = await loadCheckpointTree({ userDataPath, treeId });
      expect(tree.nodes).not.toHaveProperty("late_failed_node");
      expect(tree.events.some((event) => event.nodeId === "late_failed_node")).toBe(false);

      const preview = await previewCheckpointRestore({
        userDataPath,
        treeId,
        nodeId: "child one",
        reason: "rollback",
        mode: "restore-marker"
      });
      expect(preview).toMatchObject({
        dryRun: true,
        applied: false,
        nodeId: "child_one",
        reason: "rollback",
        mode: "restore-marker",
        target: {
          nodeId: "child_one",
          label: "Child One",
          status: "failed"
        },
        scope: {
          affectedNodeCount: 1,
          byStatus: {
            failed: 1
          }
        }
      });

      const restored = await restoreCheckpointTree({
        userDataPath,
        treeId,
        nodeId: "child one",
        actor: "tester",
        reason: "rollback",
        mode: "restore-marker"
      });
      expect(restored).toMatchObject({
        dryRun: false,
        applied: true,
        nodeId: "child_one",
        restoreId: expect.any(String),
        markerNodeId: expect.stringMatching(/^restore:child_one:checkpoint_restore_/)
      });
      expect(restored.summary).toMatchObject({
        treeId,
        status: "completed",
        nodeCount: 3,
        byStatus: {
          completed: 2,
          failed: 1
        }
      });

      tree = await loadCheckpointTree({ userDataPath, treeId });
      expect(tree.metadata.lastRestore).toMatchObject({
        nodeId: "child_one",
        reason: "rollback",
        actor: "tester",
        mode: "restore-marker"
      });
      expect(tree.events.at(-1)).toMatchObject({
        type: "checkpoint.restored",
        nodeId: "child_one"
      });

      const scope = await queryCheckpointScope({
        userDataPath,
        treeId,
        nodeId: "child one"
      });
      expect(scope.nodeId).toBe("child_one");
      expect(scope.affectedNodeCount).toBe(2);
      expect(scope.nodes.map((node) => node.nodeId)).toEqual([
        "child_one",
        restored.markerNodeId
      ]);
      expect(scope.events.every((event) => !event.nodeId || event.nodeId === "child_one")).toBe(true);

      const summary = checkpointTreeSummary(tree);
      expect(summary).toMatchObject({
        treeId,
        kind: "workflow",
        ownerId: "owner-b",
        status: "completed",
        inputHash: "hash-b",
        nodeCount: 3,
        byStatus: {
          completed: 2,
          failed: 1
        }
      });

      const siblingStarted = await startCheckpointTree({
        userDataPath,
        treeId: siblingTreeId,
        kind: "workflow",
        ownerId: "owner-c",
        inputHash: "hash-c",
        rootLabel: "Beta Root"
      });
      expect(siblingStarted.rootNodeId).toBe("root");

      await upsertCheckpointNode({
        userDataPath,
        treeId: siblingTreeId,
        nodeId: "beta child",
        parentId: "root",
        label: "Beta Child",
        status: "paused"
      });

      const diff = await diffCheckpointTree({
        userDataPath,
        fromTreeId: treeId,
        toTreeId: siblingTreeId
      });
      expect(diff.changed).toBe(true);
      expect(diff.treeId).toBe(siblingTreeId);
      expect(diff.summary.fieldChangeCount).toBeGreaterThan(0);
      expect(diff.summary.affectedNodeDelta).toBe(-1);
      expect(diff.from.affectedNodeCount).toBe(3);
      expect(diff.to.affectedNodeCount).toBe(2);

      const siblingFinished = await finishCheckpointTree({
        userDataPath,
        treeId: siblingTreeId,
        status: "failed",
        message: "Sibling failed."
      });
      expect(siblingFinished.status).toBe("failed");

      const siblingTree = await loadCheckpointTree({ userDataPath, treeId: siblingTreeId });
      expect(siblingTree.failedAt).not.toBe("");
      expect(siblingTree.completedAt).not.toBe("");

      await deleteCheckpointTree({ userDataPath, treeId });
      await expect(loadCheckpointTree({ userDataPath, treeId })).resolves.toBeNull();
    });
  }, 30000);

  it("lists trees, tolerates invalid reads, and covers cyclic scope and error paths", async () => {
    await withTempUserData(async (userDataPath) => {
      const alphaId = checkpointTreeId("listing", "alpha");
      const betaId = checkpointTreeId("listing", "beta");
      const cycleId = checkpointTreeId("listing", "cycle");

      await startCheckpointTree({
        userDataPath,
        treeId: alphaId,
        kind: "alpha_kind",
        ownerId: "owner-a",
        inputHash: "alpha",
        rootLabel: "Alpha Root"
      });
      await startCheckpointTree({
        userDataPath,
        treeId: betaId,
        kind: "beta_kind",
        ownerId: "owner-b",
        inputHash: "beta",
        rootLabel: "Beta Root"
      });
      await upsertCheckpointNode({
        userDataPath,
        treeId: betaId,
        nodeId: "beta child",
        parentId: "root",
        label: "Beta Child",
        status: "paused",
        eventType: "checkpoint.node.updated"
      });

      const listed = await listCheckpointTrees({ userDataPath, limit: 1 });
      expect(listed).toHaveLength(1);
      expect([alphaId, betaId]).toContain(listed[0].treeId);
      expect(await listCheckpointTrees({ userDataPath, ownerId: "owner-a" })).toHaveLength(1);
      expect((await listCheckpointTrees({ userDataPath, kind: "beta_kind" }))[0].treeId).toBe(betaId);

      expect(await loadCheckpointTree({ userDataPath, treeId: "not-a-token" })).toBeNull();
      expect(await loadCheckpointTree({ userDataPath, treeId: checkpointTreeId("listing", "missing") })).toBeNull();

      await startCheckpointTree({
        userDataPath,
        treeId: cycleId,
        kind: "cycle",
        ownerId: "owner-cycle",
        rootNodeId: "root",
        rootLabel: "Root"
      });
      await upsertCheckpointNode({
        userDataPath,
        treeId: cycleId,
        nodeId: "child",
        parentId: "root",
        label: "Child",
        status: "paused",
        eventType: "checkpoint.node.visited"
      });
      await upsertCheckpointNode({
        userDataPath,
        treeId: cycleId,
        nodeId: "root",
        parentId: "child",
        label: "Root",
        status: "running"
      });

      const cycleScope = await queryCheckpointScope({
        userDataPath,
        treeId: cycleId,
        nodeId: "root"
      });
      expect(cycleScope.affectedNodeCount).toBe(2);
      expect(cycleScope.nodes.map((node) => node.nodeId)).toEqual(["root", "child"]);
      expect(cycleScope.path.map((step) => step.nodeId)).toEqual(["child", "root"]);

      await expect(queryCheckpointScope({
        userDataPath,
        treeId: cycleId,
        nodeId: "missing"
      })).rejects.toThrow("checkpoint node is missing");

      await expect(diffCheckpointTree({
        userDataPath,
        fromTreeId: checkpointTreeId("listing", "absent"),
        toTreeId: betaId
      })).rejects.toThrow("checkpoint tree is missing");

      await expect(diffCheckpointTree({
        userDataPath,
        treeId: betaId,
        fromNodeId: "missing"
      })).rejects.toThrow("checkpoint diff node is missing");

      const betaFinished = await finishCheckpointTree({
        userDataPath,
        treeId: betaId,
        status: "failed",
        message: "Sibling failed."
      });
      expect(betaFinished.status).toBe("failed");

      const betaTree = await loadCheckpointTree({ userDataPath, treeId: betaId });
      expect(betaTree.failedAt).not.toBe("");
      expect(betaTree.completedAt).not.toBe("");

      await expect(restoreCheckpointTree({
        userDataPath,
        treeId: checkpointTreeId("listing", "restore-missing"),
        nodeId: "root"
      })).rejects.toThrow("checkpoint tree is missing");
    });
  }, 30000);
});
