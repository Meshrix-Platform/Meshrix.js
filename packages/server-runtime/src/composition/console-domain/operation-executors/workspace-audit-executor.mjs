
import { actorFrom, objectOrNull, protocolPayload, result } from "./shared.mjs";
import { runCheckpointWorkspaceFileRestore } from "./workspace-runtime-helpers.mjs";

export function checkpointNodeTimestamp(node = {}) {
  const parsed = Date.parse(node.completedAt || node.updatedAt || node.startedAt || node.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function checkpointNodeSnapshot(node = null) {
  const metadata = objectOrNull(node?.metadata) || {};
  return objectOrNull(metadata.workspaceFileSnapshot) || objectOrNull(metadata.fileSnapshot) || null;
}

export function checkpointNodePreimageSnapshot(node = null) {
  const metadata = objectOrNull(node?.metadata) || {};
  return objectOrNull(metadata.workspaceFilePreimageSnapshot) || objectOrNull(metadata.filePreimageSnapshot) || null;
}

export function workspaceCheckpointNodes(tree = {}) {
  return Object.values(objectOrNull(tree.nodes) || {})
    .filter((node) =>
      node &&
      typeof node === "object" &&
      !String(node.nodeId || "").startsWith("restore:") &&
      checkpointNodeSnapshot(node)
    )
    .sort((left, right) =>
      checkpointNodeTimestamp(left) - checkpointNodeTimestamp(right) ||
      String(left.nodeId || "").localeCompare(String(right.nodeId || ""))
    );
}

export function publicRevertNode(node = null) {
  if (!node) {
    return null;
  }
  const metadata = objectOrNull(node.metadata) || {};
  const snapshot = checkpointNodeSnapshot(node) || {};
  const preimageSnapshot = checkpointNodePreimageSnapshot(node) || {};
  return {
    nodeId: String(node.nodeId || ""),
    operationId: String(metadata.operationId || ""),
    action: String(metadata.action || ""),
    path: String(metadata.path || ""),
    commitId: String(metadata.stateCommit?.commitId || ""),
    snapshotFileCount: Array.isArray(snapshot.files) ? snapshot.files.length : 0,
    preimageEntryCount:
      (Array.isArray(preimageSnapshot.files) ? preimageSnapshot.files.length : 0) +
      (Array.isArray(preimageSnapshot.localDirectorySnapshots)
        ? preimageSnapshot.localDirectorySnapshots.reduce(
            (count, localSnapshot) => count + (Array.isArray(localSnapshot?.entries) ? localSnapshot.entries.length : 0),
            0
          )
        : 0),
    updatedAt: String(node.updatedAt || node.completedAt || node.createdAt || "")
  };
}

export async function workspaceOperationRevertPlan({ input = {}, context = {}, dryRun = true, operationId = "" } = {}) {
  const checkpointTreeApi = context.checkpointTreeApi;
  if (!checkpointTreeApi?.loadCheckpointTree) {
    return { ok: false, status: 503, error: "workspace checkpoint tree 接口不可用。" };
  }
  const workspaceId = String(input.workspaceId || input.workspace || input.ownerId || "").trim();
  const treeId = String(input.treeId || input["tree-id"] || "").trim() ||
    (workspaceId && typeof checkpointTreeApi.checkpointTreeId === "function"
      ? checkpointTreeApi.checkpointTreeId("workspace-files", workspaceId)
      : "");
  if (!treeId) {
    return { ok: false, status: 400, error: "revert 需要 workspaceId 或 treeId。" };
  }
  const tree = await checkpointTreeApi.loadCheckpointTree({
    userDataPath: context.userDataPath,
    treeId
  });
  if (!tree) {
    return { ok: false, status: 404, error: "workspace checkpoint tree 不存在。" };
  }
  const requestedNodeId = String(input.nodeId || input["node-id"] || input.checkpointNodeId || "").trim();
  const requestedOperationId = String(operationId || "").trim();
  const nodes = workspaceCheckpointNodes(tree);
  const targetIndex = requestedNodeId
    ? nodes.findIndex((node) => String(node.nodeId || "") === requestedNodeId)
    : nodes.findLastIndex((node) => !requestedOperationId || String(node.metadata?.operationId || "") === requestedOperationId);
  if (targetIndex < 0) {
    return { ok: false, status: 404, error: "未找到可回滚的 workspace checkpoint 节点。" };
  }
  const targetNode = nodes[targetIndex];
  const restoreNode = nodes[targetIndex - 1] || null;
  const targetPreimageSnapshot = checkpointNodePreimageSnapshot(targetNode);
  const restoreSnapshot = targetPreimageSnapshot || checkpointNodeSnapshot(restoreNode) || {
    workspaceId: workspaceId || tree.ownerId || tree.metadata?.workspaceId || "",
    basePath: "",
    deleteExtraneous: true,
    files: []
  };
  const restorePlan = {
    dryRun,
    applied: !dryRun,
    canApply: true,
    treeId,
    nodeId: restoreNode?.nodeId || tree.rootNodeId || "root",
    target: {
      ...(restoreNode || {}),
      metadata: {
        ...(objectOrNull(restoreNode?.metadata) || {}),
        workspaceId: restoreSnapshot.workspaceId || workspaceId || tree.ownerId || "",
        workspaceFileSnapshot: restoreSnapshot
      }
    },
    actions: [{
      action: dryRun ? "preview_workspace_file_restore" : "apply_workspace_file_restore",
      treeId,
      nodeId: restoreNode?.nodeId || tree.rootNodeId || "root",
      targetOperationNodeId: targetNode.nodeId,
      snapshotSource: targetPreimageSnapshot ? "target_preimage" : "previous_checkpoint",
      dryRun
    }]
  };
  const fileRestore = await runCheckpointWorkspaceFileRestore({
    plan: restorePlan,
    input: {
      ...input,
      workspaceId: restoreSnapshot.workspaceId || workspaceId || tree.ownerId || "",
      operationId: dryRun ? "workspace.operation.revert.scope" : "workspace.operation.revert.apply",
      reason: input.reason || "workspace operation revert"
    },
    context,
    dryRun
  });
  if (fileRestore && fileRestore.payload?.ok !== true) {
    return {
      ok: false,
      status: fileRestore.status || 400,
      error: fileRestore.payload?.error || "workspace 文件回滚失败。"
    };
  }
  let markerRestore = null;
  if (!dryRun && typeof checkpointTreeApi.restoreCheckpointTree === "function") {
    markerRestore = await checkpointTreeApi.restoreCheckpointTree({
      userDataPath: context.userDataPath,
      treeId,
      nodeId: restoreNode?.nodeId || tree.rootNodeId || "root",
      actor: actorFrom(context.authSession, input),
      mode: "workspace-operation-revert",
      reason: input.reason || "workspace operation revert"
    }).catch((error) => ({ error: error?.message || String(error) }));
  }
  return {
    ok: true,
    protocolVersion: "v0.0.1:workspace:operation-revert-1",
    dryRun,
    applied: !dryRun,
    treeId,
    targetOperation: publicRevertNode(targetNode),
    restoreCheckpoint: publicRevertNode(restoreNode) || {
      nodeId: tree.rootNodeId || "root",
      operationId: "",
      action: "empty_workspace",
      path: "/",
      commitId: "",
      snapshotFileCount: 0,
      updatedAt: ""
    },
    workspaceFileRestore: fileRestore?.payload || null,
    checkpointMarker: markerRestore,
    actions: restorePlan.actions
  };
}

export function publicWorkspaceAuditActor(actor = {}) {
  return {
    type: String(actor?.type || ""),
    roleId: String(actor?.roleId || "")
  };
}

export function publicWorkspaceAuditItem(item = {}) {
  return {
    auditId: String(item.auditId || ""),
    operationId: String(item.operationId || ""),
    transport: String(item.transport || ""),
    risk: String(item.risk || ""),
    readOnly: item.readOnly === true,
    status: String(item.status || ""),
    durationMs: Math.max(0, Number(item.durationMs || 0) || 0),
    inputHash: String(item.inputHash || ""),
    actor: publicWorkspaceAuditActor(item.actor || {}),
    createdAt: String(item.createdAt || "")
  };
}

export async function executeWorkspaceAuditOperation({ operationId, input = {}, context }) {
  const id = String(operationId || "");
  if (!["workspace.audit.query", "workspace.operation.history", "workspace.operation.revert.scope", "workspace.operation.revert.apply"].includes(id)) {
    return null;
  }

  const items = context.operationAuditStore?.list
    ? context.operationAuditStore.list({
        limit: Number(input.limit || 100),
        operationId: input.operationId || input["operation-id"] || "",
        status: input.status || ""
      })
    : [];
  if (id === "workspace.operation.revert.scope" || id === "workspace.operation.revert.apply") {
    const dryRun = id === "workspace.operation.revert.scope" || input.dryRun === true || input.preview === true;
    const auditId = String(input.auditId || input["audit-id"] || "").trim();
    const selectedItems = auditId
      ? items.filter((item) => item.auditId === auditId)
      : items.slice(0, Math.max(1, Math.min(Number(input.limit || 20), 100)));
    const reversibleItems = selectedItems.filter((item) =>
      item.readOnly !== true &&
      !["denied", "failed", "error"].includes(String(item.status || "").toLowerCase())
    );
    if (dryRun && reversibleItems.length === 0) {
      return result(200, protocolPayload({
        protocolVersion: "v0.0.1:workspace:operation-revert-scope-1",
        requestedAuditId: auditId,
        operationId: input.operationId || input["operation-id"] || "",
        candidateCount: selectedItems.length,
        reversibleCount: 0,
        canApply: false,
        mode: "preview",
        scope: [],
        actions: [],
        revert: null
      }));
    }
    const revertPlan = await workspaceOperationRevertPlan({
      input,
      context,
      dryRun,
      operationId: input.operationId || input["operation-id"] || reversibleItems[0]?.operationId || ""
    });
    if (!revertPlan.ok) {
      return result(revertPlan.status || 400, protocolPayload({
        protocolVersion: "v0.0.1:workspace:operation-revert-1",
        requestedAuditId: auditId,
        operationId: input.operationId || input["operation-id"] || "",
        candidateCount: selectedItems.length,
        reversibleCount: reversibleItems.length,
        canApply: false,
        mode: dryRun ? "preview" : "apply",
        scope: reversibleItems.map((item) => ({
          ...publicWorkspaceAuditItem(item)
        })),
        error: revertPlan.error
      }));
    }
    return result(200, protocolPayload({
      protocolVersion: "v0.0.1:workspace:operation-revert-scope-1",
      requestedAuditId: auditId,
      operationId: input.operationId || input["operation-id"] || "",
      candidateCount: selectedItems.length,
      reversibleCount: reversibleItems.length,
      canApply: reversibleItems.length > 0,
      mode: dryRun ? "preview" : "apply",
      scope: reversibleItems.map((item) => ({
        ...publicWorkspaceAuditItem(item)
      })),
      actions: [
        ...reversibleItems.map((item) => ({
          action: dryRun ? "preview_revert_checkpoint_restore" : "apply_revert_checkpoint_restore",
          auditId: item.auditId,
          operationId: item.operationId
        })),
        ...revertPlan.actions
      ],
      revert: revertPlan
    }));
  }
  return result(200, protocolPayload({ items: items.map(publicWorkspaceAuditItem), count: items.length }));
}
