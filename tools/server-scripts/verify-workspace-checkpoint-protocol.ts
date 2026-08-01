import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkpointTreeId,
  loadCheckpointTree,
  startCheckpointTree,
  upsertCheckpointNode
} from "#meshrix/foundation/checkpoint/tree/checkpoint-tree-projection";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { authHeaders, installAuthenticatedFetch } from "./test-auth-helper.ts";

async function fetchJson(url?: any, options: Record<string, any> = {}) : Promise<any> {
  const response: any = await fetch(url, options);
  const text: any = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    payload: text.trim() ? JSON.parse(text) : {}
  };
}

async function rpc(server?: any, auth?: any, method?: any, params: Record<string, any> = {}, id: any = method) : Promise<any> {
  const response: any = await fetchJson(`${server.url}/api/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(auth, { method: "POST" })
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload, null, 2));
  assert.equal(response.payload.error, undefined, JSON.stringify(response.payload.error || {}, null, 2));
  return response.payload.result;
}

async function removeTempTree(targetPath?: any) : Promise<any> {
  for (let attempt: any = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 4) {
        return;
      }
      await new Promise((resolve?: any) : any => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-workspace-checkpoint-protocol-"));
const treeId: any = checkpointTreeId("workspace-protocol", "verify");

await startCheckpointTree({
  userDataPath,
  treeId,
  kind: "workspace_protocol_verify",
  ownerId: "workspace-verify",
  rootNodeId: "root",
  rootLabel: "Workspace checkpoint protocol verification",
  resumePolicy: {
    mode: "protocol-restore-marker",
    idempotencyKey: "treeId+nodeId"
  }
});
await upsertCheckpointNode({
  userDataPath,
  treeId,
  nodeId: "extract",
  parentId: "root",
  label: "Extract",
  status: "completed",
  cursor: { offset: 1 },
  totals: { files: 1 }
});
await upsertCheckpointNode({
  userDataPath,
  treeId,
  nodeId: "transform",
  parentId: "root",
  label: "Transform",
  status: "running",
  cursor: { offset: 2 },
  totals: { files: 2 }
});

const server: any = await startHttpServer({
  userDataPath,
  distPath: "",
  port: 0,
  runtimeOptions: {
    profile: "minimal"
  }
});

try {
  const auth: any = await installAuthenticatedFetch(server);
  const createdWorkspace: any = await rpc(server, auth, "agent_workspaces.create", {
    title: "Workspace checkpoint restore verification",
    objective: "Verify checkpoint restore can delegate file rollback to the workspace provider"
  });
  const workspaceId: any = createdWorkspace.workspace.workspaceId;
  const initialUpload: any = await rpc(server, auth, "agent_workspaces.file.upload", {
    workspaceId,
    path: "docs/state.txt",
    content: "OpenClaw line"
  });
  assert.ok(initialUpload.stateCommit?.commitId);
  assert.ok(initialUpload.checkpoint?.treeId);
  assert.ok(initialUpload.checkpoint?.nodeId);

  const diff: any = await rpc(server, auth, "workspace.checkpoint.diff", {
    treeId,
    fromNodeId: "extract",
    toNodeId: "transform"
  });
  assert.equal(diff.ok, true);
  assert.equal(diff.changed, true);
  assert.ok(diff.changes.some((item?: any) : any => item.field === "cursor"));

  const scope: any = await rpc(server, auth, "workspace.checkpoint.scope.query", {
    treeId,
    nodeId: "root"
  });
  assert.equal(scope.ok, true);
  assert.equal(scope.affectedNodeCount, 3);
  assert.equal(scope.byStatus.completed, 1);
  assert.equal(scope.byStatus.running, 2);

  const preview: any = await rpc(server, auth, "workspace.checkpoint.restore.preview", {
    treeId,
    nodeId: "extract",
    reason: "verify restore preview"
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.canApply, true);

  const restored: any = await rpc(server, auth, "workspace.checkpoint.restore", {
    treeId,
    nodeId: "extract",
    reason: "verify restore"
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.applied, true);
  assert.ok(restored.restoreId);
  assert.ok(restored.markerNodeId);

  const tree: any = await loadCheckpointTree({ userDataPath, treeId });
  assert.equal(tree?.metadata?.lastRestore?.restoreId, restored.restoreId);
  assert.ok(tree?.events?.some((event?: any) : any => event.type === "checkpoint.restored"));
  assert.ok(tree?.nodes?.[restored.markerNodeId]);

  await upsertCheckpointNode({
    userDataPath,
    treeId,
    nodeId: "file-snapshot",
    parentId: "root",
    label: "Workspace file snapshot",
    status: "completed",
    metadata: {
      workspaceFileSnapshot: {
        workspaceId,
        basePath: "docs",
        deleteExtraneous: true,
        files: [
          {
            path: "state.txt",
            content: "OpenClaw line",
            encoding: "utf8"
          }
        ]
      }
    }
  });
  await rpc(server, auth, "agent_workspaces.file.write", {
    workspaceId,
    path: "docs/state.txt",
    content: "OpenClaw line\nHermes line"
  });
  await rpc(server, auth, "agent_workspaces.file.upload", {
    workspaceId,
    path: "docs/extra.txt",
    content: "remove me"
  });

  const autoPreview: any = await rpc(server, auth, "workspace.checkpoint.restore.preview", {
    treeId: initialUpload.checkpoint.treeId,
    nodeId: initialUpload.checkpoint.nodeId,
    workspaceId,
    reason: "verify automatic file checkpoint restore preview"
  });
  assert.equal(autoPreview.ok, true);
  assert.equal(autoPreview.workspaceFileRestore.ok, true);
  assert.ok(autoPreview.workspaceFileRestore.actions.some((item?: any) : any => item.action === "write" && item.path === "docs/state.txt"));
  assert.ok(autoPreview.workspaceFileRestore.actions.some((item?: any) : any => item.action === "delete" && item.path === "docs/extra.txt"));

  const autoRestore: any = await rpc(server, auth, "workspace.checkpoint.restore", {
    treeId: initialUpload.checkpoint.treeId,
    nodeId: initialUpload.checkpoint.nodeId,
    workspaceId,
    reason: "verify automatic file checkpoint restore"
  });
  assert.equal(autoRestore.ok, true);
  assert.equal(autoRestore.workspaceFileRestore.ok, true);
  assert.ok(autoRestore.workspaceFileRestore.stateCommit?.commitId);

  const autoRestoredFile: any = await rpc(server, auth, "agent_workspaces.file.download", {
    workspaceId,
    path: "docs/state.txt"
  });
  assert.equal(autoRestoredFile.content, "OpenClaw line");
  const autoRemovedFile: any = await rpc(server, auth, "agent_workspaces.file.stat", {
    workspaceId,
    path: "docs/extra.txt"
  });
  assert.equal(autoRemovedFile.exists, false);

  await rpc(server, auth, "agent_workspaces.file.write", {
    workspaceId,
    path: "docs/state.txt",
    content: "OpenClaw line\nHermes line"
  });
  await rpc(server, auth, "agent_workspaces.file.upload", {
    workspaceId,
    path: "docs/extra.txt",
    content: "remove me"
  });

  const filePreview: any = await rpc(server, auth, "workspace.checkpoint.restore.preview", {
    treeId,
    nodeId: "file-snapshot",
    workspaceId,
    reason: "verify file restore preview"
  });
  assert.equal(filePreview.ok, true);
  assert.equal(filePreview.workspaceFileRestore.ok, true);
  assert.equal(filePreview.workspaceFileRestore.dryRun, true);
  assert.ok(filePreview.workspaceFileRestore.actions.some((item?: any) : any => item.action === "write" && item.path === "docs/state.txt"));
  assert.ok(filePreview.workspaceFileRestore.actions.some((item?: any) : any => item.action === "delete" && item.path === "docs/extra.txt"));

  const fileRestore: any = await rpc(server, auth, "workspace.checkpoint.restore", {
    treeId,
    nodeId: "file-snapshot",
    workspaceId,
    reason: "verify file restore"
  });
  assert.equal(fileRestore.ok, true);
  assert.equal(fileRestore.applied, true);
  assert.equal(fileRestore.workspaceFileRestore.ok, true);
  assert.equal(fileRestore.workspaceFileRestore.dryRun, false);
  assert.ok(fileRestore.workspaceFileRestore.appliedActions.some((item?: any) : any => item.action === "write" && item.path === "docs/state.txt"));
  assert.ok(fileRestore.workspaceFileRestore.appliedActions.some((item?: any) : any => item.action === "delete" && item.path === "docs/extra.txt"));

  const restoredFile: any = await rpc(server, auth, "agent_workspaces.file.download", {
    workspaceId,
    path: "docs/state.txt"
  });
  assert.equal(restoredFile.content, "OpenClaw line");
  const removedFile: any = await rpc(server, auth, "agent_workspaces.file.stat", {
    workspaceId,
    path: "docs/extra.txt"
  });
  assert.equal(removedFile.exists, false);

  const revertScope: any = await rpc(server, auth, "workspace.operation.revert.scope", {
    workspaceId,
    operationId: "workspace.checkpoint.restore",
    limit: 20
  });
  assert.equal(revertScope.ok, true);
  assert.equal(revertScope.canApply, true);
  assert.ok(revertScope.scope.some((item?: any) : any => item.operationId === "workspace.checkpoint.restore"));
  assert.ok(revertScope.actions.some((item?: any) : any => item.action === "preview_revert_checkpoint_restore"));
  assert.ok(revertScope.revert?.workspaceFileRestore?.dryRun);

  console.log("workspace checkpoint protocol verification passed");
} finally {
  await server.close();
  await removeTempTree(userDataPath);
}
