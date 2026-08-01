import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";
import { stableId } from "../../../packages/agents/src/agent-workspace/agent-workspace-support.ts";

function sha256(value: any = "") : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function tempDir(prefix?: any) : Promise<any> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function workspaceFolderPath(userDataPath?: any, workspaceId?: any) : any {
  return path.join(userDataPath, "agent-workspaces", "folders", stableId("workspace-folder", workspaceId));
}

function createMerkleState({
  commitResult = {},
  getBlock = async (cid?: any) : Promise<any> => ({
    bytes: Buffer.from(`block:${cid}`, "utf8"),
    payloadHash: sha256(`block:${cid}`)
  })
}: Record<string, any> = {}) : any {
  return {
    protocolVersion: "fixture.merkle.1",
    cas: {
      putBlock: vi.fn(async (content?: any) : Promise<any> => {
        const buffer: any = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
        return {
          cid: `cid-${sha256(buffer.toString("base64")).slice(0, 12)}`,
          byteLength: buffer.length,
          payloadHash: sha256(buffer.toString("utf8"))
        };
      }),
      getBlock: vi.fn(getBlock)
    },
    merkleDag: {
      buildManifest: vi.fn(async (kind?: any, entries?: any) : Promise<any> => ({
        rootCid: `${kind}-root-${entries.length}`
      }))
    },
    stateCommit: {
      commit: vi.fn(async () : Promise<any> => ({
        beforeRoot: "before-root",
        afterRoot: "after-root",
        contentRefs: [],
        indexRoots: {},
        ...commitResult
      }))
    }
  };
}

async function withRuntime(fn?: any, options: Record<string, any> = {}) : Promise<any> {
  const root: any = await tempDir("meshrix-agent-workspace-final-seventh-extra-");
  const runtime: any = createAgentWorkspace({
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

afterEach(() : any => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent workspace behavior", () : any => {
  it("skips checkpoint tree writes when the commit result has no commitId", async () : Promise<any> => {
    const merkleState: any = createMerkleState({
      commitResult: {
        eventHash: "event-hash-without-commit-id"
      }
    });
    const checkpointTreeApi: Record<string, any> = {
      checkpointTreeId: vi.fn(() : any => "tree-missing-commit-id"),
      loadCheckpointTree: vi.fn(async () : Promise<any> => null),
      startCheckpointTree: vi.fn(async () : Promise<any> => ({ started: true })),
      upsertCheckpointNode: vi.fn(async () : Promise<any> => ({ ok: true }))
    };

    await withRuntime(async (runtime?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Checkpoint Skip Workspace" }).workspace;
      const created: any = await runtime.createWorkspaceFolder({
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

  it("surfaces CAS misses in snapshot restore and hidden-path failures in move operations", async () : Promise<any> => {
    const merkleState: any = createMerkleState({
      getBlock: vi.fn(async () : Promise<any> => null)
    });

    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Snapshot Restore Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);

      const missingBlock: any = await runtime.restoreWorkspaceFiles({
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
      const hiddenMove: any = await runtime.moveWorkspaceFile({
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

  it("rejects sync targets that are files and non-recursive directory deletes", async () : Promise<any> => {
    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Sync Failure Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      const localSourcesRoot: any = path.join(root, "local-sources");
      await fs.mkdir(localSourcesRoot, { recursive: true });
      const sourceRoot: any = await fs.mkdtemp(path.join(localSourcesRoot, "sync-source-"));

      try {
        await fs.writeFile(path.join(sourceRoot, "alpha.txt"), "alpha", "utf8");
        await fs.mkdir(path.join(workspacePath, "docs"), { recursive: true });
        await fs.writeFile(path.join(workspacePath, "docs", "nested.txt"), "nested", "utf8");

        const mount: any = runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: sourceRoot,
          targetPath: "staging"
        });
        expect(mount).toMatchObject({ ok: true });

        await fs.writeFile(path.join(workspacePath, "imports"), "occupied", "utf8");
        const syncFailure: any = runtime.localDirectorySyncPlan({
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
        const dirStat: any = await fs.stat(path.join(workspacePath, "docs"));
        expect(dirStat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(sourceRoot, { recursive: true, force: true });
      }
    }, { controlledLocalDirectoryHostEnabled: true });
  });
});
