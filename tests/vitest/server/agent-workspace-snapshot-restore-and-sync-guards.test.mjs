import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.mjs";
import { stableId } from "../../../packages/agents/src/agent-workspace/agent-workspace-support.mjs";

function sha256(value = "") {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function workspaceFolderPath(userDataPath, workspaceId) {
  return path.join(userDataPath, "agent-workspaces", "folders", stableId("workspace-folder", workspaceId));
}

function createMerkleState({
  commitResult = {},
  getBlock = async (cid) => ({
    bytes: Buffer.from(`block:${cid}`, "utf8"),
    payloadHash: sha256(`block:${cid}`)
  })
} = {}) {
  return {
    protocolVersion: "fixture.merkle.1",
    cas: {
      putBlock: vi.fn(async (content) => {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
        return {
          cid: `cid-${sha256(buffer.toString("base64")).slice(0, 12)}`,
          byteLength: buffer.length,
          payloadHash: sha256(buffer.toString("utf8"))
        };
      }),
      getBlock: vi.fn(getBlock)
    },
    merkleDag: {
      buildManifest: vi.fn(async (kind, entries) => ({
        rootCid: `${kind}-root-${entries.length}`
      }))
    },
    stateCommit: {
      commit: vi.fn(async () => ({
        beforeRoot: "before-root",
        afterRoot: "after-root",
        contentRefs: [],
        indexRoots: {},
        ...commitResult
      }))
    }
  };
}

async function withRuntime(fn, options = {}) {
  const root = await tempDir("lico-agent-workspace-final-seventh-extra-");
  const runtime = createAgentWorkspace({
    userDataPath: root,
    defaultCanAccessAll: true,
    ...options
  });
  try {
    return await fn(runtime, root);
  } finally {
    runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent workspace behavior", () => {
  it("skips checkpoint tree writes when the commit result has no commitId", async () => {
    const merkleState = createMerkleState({
      commitResult: {
        eventHash: "event-hash-without-commit-id"
      }
    });
    const checkpointTreeApi = {
      checkpointTreeId: vi.fn(() => "tree-missing-commit-id"),
      loadCheckpointTree: vi.fn(async () => null),
      startCheckpointTree: vi.fn(async () => ({ started: true })),
      upsertCheckpointNode: vi.fn(async () => ({ ok: true }))
    };

    await withRuntime(async (runtime) => {
      const workspace = runtime.createWorkspace({ title: "Checkpoint Skip Workspace" }).workspace;
      const created = await runtime.createWorkspaceFolder({
        workspaceId: workspace.workspaceId,
        folderPath: "docs"
      });

      expect(created).toMatchObject({
        ok: true,
        checkpoint: null
      });
      expect(merkleState.stateCommit.commit).toHaveBeenCalledTimes(1);
      expect(checkpointTreeApi.checkpointTreeId).not.toHaveBeenCalled();
      expect(checkpointTreeApi.loadCheckpointTree).not.toHaveBeenCalled();
      expect(checkpointTreeApi.startCheckpointTree).not.toHaveBeenCalled();
      expect(checkpointTreeApi.upsertCheckpointNode).not.toHaveBeenCalled();
    }, { merkleState, checkpointTreeApi });
  });

  it("surfaces CAS misses in snapshot restore and hidden-path failures in move operations", async () => {
    const merkleState = createMerkleState({
      getBlock: vi.fn(async () => null)
    });

    await withRuntime(async (runtime, root) => {
      const workspace = runtime.createWorkspace({ title: "Snapshot Restore Workspace" }).workspace;
      const workspacePath = workspaceFolderPath(root, workspace.workspaceId);

      const missingBlock = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot: {
          basePath: "imports",
          files: [
            {
              path: "note.txt",
              contentCid: "cid-missing",
              contentSha256: sha256("restored-body")
            }
          ]
        }
      });
      expect(missingBlock).toMatchObject({
        ok: false,
        status: 400,
        error: "文件快照内容块不存在：cid-missing"
      });
      expect(merkleState.cas.getBlock).toHaveBeenCalledWith("cid-missing");

      await fs.writeFile(path.join(workspacePath, ".secret.txt"), "hidden", "utf8");
      const hiddenMove = await runtime.moveWorkspaceFile({
        workspaceId: workspace.workspaceId,
        sourcePath: ".secret.txt",
        targetPath: "visible.txt"
      });
      expect(hiddenMove).toMatchObject({
        ok: false,
        status: 400,
        error: "不允许操作以 . 开头的文件。"
      });
    }, { merkleState });
  });

  it("rejects sync targets that are files and non-recursive directory deletes", async () => {
    await withRuntime(async (runtime, root) => {
      const workspace = runtime.createWorkspace({ title: "Sync Failure Workspace" }).workspace;
      const workspacePath = workspaceFolderPath(root, workspace.workspaceId);
      const localSourcesRoot = path.join(root, "local-sources");
      await fs.mkdir(localSourcesRoot, { recursive: true });
      const sourceRoot = await fs.mkdtemp(path.join(localSourcesRoot, "sync-source-"));

      try {
        await fs.writeFile(path.join(sourceRoot, "alpha.txt"), "alpha", "utf8");
        await fs.mkdir(path.join(workspacePath, "docs"), { recursive: true });
        await fs.writeFile(path.join(workspacePath, "docs", "nested.txt"), "nested", "utf8");

        const mount = runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: sourceRoot,
          targetPath: "staging"
        });
        expect(mount).toMatchObject({ ok: true });

        await fs.writeFile(path.join(workspacePath, "imports"), "occupied", "utf8");
        const syncFailure = runtime.localDirectorySyncPlan({
          workspaceId: workspace.workspaceId,
          mountRef: mount.mount.mountRef,
          targetPath: "imports"
        });
        expect(syncFailure).toMatchObject({
          ok: false,
          status: 400,
          error: "工作空间同步目标必须是目录。"
        });

        await expect(runtime.deleteWorkspaceFile({
          workspaceId: workspace.workspaceId,
          path: "docs"
        })).rejects.toThrow();
        const dirStat = await fs.stat(path.join(workspacePath, "docs"));
        expect(dirStat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(sourceRoot, { recursive: true, force: true });
      }
    }, { controlledLocalDirectoryHostEnabled: true });
  });
});
