import { computed, ref, type Ref } from "vue";
import { errorMessage } from "@lico/ui-console/error-message";
import * as workspacesClient from "../lib/workspaces-client";
import type { WorkspaceConsolePayload } from "../lib/workspaces-client";
import type { ConsoleConfirmAction } from "./console-confirm-controller";
import type {
  WsCheckpointNode,
  WsCheckpointTreeDetail,
  WsCheckpointTreeSummary,
} from "../types/workspaces";

type WorkspaceCheckpointControllerOptions = {
  selectedId: Ref<string>;
  localError: Ref<string>;
  setBusy: (key: string) => void;
  clearBusy: () => void;
  confirmAction: ConsoleConfirmAction;
  reloadWorkspaceChain: () => Promise<void>;
};

function workspaceSnapshotNodes(tree: WsCheckpointTreeDetail | null) {
  return Object.values(tree?.nodes ?? {})
    .filter((node) => !!node?.metadata?.workspaceFileSnapshot)
    .sort((left, right) =>
      String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")),
    );
}

export function useWorkspaceCheckpointController(options: WorkspaceCheckpointControllerOptions) {
  const workspaceCheckpointTrees = ref<WsCheckpointTreeSummary[]>([]);
  const workspaceCheckpointDetail = ref<WsCheckpointTreeDetail | null>(null);
  const workspaceCheckpointPreview = ref<WorkspaceConsolePayload | null>(null);
  const workspaceCheckpointError = ref("");
  const selectedCheckpointTreeId = ref("");
  const selectedCheckpointNodeId = ref("");

  const workspaceCheckpointNodes = computed<WsCheckpointNode[]>(() =>
    workspaceSnapshotNodes(workspaceCheckpointDetail.value),
  );
  const workspaceCheckpointPreviewRestore = computed(() =>
    workspaceCheckpointPreview.value?.workspaceFileRestore ?? null,
  );

  function resetWorkspaceCheckpoints() {
    workspaceCheckpointTrees.value = [];
    workspaceCheckpointDetail.value = null;
    workspaceCheckpointPreview.value = null;
    workspaceCheckpointError.value = "";
    selectedCheckpointTreeId.value = "";
    selectedCheckpointNodeId.value = "";
  }

  async function loadWorkspaceCheckpoints(id: string) {
    workspaceCheckpointError.value = "";
    workspaceCheckpointPreview.value = null;
    workspaceCheckpointDetail.value = null;
    selectedCheckpointTreeId.value = "";
    selectedCheckpointNodeId.value = "";
    try {
      const data = await workspacesClient.listWorkspaceCheckpointTrees(id);
      workspaceCheckpointTrees.value = data.items ?? [];
      const firstTreeId = workspaceCheckpointTrees.value[0]?.treeId || "";
      if (firstTreeId) {
        await loadWorkspaceCheckpointTree(firstTreeId);
      }
    } catch (e: unknown) {
      workspaceCheckpointTrees.value = [];
      workspaceCheckpointError.value = errorMessage(e, "读取文件回退点失败。");
    }
  }

  async function loadWorkspaceCheckpointTree(treeId: string) {
    if (!treeId) return;
    workspaceCheckpointError.value = "";
    workspaceCheckpointPreview.value = null;
    selectedCheckpointTreeId.value = treeId;
    selectedCheckpointNodeId.value = "";
    try {
      const tree = await workspacesClient.getWorkspaceCheckpointTree(treeId);
      workspaceCheckpointDetail.value = tree;
      selectedCheckpointNodeId.value = workspaceSnapshotNodes(tree)[0]?.nodeId || "";
    } catch (e: unknown) {
      workspaceCheckpointDetail.value = null;
      workspaceCheckpointError.value = errorMessage(e, "读取 checkpoint tree 失败。");
    }
  }

  async function previewWorkspaceCheckpointRestore(nodeId = selectedCheckpointNodeId.value) {
    if (!options.selectedId.value || !selectedCheckpointTreeId.value || !nodeId) return;
    options.setBusy("ws:checkpoint-preview");
    options.localError.value = "";
    workspaceCheckpointError.value = "";
    try {
      selectedCheckpointNodeId.value = nodeId;
      workspaceCheckpointPreview.value = await workspacesClient.previewWorkspaceCheckpointRestoreRequest({
        treeId: selectedCheckpointTreeId.value,
        nodeId,
        workspaceId: options.selectedId.value,
        reason: "console workspace file rollback preview",
      });
    } catch (e: unknown) { workspaceCheckpointError.value = errorMessage(e); }
    finally { options.clearBusy(); }
  }

  async function restoreWorkspaceCheckpoint(nodeId = selectedCheckpointNodeId.value) {
    if (!options.selectedId.value || !selectedCheckpointTreeId.value || !nodeId) return;
    const ok = await options.confirmAction(
      "确认将该工作空间的物理文件夹回退到所选 checkpoint？当前文件差异会被 checkpoint restore 覆盖。",
      { tone: "danger" },
    );
    if (!ok) return;
    options.setBusy("ws:checkpoint-restore");
    options.localError.value = "";
    workspaceCheckpointError.value = "";
    try {
      selectedCheckpointNodeId.value = nodeId;
      const restored = await workspacesClient.restoreWorkspaceCheckpointRequest({
        treeId: selectedCheckpointTreeId.value,
        nodeId,
        workspaceId: options.selectedId.value,
        reason: "console workspace file rollback",
      });
      await options.reloadWorkspaceChain();
      workspaceCheckpointPreview.value = restored;
      selectedCheckpointNodeId.value = nodeId;
    } catch (e: unknown) { workspaceCheckpointError.value = errorMessage(e); }
    finally { options.clearBusy(); }
  }

  function checkpointNodeFileCount(node: WsCheckpointNode) {
    const files = node.metadata?.workspaceFileSnapshot?.files;
    return Array.isArray(files) ? files.length : 0;
  }

  function checkpointNodeBasePath(node: WsCheckpointNode) {
    return String(node.metadata?.workspaceFileSnapshot?.basePath || "根目录");
  }

  return {
    workspaceCheckpointTrees,
    workspaceCheckpointDetail,
    workspaceCheckpointPreview,
    workspaceCheckpointError,
    selectedCheckpointTreeId,
    selectedCheckpointNodeId,
    workspaceCheckpointNodes,
    workspaceCheckpointPreviewRestore,
    resetWorkspaceCheckpoints,
    loadWorkspaceCheckpoints,
    loadWorkspaceCheckpointTree,
    previewWorkspaceCheckpointRestore,
    restoreWorkspaceCheckpoint,
    checkpointNodeFileCount,
    checkpointNodeBasePath,
  };
}
