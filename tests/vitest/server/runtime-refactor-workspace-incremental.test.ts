import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";
import { createAgentWorkspaceFileStateApi } from "../../../packages/agents/src/agent-workspace/agent-workspace-file-state.ts";
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

function createMerkleState({ verifyRestoreLineage = null }: Record<string, any> = {}) : any {
  const blocks: Map<string, Buffer> = new Map();
  const stateCommit: any = {
      commit: vi.fn(async () : Promise<any> => ({
        commitId: `commit-${Math.floor(Math.random() * 1_000_000)}`,
        eventId: "event-1",
        eventHash: "event-hash-1",
        beforeRoot: "before-root",
        afterRoot: "after-root",
        contentRefs: [],
        indexRoots: {}
      }))
    };
  if (verifyRestoreLineage) {
    stateCommit.verifyRestoreLineage = verifyRestoreLineage;
  }
  return {
    protocolVersion: "fixture.merkle.1",
    cas: {
      putBlock: vi.fn(async (content?: any) : Promise<any> => {
        const buffer: any = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
        const cid: any = `cid-${sha256(buffer.toString("base64")).slice(0, 12)}`;
        blocks.set(cid, buffer);
        return {
          cid,
          byteLength: buffer.length,
          payloadHash: sha256(buffer.toString("utf8"))
        };
      }),
      getBlock: vi.fn(async (cid?: any) : Promise<any> => {
        const bytes: any = blocks.get(String(cid));
        if (!bytes) return null;
        return {
          bytes,
          payloadHash: sha256(bytes.toString("utf8"))
        };
      })
    },
    merkleDag: {
      buildManifest: vi.fn(async (kind?: any, entries?: any) : Promise<any> => ({
        rootCid: `${kind}-root-${entries.length}`
      }))
    },
    merkleIndex: {
      prefix: vi.fn(async () : Promise<any> => [])
    },
    stateCommit
  };
}

function createCheckpointTreeApi() : any {
  const nodes: Record<string, any> = {};
  return {
    checkpointTreeId: vi.fn(() : any => "tree-runtime-refactor"),
    loadCheckpointTree: vi.fn(async () : Promise<any> => ({ nodes })),
    startCheckpointTree: vi.fn(async () : Promise<any> => ({ started: true })),
    upsertCheckpointNode: vi.fn(async (node?: any) : Promise<any> => {
      nodes[String(node.nodeId)] = node;
      return { ok: true };
    })
  };
}


async function checkpointSnapshotFor(checkpointTreeApi: any, commitId: any) : Promise<any> {
  const tree: any = await checkpointTreeApi.loadCheckpointTree({ treeId: "tree-runtime-refactor" });
  return tree?.nodes?.[`commit:${commitId}`]?.metadata?.workspaceFileSnapshot || null;
}

async function checkpointPreimageFor(checkpointTreeApi: any, commitId: any) : Promise<any> {
  const tree: any = await checkpointTreeApi.loadCheckpointTree({ treeId: "tree-runtime-refactor" });
  return tree?.nodes?.[`commit:${commitId}`]?.metadata?.workspaceFilePreimageSnapshot || null;
}

async function withRuntime(fn?: any, options: Record<string, any> = {}) : Promise<any> {
  const root: any = await tempDir("meshrix-runtime-refactor-workspace-");
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

describe("runtime refactor workspace incremental checkpoints", () : any => {
  it("records a bounded incremental checkpoint for a single-file write with zero unrelated work", async () : Promise<any> => {
    const merkleState: any = createMerkleState();
    const checkpointTreeApi: any = createCheckpointTreeApi();

    await withRuntime(async (runtime?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Incremental Write Workspace" }).workspace;
      await runtime.createWorkspaceFolder({
        workspaceId: workspace.workspaceId,
        folderPath: "docs"
      });
      await runtime.createWorkspaceFolder({
        workspaceId: workspace.workspaceId,
        folderPath: "unrelated"
      });
      const seeded: any = await runtime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "docs/note.md",
        fileName: "note.md",
        content: "seed"
      });
      expect(seeded.ok).toBe(true);
      const written: any = await runtime.writeWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "docs/note.md",
        content: "incremental note"
      });

      expect(written.ok).toBe(true);
      const snapshot: any = await checkpointSnapshotFor(checkpointTreeApi, written.stateCommit.commitId);
      expect(snapshot).toMatchObject({
        schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
        incremental: true,
        workspaceId: workspace.workspaceId,
        stateRoot: "after-root"
      });
      expect(snapshot.files).toHaveLength(1);
      expect(snapshot.files[0]).toMatchObject({
        path: "docs/note.md",
        exists: true,
        contentCid: expect.any(String),
        contentSha256: sha256("incremental note")
      });
      expect(written.checkpoint?.preimageEntryCount).toBe(1);
      expect(runtime.getWorkspaceRefactorInstrumentation()).toMatchObject({
        schemaVersion: "v0.0.1:workspace:file-state-refactor-instrumentation-1",
        fullSnapshotBuilds: 0,
        unrelatedEnumerations: 0,
        unrelatedReads: 0,
        unrelatedHashes: 0
      });
      expect(runtime.getWorkspaceRefactorInstrumentation().incrementalCheckpointBuilds).toBeGreaterThanOrEqual(1);
    }, { merkleState, checkpointTreeApi });
  });

  it("keeps an affected-subtree delete bounded and preserves the preimage for rollback", async () : Promise<any> => {
    const merkleState: any = createMerkleState();
    const checkpointTreeApi: any = createCheckpointTreeApi();

    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Incremental Delete Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      await fs.mkdir(path.join(workspacePath, "tree", "nested"), { recursive: true });
      await fs.writeFile(path.join(workspacePath, "tree", "a.txt"), "alpha");
      await fs.writeFile(path.join(workspacePath, "tree", "nested", "b.txt"), "beta");
      await fs.writeFile(path.join(workspacePath, "keep.txt"), "keep");

      const deleted: any = await runtime.deleteWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "tree",
        recursive: true
      });

      expect(deleted.ok).toBe(true);
      const snapshot: any = await checkpointSnapshotFor(checkpointTreeApi, deleted.stateCommit.commitId);
      expect(snapshot.incremental).toBe(true);
      const paths: any = snapshot.files.map((entry?: any) : any => entry.path);
      expect(paths).toContain("tree/a.txt");
      expect(paths).toContain("tree/nested/b.txt");
      expect(paths).not.toContain("keep.txt");
      expect(snapshot.files.every((entry?: any) : any => entry.exists === false)).toBe(true);

      const preimage: any = await checkpointPreimageFor(checkpointTreeApi, deleted.stateCommit.commitId);
      expect(preimage).toBeTruthy();
      const preimagePaths: any = preimage.files.map((entry?: any) : any => entry.path);
      expect(preimagePaths).toEqual(expect.arrayContaining(["tree/a.txt", "tree/nested/b.txt"]));
      expect(preimagePaths).not.toContain("keep.txt");
      const instrumentation: any = runtime.getWorkspaceRefactorInstrumentation();
      expect(instrumentation.unrelatedEnumerations).toBe(0);
      expect(instrumentation.unrelatedReads).toBe(0);
      expect(instrumentation.unrelatedHashes).toBe(0);
    }, { merkleState, checkpointTreeApi });
  });

  it("indexes every affected file in a directory move and restores the moved subtree byte-exactly", async () : Promise<any> => {
    const merkleState: any = createMerkleState();
    const checkpointTreeApi: any = createCheckpointTreeApi();

    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Incremental Move Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      await fs.mkdir(path.join(workspacePath, "source", "nested"), { recursive: true });
      await fs.writeFile(path.join(workspacePath, "source", "a.txt"), "alpha");
      await fs.writeFile(path.join(workspacePath, "source", "nested", "b.txt"), "beta");

      const moved: any = await runtime.moveWorkspaceFile({
        workspaceId: workspace.workspaceId,
        from: "source",
        to: "target"
      });
      expect(moved.ok).toBe(true);
      const snapshot: any = await checkpointSnapshotFor(checkpointTreeApi, moved.stateCommit.commitId);
      expect(snapshot.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "source/a.txt", exists: false }),
        expect.objectContaining({ path: "source/nested/b.txt", exists: false }),
        expect.objectContaining({ path: "target/a.txt", exists: true, contentCid: expect.any(String) }),
        expect.objectContaining({ path: "target/nested/b.txt", exists: true, contentCid: expect.any(String) })
      ]));

      await fs.rm(path.join(workspacePath, "target"), { recursive: true, force: true });
      const restored: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot,
        operationId: "test.restore-directory-move",
        createdBy: "test",
        actorUserId: workspace.ownerUserId
      });
      expect(restored.ok).toBe(true);
      await expect(fs.readFile(path.join(workspacePath, "target", "a.txt"), "utf8")).resolves.toBe("alpha");
      await expect(fs.readFile(path.join(workspacePath, "target", "nested", "b.txt"), "utf8")).resolves.toBe("beta");
    }, { merkleState, checkpointTreeApi });
  });

  it("restores a single-file incremental checkpoint byte-exactly through the CAS", async () : Promise<any> => {
    const merkleState: any = createMerkleState();
    const checkpointTreeApi: any = createCheckpointTreeApi();

    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Incremental Restore Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      await fs.mkdir(path.join(workspacePath, "docs"), { recursive: true });
      const written: any = await runtime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "docs/note.md",
        fileName: "note.md",
        content: "original"
      });
      expect(written.ok).toBe(true);
      const snapshot: any = await checkpointSnapshotFor(checkpointTreeApi, written.stateCommit.commitId);
      expect(snapshot).not.toBeNull();
      expect(snapshot.files).toHaveLength(1);

      await fs.rm(path.join(workspacePath, "docs", "note.md"), { force: true });
      const restored: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot,
        operationId: "test.restore",
        createdBy: "test",
        actorUserId: workspace.ownerUserId
      });
      expect(restored.ok).toBe(true);
      expect(restored.appliedActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "create", path: "docs/note.md" })
      ]));
      const content: any = await fs.readFile(path.join(workspacePath, "docs", "note.md"), "utf8");
      expect(content).toBe("original");
    }, { merkleState, checkpointTreeApi });
  });

  it("migrates a legacy embedded full snapshot into a canonical incremental checkpoint and fails closed on mismatch", async () : Promise<any> => {
    const root: any = await tempDir("meshrix-runtime-refactor-migration-");
    const workspaceRoot: any = path.join(root, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    const merkleState: any = createMerkleState();
    const resolveWorkspacePath: any = (workspace?: any, relativePath: any = "", options: Record<string, any> = {}) : any => {
      const normalized: any = String(relativePath || "").replace(/^\/+|\/+$/g, "");
      const target: any = normalized ? path.resolve(workspaceRoot, ...normalized.split("/")) : workspaceRoot;
      return {
        root: workspaceRoot,
        relativePath: normalized,
        absolutePath: target
      };
    };
    const legacyNode: any = {
      nodeId: "commit:legacy",
      metadata: {
        workspaceId: "ws-legacy",
        stateCommit: { commitId: "legacy", afterRoot: "legacy-root" },
        workspaceFileSnapshot: {
          workspaceId: "ws-legacy",
          basePath: "",
          deleteExtraneous: true,
          files: [
            { path: "a.txt", exists: true, contentCid: "cid-a", contentSha256: sha256("a"), byteLength: 1, encoding: "base64" },
            { path: "gone.txt", exists: false, contentSha256: "", byteLength: 0 }
          ]
        }
      }
    };
    const treeNodes: Record<string, any> = { "commit:legacy": legacyNode };
    const checkpointTreeApi: any = {
      checkpointTreeId: vi.fn(() : any => "tree-migrate"),
      loadCheckpointTree: vi.fn(async () : Promise<any> => ({ nodes: treeNodes })),
      upsertCheckpointNode: vi.fn(async (node?: any) : Promise<any> => {
        treeNodes[String(node.nodeId)] = node;
        return { ok: true };
      })
    };
    const api: any = createAgentWorkspaceFileStateApi({
      merkleState,
      checkpointTreeApi,
      resolveWorkspacePath,
      listWorkspaceFiles: vi.fn(async () : Promise<any> => ({ ok: true, files: [] }))
    });
    try {
      const migrated: any = await api.migrateCheckpointTreeFileSnapshots({
        tree: { nodes: treeNodes }
      });
      expect(migrated).toMatchObject({ ok: true, migrated: 1 });
      const node: any = treeNodes["commit:legacy"];
      const snapshot: any = node.metadata.workspaceFileSnapshot;
      expect(snapshot).toMatchObject({
        schemaVersion: "v0.0.1:workspace:file-incremental-checkpoint-1",
        incremental: true,
        stateRoot: "legacy-root"
      });
      expect(snapshot.files).toHaveLength(2);
      expect(snapshot.files[0]).toMatchObject({ path: "a.txt", exists: true, contentCid: "cid-a", contentSha256: sha256("a") });
      expect(snapshot.files[1]).toMatchObject({ path: "gone.txt", exists: false });

      const failingTreeNodes: Record<string, any> = {
        "commit:broken": {
          nodeId: "commit:broken",
          metadata: {
            workspaceId: "ws-broken",
            stateCommit: { commitId: "broken", afterRoot: "broken-root" },
            workspaceFileSnapshot: {
              workspaceId: "ws-broken",
              basePath: "",
              deleteExtraneous: true,
              files: [
                { path: "a.txt", exists: true, contentCid: "cid-a", contentSha256: sha256("a"), byteLength: 1 }
              ]
            }
          }
        }
      };
      const failingApi: any = createAgentWorkspaceFileStateApi({
        merkleState,
        checkpointTreeApi: {
          checkpointTreeId: vi.fn(() : any => "tree-broken"),
          loadCheckpointTree: vi.fn(async () : Promise<any> => ({ nodes: failingTreeNodes })),
          upsertCheckpointNode: vi.fn(async () : Promise<any> => ({ ok: true }))
        },
        resolveWorkspacePath,
        listWorkspaceFiles: vi.fn(async () : Promise<any> => ({ ok: true, files: [] }))
      });
      const original: any = JSON.parse(JSON.stringify(failingTreeNodes["commit:broken"]));
      const refused: any = await failingApi.migrateCheckpointTreeFileSnapshots({
        tree: { nodes: failingTreeNodes }
      });
      expect(refused.ok).toBe(true);
      expect(JSON.parse(JSON.stringify(failingTreeNodes["commit:broken"]))).toEqual(original);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on conflicting restore without losing the prior recoverable root", async () : Promise<any> => {
    const merkleState: any = createMerkleState({
      verifyRestoreLineage: vi.fn(async (input?: any) : Promise<any> => {
        if (input?.targetRoot !== "after-root") {
          const error: Error & Record<string, any> = new Error("workspace restore lineage rejected: unknown state root.");
          error.code = "workspace_restore_lineage_conflict";
          error.status = 409;
          throw error;
        }
        return { ok: true };
      })
    });
    const checkpointTreeApi: any = createCheckpointTreeApi();

    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Conflict Restore Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      await fs.mkdir(path.join(workspacePath, "docs"), { recursive: true });
      const written: any = await runtime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "docs/note.md",
        fileName: "note.md",
        content: "stable"
      });
      expect(written.ok).toBe(true);
      const snapshot: any = await checkpointSnapshotFor(checkpointTreeApi, written.stateCommit.commitId);

      const conflicted: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot: {
          ...snapshot,
          stateRoot: "root-that-was-never-committed"
        },
        stateRootAllowedOperationIds: ["some.other.operation"],
        operationId: "test.conflict",
        createdBy: "test",
        actorUserId: workspace.ownerUserId
      });
      expect(conflicted.ok).toBe(false);
      expect([409, 500, 503]).toContain(conflicted.status);
      const content: any = await fs.readFile(path.join(workspacePath, "docs", "note.md"), "utf8");
      expect(content).toBe("stable");
    }, { merkleState, checkpointTreeApi });
  });
});
