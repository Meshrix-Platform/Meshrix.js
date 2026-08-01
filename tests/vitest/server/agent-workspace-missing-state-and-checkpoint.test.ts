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

async function withWorkspaceRuntime(fn?: any, options: Record<string, any> = {}) : Promise<any> {
  const root: any = await tempDir("meshrix-agent-workspace-final-sixth-extra-");
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
  it("covers missing-workspace rejections across file mutation and snapshot APIs", async () : Promise<any> => {
    await withWorkspaceRuntime(async (runtime?: any) : Promise<any> => {
      expect(await runtime.workspaceFileMetadata({
        workspaceId: "missing-workspace",
        path: "docs/readme.md"
      })).toMatchObject({
        ok: false,
        error: "工作空间不存在或不可访问。"
      });

      expect(await runtime.restoreWorkspaceFiles({
        workspaceId: "missing-workspace",
        snapshot: {
          files: [{ path: "docs/readme.md", content: "x" }]
        }
      })).toMatchObject({
        ok: false,
        error: "工作空间不存在或不可访问。"
      });

      expect(await runtime.writeWorkspaceFile({
        workspaceId: "missing-workspace",
        path: "docs/readme.md",
        content: "body"
      })).toMatchObject({
        ok: false,
        error: "工作空间不存在或不可访问。"
      });

      expect(await runtime.patchWorkspaceFile({
        workspaceId: "missing-workspace",
        path: "docs/readme.md",
        expectedSha256: sha256("body"),
        hunks: [{ oldText: "body", newText: "updated" }]
      })).toMatchObject({
        ok: false,
        error: "工作空间不存在或不可访问。"
      });

      expect(await runtime.deleteWorkspaceFile({
        workspaceId: "missing-workspace",
        path: "docs/readme.md"
      })).toMatchObject({
        ok: false,
        error: "工作空间不存在或不可访问。"
      });

      expect(await runtime.moveWorkspaceFile({
        workspaceId: "missing-workspace",
        sourcePath: "docs/readme.md",
        targetPath: "docs/archive.md"
      })).toMatchObject({
        ok: false,
        error: "工作空间不存在或不可访问。"
      });
    });
  });

  it("restores snapshot entries from CAS bytes and rebases them under the snapshot base path", async () : Promise<any> => {
    const stateEvents: any[] = [];
    let currentRoot: any = "";
    let commitSequence: any = 0;
    let failReceiptConstruction: any = false;
    let failedCommitId: any = "";
    const checkpointNodes: Record<string, any> = {};
    const contentBlocks: any = new Map<any, any>([
      ["cid-note", Buffer.from("restored-from-cas", "utf8")]
    ]);
    const merkleState: Record<string, any> = {
      protocolVersion: "fixture.merkle.1",
      cas: {
        getBlock: vi.fn(async (cid?: any) : Promise<any> => contentBlocks.has(cid)
          ? { bytes: Buffer.from(contentBlocks.get(cid)) }
          : null),
        putBlock: vi.fn(async (content?: any) : Promise<any> => {
          const buffer: any = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
          const cid: any = `cid-${sha256(buffer).slice(0, 16)}`;
          contentBlocks.set(cid, Buffer.from(buffer));
          return {
            cid,
            byteLength: buffer.length,
            payloadHash: sha256(buffer.toString("utf8"))
          };
        })
      },
      merkleDag: {
        buildManifest: vi.fn(async (kind?: any, entries?: any) : Promise<any> => ({
          rootCid: `${kind}-root-${entries.length}`
        }))
      },
      merkleIndex: {
        prefix: vi.fn(async () : Promise<any> => []),
        prove: vi.fn(async () : Promise<any> => ({ proofHash: sha256("empty-proof") }))
      },
      stateCommit: {
        commit: vi.fn(async ({ mutations, contentRefs, payload }: Record<string, any>) : Promise<any> => {
          commitSequence += 1;
          const beforeRoot: any = currentRoot;
          const afterRoot: any = `after-root-${commitSequence}`;
          const commitId: any = `commit-${commitSequence}-${mutations.length}-${contentRefs.length}`;
          const eventHash: any = `event-hash-${commitSequence}`;
          currentRoot = afterRoot;
          stateEvents.push({ eventId: `event-${commitSequence}`, eventHash, payload, afterRoot });
          const persistedContentRefs: any[] = [...contentRefs];
          if (failReceiptConstruction) {
            persistedContentRefs.push(persistedContentRefs);
            failedCommitId = commitId;
          }
          return {
            commitId,
            eventId: `event-${commitSequence}`,
            eventHash,
            beforeRoot,
            afterRoot,
            contentRefs: persistedContentRefs,
            indexRoots: {}
          };
        })
      },
      eventLog: {
        listEvents: vi.fn(async () : Promise<any> => [...stateEvents])
      }
    };
    const checkpointTreeApi: Record<string, any> = {
      checkpointTreeId: vi.fn(() : any => "tree-sandbox-output"),
      loadCheckpointTree: vi.fn(async () : Promise<any> => Object.keys(checkpointNodes).length > 0
        ? { treeId: "tree-sandbox-output", nodes: checkpointNodes }
        : null),
      startCheckpointTree: vi.fn(async () : Promise<any> => ({ started: true })),
      upsertCheckpointNode: vi.fn(async (node?: any) : Promise<any> => {
        checkpointNodes[node.nodeId] = node;
        return { ok: true };
      })
    };

    await withWorkspaceRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Snapshot Rebase Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      await fs.mkdir(path.join(workspacePath, "docs"), { recursive: true });
      await fs.writeFile(path.join(workspacePath, "docs", "obsolete.txt"), "obsolete", "utf8");

      const dryRun: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        dryRun: true,
        snapshot: {
          basePath: "docs",
          deleteExtraneous: true,
          files: [
            {
              path: "note.txt",
              contentCid: "cid-note",
              contentSha256: sha256("restored-from-cas")
            },
            {
              path: "docs/remove.txt",
              exists: false
            }
          ]
        }
      });

      expect(dryRun).toMatchObject({
        ok: true,
        dryRun: true,
        summary: {
          create: 1,
          delete: 1
        }
      });
      expect(dryRun.appliedActions).toEqual([]);

      const sandboxBindings: Record<string, any> = {
        runRef: "opaque-run-ref",
        artifactDigest: sha256("artifact"),
        outputDigest: sha256("output")
      };
      expect(await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        operationId: "synthetic.plugin.sandbox.output.commit",
        sandboxBindings,
        sandboxReceiptDigest: sha256(JSON.stringify(sandboxBindings)),
        snapshot: { basePath: "docs", files: [] }
      })).toMatchObject({
        ok: false,
        status: 409,
        code: "sandbox_output_approval_binding_required"
      });

      const restored: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        operationId: "synthetic.plugin.sandbox.output.commit",
        sandboxBindings,
        sandboxReceiptDigest: sha256(JSON.stringify(sandboxBindings)),
        previewDigest: sha256("preview"),
        approvalBindingDigest: sha256("approval"),
        snapshot: {
          basePath: "docs",
          deleteExtraneous: true,
          files: [
            {
              path: "note.txt",
              contentCid: "cid-note",
              contentSha256: sha256("restored-from-cas")
            },
            {
              path: "docs/remove.txt",
              exists: false
            }
          ]
        }
      });

      expect(restored).toMatchObject({
        ok: true,
        dryRun: false,
        mutationOrigin: {
          kind: "controlled-sandbox-output",
          previewDigest: sha256("preview"),
          approvalBindingDigest: sha256("approval")
        },
        summary: {
          create: 1,
          delete: 1,
          applied: 2
        }
      });
      expect(merkleState.stateCommit.commit).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({
          mutationOrigin: expect.objectContaining({
            kind: "controlled-sandbox-output",
            sandboxReceiptDigest: restored.mutationOrigin.sandboxReceiptDigest
          })
        })
      }));
      const persistedReceipt: any = await runtime.getWorkspaceSandboxMutationReceipt({
        workspaceId: workspace.workspaceId,
        commitId: restored.stateCommit.commitId
      });
      expect(persistedReceipt).toMatchObject({
        ok: true,
        mutationReceipt: {
          schemaVersion: "v0.0.1:workspace:sandbox-mutation-receipt-1",
          sandboxReceiptDigest: restored.mutationOrigin.sandboxReceiptDigest,
          previewDigest: sha256("preview"),
          approvalBindingDigest: sha256("approval"),
          preimageDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          stateCommitId: restored.stateCommit.commitId,
          checkpointNodeId: `commit:${restored.stateCommit.commitId}`,
          receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }
      });
      expect(persistedReceipt.mutationReceipt).toEqual(restored.mutationReceipt);
      const rootBeforeFailedReceipt: any = currentRoot;
      merkleState.stateCommit.begin = vi.fn(async () : Promise<any> => ({ currentRoot }));
      merkleState.stateCommit.restoreRoot = vi.fn(async ({ targetRoot, expectedCurrentRoot, operationId, payload }: Record<string, any>) : Promise<any> => {
        expect(currentRoot).toBe(expectedCurrentRoot);
        const beforeRoot: any = currentRoot;
        currentRoot = targetRoot;
        commitSequence += 1;
        const eventHash: any = `event-hash-${commitSequence}`;
        stateEvents.push({ eventId: `event-${commitSequence}`, eventHash, operationId, payload, afterRoot: targetRoot });
        return {
          commitId: `compensation-${commitSequence}`,
          eventHash,
          beforeRoot,
          afterRoot: targetRoot,
          contentRefs: [],
          indexRoots: {}
        };
      });
      await fs.writeFile(path.join(workspacePath, "docs", "note.txt"), "preimage-before-receipt-failure", "utf8");
      failReceiptConstruction = true;
      const failedBindings: Record<string, any> = { runRef: "failed-run", artifactDigest: sha256("failed-artifact"), outputDigest: sha256("failed-output") };
      const receiptFailure: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        operationId: "synthetic.plugin.sandbox.output.commit",
        sandboxBindings: failedBindings,
        sandboxReceiptDigest: sha256(JSON.stringify(failedBindings)),
        previewDigest: sha256("failed-preview"),
        approvalBindingDigest: sha256("failed-approval"),
        snapshot: {
          basePath: "docs",
          deleteExtraneous: false,
          files: [{ path: "note.txt", contentCid: "cid-note", contentSha256: sha256("restored-from-cas") }]
        }
      });
      expect(receiptFailure).toMatchObject({ ok: false, compensated: true });
      expect(await fs.readFile(path.join(workspacePath, "docs", "note.txt"), "utf8"))
        .toBe("preimage-before-receipt-failure");
      expect(currentRoot).toBe(rootBeforeFailedReceipt);
      expect(stateEvents).toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({
          action: "files.restore.compensation",
          failedCommitId
        })
      }));
      expect(await runtime.getWorkspaceSandboxMutationReceipt({
        workspaceId: workspace.workspaceId,
        commitId: failedCommitId
      })).toMatchObject({ ok: false, status: 409 });
      expect(await fs.access(path.join(workspacePath, "docs", "obsolete.txt")).then(() : any => true).catch(() : any => false)).toBe(false);

      expect(await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        snapshot: {
          files: [{ path: "docs/.hidden", content: "x" }]
        }
      })).toMatchObject({
        ok: false,
        status: 400,
        error: "不允许恢复以 . 开头的文件。"
      });
    }, { merkleState, checkpointTreeApi });
  });

  it("validates opaque content handles sequentially", async () : Promise<any> => {
    await withWorkspaceRuntime(async (runtime?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Opaque Content Handle Workspace" }).workspace;
      let activeReads: any = 0;
      let maxActiveReads: any = 0;
      const readCounts: any = new Map<any, any>();
      const contentHandle: any = (name?: any, content?: any) : any => ({
        async read() : Promise<any> {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          readCounts.set(name, Number(readCounts.get(name) || 0) + 1);
          await new Promise((resolve?: any) : any => setTimeout(resolve, 2));
          activeReads -= 1;
          return Buffer.from(content);
        }
      });
      const files: any[] = [
        { path: "imports/a.txt", content: Buffer.from("alpha") },
        { path: "imports/b.txt", content: Buffer.from("beta") },
        { path: "imports/c.txt", content: Buffer.from("gamma") }
      ];

      const restored: any = await runtime.restoreWorkspaceFiles({
        workspaceId: workspace.workspaceId,
        operationId: "jobs.upload_workspace_materialize:opaque-handles",
        dryRun: true,
        files: files.map(({ path: filePath, content }: Record<string, any>) : any => ({
          path: filePath,
          exists: true,
          contentHandle: contentHandle(filePath, content),
          contentSha256: sha256(content),
          byteLength: content.length,
          encoding: "binary"
        }))
      });

      expect(restored.ok, JSON.stringify(restored)).toBe(true);
      expect(restored).toMatchObject({
        ok: true,
        dryRun: true,
        summary: { applied: 0 }
      });
      expect(maxActiveReads).toBe(1);
      expect([...readCounts.values()]).toEqual([1, 1, 1]);
    });
  });

  it("starts checkpoint trees when needed and reports null session context after the workspace is removed", async () : Promise<any> => {
    const merkleState: Record<string, any> = {
      protocolVersion: "fixture.merkle.1",
      cas: {
        putBlock: vi.fn(async (content?: any) : Promise<any> => {
          const buffer: any = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
          return {
            cid: `cid-${buffer.length}`,
            byteLength: buffer.length,
            payloadHash: sha256(buffer.toString("utf8"))
          };
        })
      },
      merkleDag: {
        buildManifest: vi.fn(async (kind?: any, entries?: any) : Promise<any> => ({
          rootCid: `${kind}-root-${entries.length}`
        }))
      },
      stateCommit: {
        commit: vi.fn(async ({ mutations, contentRefs }: Record<string, any>) : Promise<any> => ({
          commitId: `commit-${mutations.length}-${contentRefs.length}`,
          eventHash: "event-hash",
          beforeRoot: "",
          afterRoot: "after-root",
          contentRefs,
          indexRoots: {}
        }))
      }
    };

    const checkpointTreeApi: Record<string, any> = {
      checkpointTreeId: vi.fn(() : any => "tree-1"),
      loadCheckpointTree: vi.fn(async () : Promise<any> => null),
      startCheckpointTree: vi.fn(async () : Promise<any> => ({ started: true })),
      upsertCheckpointNode: vi.fn(async () : Promise<any> => ({ ok: true }))
    };

    const noUpsertCheckpointTreeApi: Record<string, any> = {
      checkpointTreeId: vi.fn(() : any => "tree-2"),
      loadCheckpointTree: vi.fn(async () : Promise<any> => null),
      startCheckpointTree: vi.fn(async () : Promise<any> => ({ started: true }))
    };

    await withWorkspaceRuntime(async (runtime?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Checkpoint Workspace" }).workspace;
      const created: any = await runtime.createWorkspaceFolder({
        workspaceId: workspace.workspaceId,
        folderPath: "docs"
      });

      expect(created).toMatchObject({
        ok: true,
        checkpoint: {
          treeId: "tree-1",
          nodeId: expect.stringContaining("commit:")
        }
      });
      expect(checkpointTreeApi.startCheckpointTree).toHaveBeenCalledTimes(1);
      expect(checkpointTreeApi.upsertCheckpointNode).toHaveBeenCalledTimes(1);
    }, { merkleState, checkpointTreeApi });

    await withWorkspaceRuntime(async (runtime?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "No Upsert Checkpoint Workspace" }).workspace;
      const created: any = await runtime.createWorkspaceFolder({
        workspaceId: workspace.workspaceId,
        folderPath: "docs"
      });

      expect(created).toMatchObject({
        ok: true,
        checkpoint: null
      });
      expect(noUpsertCheckpointTreeApi.startCheckpointTree).toHaveBeenCalledTimes(1);
    }, { merkleState, checkpointTreeApi: noUpsertCheckpointTreeApi });

    await withWorkspaceRuntime(async (runtime?: any, root?: any) : Promise<any> => {
      const workspace: any = runtime.createWorkspace({ title: "Session Context Delete Workspace" }).workspace;
      const workspacePath: any = workspaceFolderPath(root, workspace.workspaceId);
      const session: any = runtime.createSession({
        workspaceId: workspace.workspaceId,
        title: "Session To Lose Workspace"
      }).session;

      expect(runtime.getSessionContext(session.sessionId)).toMatchObject({
        sessionId: session.sessionId,
        workspaceId: workspace.workspaceId
      });

      expect(runtime.deleteWorkspace(workspace.workspaceId)).toMatchObject({
        ok: true
      });
      expect(runtime.getSessionContext(session.sessionId)).toBeNull();
      await expect(fs.access(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
