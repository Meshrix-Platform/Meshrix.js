import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.mjs";
import { stableId } from "../../../packages/agents/src/agent-workspace/agent-workspace-support.mjs";
import { createDataStructureSubstrate } from "../../../packages/foundation/src/checkpoint/tree/data-structure-substrate.mjs";

describe("agent workspace target-bounded preimage", () => {
  it("restores overwrite and create mutations to the canonical Merkle revision", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-target-preimage-"));
    const substrate = createDataStructureSubstrate({ userDataPath });
    const workspaceRuntime = createAgentWorkspace({
      userDataPath,
      defaultCanAccessAll: true,
      merkleState: substrate.merkleStateSubstrate,
      checkpointTreeApi: substrate.checkpointTreeProjection
    });
    try {
      const workspace = workspaceRuntime.createWorkspace({ title: "Target preimage" }).workspace;
      const workspacePath = path.join(userDataPath, "agent-workspaces", "folders", stableId("workspace-folder", workspace.workspaceId));
      const seed = await workspaceRuntime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "existing.txt",
        fileName: "existing.txt",
        contentBase64: Buffer.from("before", "utf8").toString("base64"),
        overwrite: true
      });
      expect(seed.ok).toBe(true);
      const before = await workspaceRuntime.workspaceFileRevision({ workspaceId: workspace.workspaceId });
      const captured = await workspaceRuntime.captureWorkspaceFileSnapshot({
        workspaceId: workspace.workspaceId,
        paths: ["existing.txt", "created.txt"]
      });
      expect(captured).toMatchObject({ ok: true, snapshot: { deleteExtraneous: false } });
      expect(captured.snapshot.files.map((entry) => [entry.relativePath, entry.exists])).toEqual([
        ["existing.txt", true],
        ["created.txt", false]
      ]);
      for (const [targetPath, content] of [["existing.txt", "after"], ["created.txt", "created"]]) {
        const changed = await workspaceRuntime.uploadWorkspaceFile({
          workspaceId: workspace.workspaceId,
          path: targetPath,
          fileName: targetPath,
          contentBase64: Buffer.from(content, "utf8").toString("base64"),
          overwrite: true,
          operationId: "jobs.upload_workspace_materialize:fixture"
        });
        expect(changed.ok).toBe(true);
      }
      const restored = await workspaceRuntime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot: captured.snapshot,
        operationId: "jobs.upload_workspace_materialize:fixture.rollback",
        stateRootAllowedOperationIds: ["jobs.upload_workspace_materialize:fixture"]
      });
      expect(restored.ok).toBe(true);
      const existing = await workspaceRuntime.downloadWorkspaceFile({ workspaceId: workspace.workspaceId, path: "existing.txt" });
      expect(Buffer.from(existing.contentBase64, "base64").toString("utf8")).toBe("before");
      expect(await workspaceRuntime.workspaceFileMetadata({ workspaceId: workspace.workspaceId, path: "created.txt" })).toMatchObject({ ok: true, exists: false });
      expect(await workspaceRuntime.workspaceFileRevision({ workspaceId: workspace.workspaceId })).toMatchObject({ ok: true, revision: before.revision });

      await workspaceRuntime.uploadWorkspaceFile({ workspaceId: workspace.workspaceId, path: "existing.txt", fileName: "existing.txt", contentBase64: Buffer.from("after-again").toString("base64"), overwrite: true, operationId: "jobs.upload_workspace_materialize:fixture" });
      await fs.writeFile(path.join(workspacePath, "existing.txt"), "before", "utf8");
      const noopRecovery = await workspaceRuntime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot: captured.snapshot,
        operationId: "jobs.upload_workspace_materialize:fixture.recovery",
        stateRootAllowedOperationIds: ["jobs.upload_workspace_materialize:fixture"]
      });
      expect(noopRecovery).toMatchObject({ ok: true, summary: { applied: 0 } });
      expect(await workspaceRuntime.workspaceFileRevision({ workspaceId: workspace.workspaceId })).toMatchObject({ revision: before.revision });

      await workspaceRuntime.uploadWorkspaceFile({ workspaceId: workspace.workspaceId, path: "existing.txt", fileName: "existing.txt", contentBase64: Buffer.from("materialized").toString("base64"), overwrite: true, operationId: "jobs.upload_workspace_materialize:fixture" });
      await workspaceRuntime.uploadWorkspaceFile({ workspaceId: workspace.workspaceId, path: "unrelated.txt", fileName: "unrelated.txt", contentBase64: Buffer.from("unrelated").toString("base64"), overwrite: true, operationId: "workspace.file.unrelated" });
      const rootBeforeConflict = await workspaceRuntime.workspaceFileRevision({ workspaceId: workspace.workspaceId });
      expect(await workspaceRuntime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot: captured.snapshot,
        operationId: "jobs.upload_workspace_materialize:fixture.rollback",
        stateRootAllowedOperationIds: ["jobs.upload_workspace_materialize:fixture"]
      })).toMatchObject({ ok: false, status: 409 });
      expect((await workspaceRuntime.downloadWorkspaceFile({ workspaceId: workspace.workspaceId, path: "existing.txt" })).content).toBe("materialized");
      expect((await workspaceRuntime.downloadWorkspaceFile({ workspaceId: workspace.workspaceId, path: "unrelated.txt" })).content).toBe("unrelated");
      expect(await workspaceRuntime.workspaceFileRevision({ workspaceId: workspace.workspaceId })).toMatchObject({ revision: rootBeforeConflict.revision });
      const outsidePath = path.join(userDataPath, "outside.txt");
      await fs.writeFile(outsidePath, "outside", "utf8");
      await fs.symlink(outsidePath, path.join(workspacePath, "linked.txt"));
      expect(await workspaceRuntime.captureWorkspaceFileSnapshot({
        workspaceId: workspace.workspaceId,
        paths: ["linked.txt"]
      })).toMatchObject({ ok: false, status: 409 });
      let injected = false;
      expect(await workspaceRuntime.captureWorkspaceFileSnapshot({
        workspaceId: workspace.workspaceId,
        paths: ["existing.txt"],
        leaseGuard: async () => {
          if (injected) return;
          injected = true;
          await workspaceRuntime.uploadWorkspaceFile({
            workspaceId: workspace.workspaceId,
            path: "concurrent.txt",
            fileName: "concurrent.txt",
            contentBase64: Buffer.from("concurrent").toString("base64"),
            overwrite: true,
            operationId: "workspace.file.concurrent"
          });
        }
      })).toMatchObject({ ok: false, status: 409, code: "workspace_snapshot_conflict" });
    } finally {
      workspaceRuntime.close();
      substrate.close();
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
