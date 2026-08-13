import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";
import { stableId } from "../../../packages/agents/src/agent-workspace/agent-workspace-support.ts";

function sha256(value: any = "") : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(buffer?: any) : any {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function tempDir(prefix?: any) : Promise<any> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function workspaceFolderPath(userDataPath?: any, workspaceId?: any) : any {
  return path.join(userDataPath, "agent-workspaces", "folders", stableId("workspace-folder", workspaceId));
}

function createMerkleState() : any {
  let rootCalls: any = 0;
  return {
    protocolVersion: "fixture.merkle.1",
    cas: {
      putBlock: vi.fn(async (content?: any) : Promise<any> => {
        const buffer: any = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
        return {
          cid: `cid-${sha256Buffer(buffer).slice(0, 12)}`,
          byteLength: buffer.length,
          payloadHash: sha256Buffer(buffer),
          bytes: buffer
        };
      }),
      getBlock: vi.fn(async (cid?: any) : Promise<any> => {
        if (cid === "missing-cid") {
          return null;
        }
        return {
          bytes: Buffer.from(`decoded:${cid}`),
          payloadHash: sha256(cid)
        };
      })
    },
    merkleDag: {
      buildManifest: vi.fn(async (kind?: any, entries?: any) : Promise<any> => ({
        rootCid: `${kind}-root-${entries.length}`
      }))
    },
    stateCommit: {
      begin: vi.fn(async () : Promise<any> => {
        rootCalls += 1;
        return {
          currentRoot: rootCalls === 1 ? "" : "state-root"
        };
      }),
      commit: vi.fn(async ({ mutations, contentRefs }: Record<string, any>) : Promise<any> => ({
        commitId: `commit-${mutations.length}-${contentRefs.length}`,
        eventHash: "event-hash",
        beforeRoot: "before-root",
        afterRoot: "after-root",
        contentRefs,
        indexRoots: { workspace: "index-root" }
      }))
    },
    merkleIndex: {
      get: vi.fn(async (root?: any, relativePath?: any) : Promise<any> => (
        relativePath.includes("hit") ? { valueRef: `value-${root}-${relativePath}` } : null
      )),
      prefix: vi.fn(async (root?: any, prefix?: any) : Promise<any> => (
        prefix === "empty" ? [] : [
          { key: `${prefix || "root"}/alpha`, valueRef: `${root}-alpha` },
          { key: `${prefix || "root"}/beta`, valueRef: `${root}-beta` }
        ]
      )),
      prove: vi.fn(async () : Promise<any> => ({ proofHash: "proof-hash" }))
    },
    uploadManifest: {
      materialize: vi.fn(async () : Promise<any> => ({ rootCid: "manifest-root", recordCount: 1, nextOffset: 5 }))
    }
  };
}

function createCheckpointTreeApi() : any {
  return {
    checkpointTreeId: vi.fn(() : any => "checkpoint-tree-id"),
    loadCheckpointTree: vi.fn(async () : Promise<any> => null),
    startCheckpointTree: vi.fn(async () : Promise<any> => ({ started: true })),
    upsertCheckpointNode: vi.fn(async () : Promise<any> => ({ ok: true }))
  };
}

async function withRuntime(fn?: any, options: Record<string, any> = {}) : Promise<any> {
  const root: any = await tempDir("meshrix-agent-workspace-final-extra-12-");
  const runtime: any = createAgentWorkspace({
    userDataPath: root,
    defaultCanAccessAll: true,
    ...options
  });
  try {
    return await fn(runtime, root);
  } finally {
    runtime.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

afterEach(() : any => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent workspace behavior helper branches", () : any => {
  it("covers helper fallbacks through runtime corruption and submission gating", async () : Promise<any> => {
    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Corruption Workspace" }).workspace;
      const db: any = new Database(path.join(root, "agent-workspaces", "agent-workspace.sqlite"));
      try {
        db.prepare("UPDATE aw_workspaces SET metadata_json = ?, profile_json = ?, owned_source_ids_json = ? WHERE workspace_id = ?")
          .run("not-json", "also-not-json", "still-not-json", workspace.workspaceId);
        db.prepare("INSERT INTO aw_private_state (id, workspace_id, run_id, agent_id, summary, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run("private-1", workspace.workspaceId, "run-1", "agent-1", "summary", "not-json", "2026-06-05T00:00:00.000Z");
      } finally {
        db.close();
      }

      const ws: any = runtime.getWorkspace({
        workspaceId: workspace.workspaceId,
        includePrivate: true,
        includeRuns: false,
        includeSubmissions: false,
        includeArtifacts: false,
        includeIssues: false,
        includeDecisions: false,
        includeLocks: false
      });
      expect(ws).toMatchObject({
        workspace: {
          workspaceId: workspace.workspaceId,
          metadata: {},
          profile: {},
          ownedSourceIds: []
        }
      });
      expect(ws.privateStates).toHaveLength(1);
      expect(ws.privateStates[0].state).toEqual({});

      const run: any = runtime.createRun({
        workspaceId: workspace.workspaceId,
        runType: "analysis"
      }).run;

      const submission: any = runtime.submit({
        workspaceId: workspace.workspaceId,
        runId: run.runId,
        type: "issue",
        payload: {
          issue: "submission gating"
        }
      });
      expect(submission).toMatchObject({
        submission: {
          status: "proposed",
          type: "issue"
        }
      });
    });
  });
});

describe("agent workspace behavior filesystem edges", () : any => {
  it("covers local directory mount validation and traversal guards", async () : Promise<any> => {
    const merkleState: any = createMerkleState();
    const checkpointTreeApi: any = createCheckpointTreeApi();
    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Local Dir Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);

      const localSourcesRoot: any = path.join(root, "local-sources");
      await fsPromises.mkdir(localSourcesRoot, { recursive: true });
      const sourceRoot: any = await fsPromises.mkdtemp(path.join(localSourcesRoot, "source-"));
      const cleanSource: any = await fsPromises.mkdtemp(path.join(localSourcesRoot, "clean-source-"));
      try {
        await fsPromises.writeFile(path.join(sourceRoot, "second.txt"), "second", "utf8");
        await fsPromises.mkdir(path.join(sourceRoot, "a-dir"), { recursive: true });
        await fsPromises.writeFile(path.join(sourceRoot, "a-dir", "inner.txt"), "inner", "utf8");
        await fsPromises.writeFile(path.join(cleanSource, "alpha.txt"), "alpha", "utf8");
        await fsPromises.mkdir(path.join(cleanSource, "nested"), { recursive: true });
        await fsPromises.writeFile(path.join(cleanSource, "nested", "beta.txt"), "beta", "utf8");
        await fsPromises.writeFile(path.join(workspacePath, "root-file.txt"), "root file", "utf8");
        await fsPromises.mkdir(path.join(workspacePath, "a-dir"), { recursive: true });
        await fsPromises.writeFile(path.join(workspacePath, "a-dir", "child.txt"), "child", "utf8");
        await fsPromises.writeFile(path.join(workspacePath, "z.txt"), "z", "utf8");

        expect(runtime.connectLocalDirectory({
          workspaceId: "missing-workspace",
          sourcePath: sourceRoot,
          targetPath: "imports"
        })).toMatchObject({
          ok: false,
          status: 404
        });

        const selection: any = runtime.createLocalDirectoryMountSelection({
          workspaceId: workspace.workspaceId,
          sourcePath: cleanSource
        });
        expect(selection).toMatchObject({
          ok: true,
          workspaceId: workspace.workspaceId,
          mountSelectionRef: expect.stringMatching(/^local-directory-selection:[a-f0-9]{32}$/u)
        });
        expect(JSON.stringify(selection)).not.toContain(cleanSource);
        expect(runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          mountSelectionRef: selection.mountSelectionRef,
          targetPath: "selected"
        })).toMatchObject({ ok: true });
        expect(runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          mountSelectionRef: selection.mountSelectionRef,
          targetPath: "replayed"
        })).toMatchObject({ ok: false, status: 400 });

        const firstMount: any = runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: cleanSource,
          targetPath: "imports"
        });
        expect(firstMount).toMatchObject({ ok: true });

        const updatedMount: any = runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: sourceRoot,
          targetPath: "imports",
          mountRef: firstMount.mount.mountRef
        });
        expect(updatedMount).toMatchObject({ ok: true });
        expect(JSON.stringify(updatedMount)).not.toContain(sourceRoot);
        expect(updatedMount.mount).not.toHaveProperty("sourceRootName");
        expect(updatedMount.mount).not.toHaveProperty("sourceRootHash");
        expect(runtime.localDirectoryItemMetadata({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "second.txt",
          includeHash: true
        })).toMatchObject({
          ok: true,
          mode: "localDir",
          item: {
            mountRef: firstMount.mount.mountRef,
            relativePath: "second.txt",
            type: "file"
          }
        });
        expect(runtime.readLocalDirectoryFile({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "second.txt"
        })).toMatchObject({
          ok: true,
          mode: "localDir",
          file: {
            mountRef: firstMount.mount.mountRef,
            relativePath: "second.txt"
          },
          content: "second"
        });
        const directWrite: any = await runtime.writeLocalDirectoryFile({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "new-dir/new.txt",
          content: "mounted write"
        });
        expect(directWrite).toMatchObject({
          ok: true,
          mode: "localDir",
          file: {
            mountRef: firstMount.mount.mountRef,
            relativePath: "new-dir/new.txt"
          }
        });
        await expect(fsPromises.readFile(path.join(sourceRoot, "new-dir", "new.txt"), "utf8")).resolves.toBe("mounted write");
        expect(await runtime.createLocalDirectoryFolder({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "made"
        })).toMatchObject({
          ok: true,
          folder: {
            relativePath: "made"
          }
        });
        expect(await runtime.moveLocalDirectoryItem({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          sourcePath: "new-dir/new.txt",
          targetPath: "made/renamed.txt"
        })).toMatchObject({
          ok: true,
          moved: true,
          sourcePath: "new-dir/new.txt",
          targetPath: "made/renamed.txt"
        });
        await expect(fsPromises.readFile(path.join(sourceRoot, "made", "renamed.txt"), "utf8")).resolves.toBe("mounted write");
        expect(await runtime.deleteLocalDirectoryItem({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "made/renamed.txt"
        })).toMatchObject({
          ok: true,
          deleted: true,
          item: {
            relativePath: "made/renamed.txt"
          }
        });
        await expect(fsPromises.stat(path.join(sourceRoot, "made", "renamed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(runtime.readLocalDirectoryFile({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "../escape.txt"
        })).toMatchObject({
          ok: false,
          status: 400
        });
        expect(await runtime.writeLocalDirectoryFile({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: path.join(sourceRoot, "absolute.txt"),
          content: "escape"
        })).toMatchObject({
          ok: false,
          status: 400
        });
        await fsPromises.symlink(path.join(sourceRoot, "second.txt"), path.join(sourceRoot, "link.txt"));

        expect(runtime.listLocalDirectoryMounts({ workspaceId: "missing-workspace" })).toMatchObject({
          ok: false,
          status: 404
        });

        expect(runtime.listLocalDirectoryItems({
          workspaceId: "missing-workspace",
          mountRef: firstMount.mount.mountRef,
          path: ""
        })).toMatchObject({
          ok: false,
          status: 404
        });

        expect(runtime.listLocalDirectoryItems({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "../escape"
        })).toMatchObject({
          ok: false,
          status: 400,
          error: "路径不能跳出工作空间。"
        });

        expect(runtime.listLocalDirectoryItems({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "link.txt"
	        })).toMatchObject({
	          ok: false,
	          status: 400,
	          error: "本机目录路径不能指向符号链接。"
	        });

        expect(runtime.listLocalDirectoryItems({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          path: "",
          recursive: true,
          limit: 1
        })).toMatchObject({
          ok: true,
          count: 1
        });

        await expect(runtime.listWorkspaceFiles({
          workspaceId: workspace.workspaceId,
          path: "",
          recursive: true,
          limit: 1,
          includeHash: true
        })).resolves.toMatchObject({
          ok: true,
          count: 1
        });

        await expect(runtime.listWorkspaceFiles({
          workspaceId: workspace.workspaceId,
          path: "root-file.txt",
          includeHash: true
        })).resolves.toMatchObject({
          ok: true,
          exists: true
        });

        expect(runtime.getWorkspace({
          workspaceId: workspace.workspaceId,
          runLimit: 0
        })).toMatchObject({
          workspace: {
            workspaceId: workspace.workspaceId
          }
        });

        expect(runtime.createSession({
          workspaceId: "missing-workspace",
          title: "Missing session workspace"
        })).toMatchObject({
          ok: false,
          error: "工作空间不存在"
        });

        const session: any = runtime.createSession({
          workspaceId: workspace.workspaceId,
          title: "Session A"
        }).session;
        runtime.createSession({
          workspaceId: workspace.workspaceId,
          title: "Session B"
        });

        expect(runtime.listSessions({})).toMatchObject({
          protocolVersion: "v0.0.1:workspace:agent-workspace-1"
        });
        expect(runtime.listSessions({ workspaceId: workspace.workspaceId })).toMatchObject({
          protocolVersion: "v0.0.1:workspace:agent-workspace-1"
        });
        expect(runtime.listSessions({ status: "active" })).toMatchObject({
          protocolVersion: "v0.0.1:workspace:agent-workspace-1"
        });

        const missingSource: any = path.join(root, "missing-source");
        const sourceSymlink: any = path.join(root, "source-symlink");
        const workspaceSymlink: any = path.join(workspacePath, "workspace-symlink");
        await fsPromises.symlink(sourceRoot, sourceSymlink);
        await fsPromises.symlink(path.join(workspacePath, "root-file.txt"), workspaceSymlink);

        expect(runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: missingSource,
          targetPath: "sync"
        })).toMatchObject({
          ok: false,
          status: 400,
          error: "本机目录不存在。"
        });

        expect(runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: path.join(sourceRoot, "second.txt"),
          targetPath: "sync"
        })).toMatchObject({
          ok: false,
          status: 400,
          error: "本机目录必须是目录。"
        });

        expect(runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: sourceSymlink,
          targetPath: "sync"
        })).toMatchObject({
          ok: false,
          status: 400,
          error: "本机目录不能是符号链接。"
        });

        expect(runtime.localDirectorySyncPlan({
          workspaceId: workspace.workspaceId,
          mountRef: firstMount.mount.mountRef,
          targetPath: ""
        })).toMatchObject({
          ok: false,
          status: 400,
          error: "不允许同步符号链接：link.txt"
        });

        const cleanMount: any = runtime.connectLocalDirectory({
          workspaceId: workspace.workspaceId,
          sourcePath: cleanSource,
          targetPath: "clean-sync"
        });
        expect(cleanMount).toMatchObject({ ok: true });
        expect(runtime.localDirectorySyncPlan({
          workspaceId: workspace.workspaceId,
          mountRef: cleanMount.mount.mountRef,
          targetPath: ""
        })).toMatchObject({
          ok: false,
          status: 400,
          error: "工作空间内存在不允许同步的符号链接：workspace-symlink"
        });
      } finally {
        await fsPromises.rm(sourceRoot, { recursive: true, force: true });
        await fsPromises.rm(cleanSource, { recursive: true, force: true });
      }
    }, {
      merkleState,
      checkpointTreeApi,
      controlledLocalDirectoryHostEnabled: true
    });
  });
});

describe("agent workspace behavior file operations", () : any => {
  it("covers validation branches and merkle-backed file workflows", async () : Promise<any> => {
    const merkleState: any = createMerkleState();
    const checkpointTreeApi: any = createCheckpointTreeApi();

    await withRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Merkle File Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);

      await fsPromises.writeFile(path.join(workspacePath, "existing.txt"), "existing", "utf8");
      await fsPromises.writeFile(path.join(workspacePath, "move-source.txt"), "move-source", "utf8");
      await fsPromises.mkdir(path.join(workspacePath, "move-dir"), { recursive: true });
      await fsPromises.writeFile(path.join(workspacePath, "move-dir", "child.txt"), "child", "utf8");
      await fsPromises.mkdir(path.join(workspacePath, "patch-dir"), { recursive: true });
      await fsPromises.writeFile(path.join(workspacePath, "patch-dir", "inner.txt"), "inner", "utf8");

      expect(await runtime.uploadWorkspaceFile({
        workspaceId: "missing-workspace",
        fileName: "missing.txt",
        content: "missing"
      })).toMatchObject({
        ok: false,
        status: 404
      });

      expect(await runtime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        fileName: "missing-content.txt"
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "content 或 contentBase64 至少提供一个。"
      });

      expect(await runtime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        fileName: "invalid-path.txt",
        content: "content",
        path: "../escape"
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "路径不能跳出工作空间。"
      });

      const uploaded: any = await runtime.uploadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        fileName: "upload.txt",
        content: "upload-body"
      });
      expect(uploaded).toMatchObject({
        ok: true,
        file: {
          relativePath: "files/upload.txt"
        }
      });

      const rewritten: any = await runtime.writeWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "existing.txt",
        contentBase64: ""
      });
      expect(rewritten).toMatchObject({
        ok: true,
        file: {
          relativePath: "existing.txt"
        }
      });

      expect(await runtime.writeWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "../escape",
        content: "bad"
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "路径不能跳出工作空间。"
      });

      expect(await runtime.patchWorkspaceFile({
        workspaceId: workspace.workspaceId
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "path 不能为空。"
      });

      expect(await runtime.patchWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "patch-dir"
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "目标路径是文件夹，不能打补丁。"
      });

      expect(await runtime.deleteWorkspaceFile({
        workspaceId: workspace.workspaceId
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "path 不能为空。"
      });

      expect(await runtime.deleteWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: ".hidden"
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "不允许操作以 . 开头的文件。"
      });

      const deleted: any = await runtime.deleteWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "existing.txt"
      });
      expect(deleted).toMatchObject({
        ok: true,
        deleted: true
      });

      expect(await runtime.moveWorkspaceFile({
        workspaceId: workspace.workspaceId,
        sourcePath: "../escape",
        targetPath: "move-target.txt"
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "路径不能跳出工作空间。"
      });

      expect(await runtime.moveWorkspaceFile({
        workspaceId: workspace.workspaceId,
        sourcePath: "move-source.txt",
        targetPath: "move-target.txt"
      })).toMatchObject({
        ok: true,
        moved: true
      });

      const movedDir: any = await runtime.moveWorkspaceFile({
        workspaceId: workspace.workspaceId,
        sourcePath: "move-dir",
        targetPath: "move-dir-renamed"
      });
      expect(movedDir).toMatchObject({
        ok: true,
        moved: true
      });

      const fileList: any = await runtime.listWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        path: "move-target.txt",
        includeHash: true
      });
      expect(fileList).toMatchObject({
        ok: true,
        exists: true
      });

      const download: any = await runtime.downloadWorkspaceFile({
        workspaceId: workspace.workspaceId,
        path: "move-target.txt"
      });
      expect(download).toMatchObject({
        ok: true,
        file: {
          relativePath: "move-target.txt"
        }
      });

      expect(runtime.listRunArtifacts("missing-run")).toEqual([]);
    }, { merkleState, checkpointTreeApi });
  });
});
