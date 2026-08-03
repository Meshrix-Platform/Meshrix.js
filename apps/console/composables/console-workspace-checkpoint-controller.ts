import { computed, ref, type Ref } from "vue";
import { errorMessage } from "@meshrix/ui-console/error-message";
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
  clearBusy: (key: string) => void;
  confirmAction: ConsoleConfirmAction;
  reloadWorkspaceChain: () => Promise<void>;
};

function workspaceSnapshotNodes(tree: WsCheckpointTreeDetail | null) : any {
  return (Object.values(tree?.nodes ?? {}) as any[])
    .filter((node?: any) : any => !!node?.metadata?.workspaceFileSnapshot)
    .sort((left?: any, right?: any) : any =>
      String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")),
    );
}

export function useWorkspaceCheckpointController(options: WorkspaceCheckpointControllerOptions) : any {
  const workspaceCheckpointTrees: any = ref<WsCheckpointTreeSummary[]>([]);
  const workspaceCheckpointDetail: any = ref<WsCheckpointTreeDetail | null>(null);
  const workspaceCheckpointPreview: any = ref<WorkspaceConsolePayload | null>(null);
  const workspaceCheckpointError: any = ref("");
  const selectedCheckpointTreeId: any = ref("");
  const selectedCheckpointNodeId: any = ref("");

  const workspaceCheckpointNodes: any = computed<WsCheckpointNode[]>(() : any =>
    workspaceSnapshotNodes(workspaceCheckpointDetail.value),
  );
  const workspaceCheckpointPreviewRestore: any = computed(() : any =>
    workspaceCheckpointPreview.value?.workspaceFileRestore ?? null,
  );

  function resetWorkspaceCheckpoints() : any {
    workspaceCheckpointTrees.value = [];
    workspaceCheckpointDetail.value = null;
    workspaceCheckpointPreview.value = null;
    workspaceCheckpointError.value = "";
    selectedCheckpointTreeId.value = "";
    selectedCheckpointNodeId.value = "";
  }

  async function loadWorkspaceCheckpoints(id: string) : Promise<any> {
    workspaceCheckpointError.value = "";
    workspaceCheckpointPreview.value = null;
    workspaceCheckpointDetail.value = null;
    selectedCheckpointTreeId.value = "";
    selectedCheckpointNodeId.value = "";
    try {
      const data: any = await workspacesClient.listWorkspaceCheckpointTrees(id);
      workspaceCheckpointTrees.value = data.items ?? [];
      const firstTreeId: any = workspaceCheckpointTrees.value[0]?.treeId || "";
      if (firstTreeId) {
        await loadWorkspaceCheckpointTree(firstTreeId);
      }
    } catch (e: unknown) {
      workspaceCheckpointTrees.value = [];
      workspaceCheckpointError.value = errorMessage(e, "读取文件回退点失败。");
    }
  }

  async function loadWorkspaceCheckpointTree(treeId: string) : Promise<any> {
    if (!treeId) return;
    workspaceCheckpointError.value = "";
    workspaceCheckpointPreview.value = null;
    selectedCheckpointTreeId.value = treeId;
    selectedCheckpointNodeId.value = "";
    try {
      const tree: any = await workspacesClient.getWorkspaceCheckpointTree(treeId);
      workspaceCheckpointDetail.value = tree;
      selectedCheckpointNodeId.value = workspaceSnapshotNodes(tree)[0]?.nodeId || "";
    } catch (e: unknown) {
      workspaceCheckpointDetail.value = null;
      workspaceCheckpointError.value = errorMessage(e, "读取 checkpoint tree 失败。");
    }
  }

  async function previewWorkspaceCheckpointRestore(nodeId: any = selectedCheckpointNodeId.value) : Promise<any> {
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
    finally { options.clearBusy("ws:checkpoint-preview"); }
  }

  async function restoreWorkspaceCheckpoint(nodeId: any = selectedCheckpointNodeId.value) : Promise<any> {
    if (!options.selectedId.value || !selectedCheckpointTreeId.value || !nodeId) return;
    const ok: any = await options.confirmAction(
      "确认将该工作空间的物理文件夹回退到所选 checkpoint？当前文件差异会被 checkpoint restore 覆盖。",
      { tone: "danger" },
    );
    if (!ok) return;
    options.setBusy("ws:checkpoint-restore");
    options.localError.value = "";
    workspaceCheckpointError.value = "";
    try {
      selectedCheckpointNodeId.value = nodeId;
      const restored: any = await workspacesClient.restoreWorkspaceCheckpointRequest({
        treeId: selectedCheckpointTreeId.value,
        nodeId,
        workspaceId: options.selectedId.value,
        reason: "console workspace file rollback",
      });
      await options.reloadWorkspaceChain();
      workspaceCheckpointPreview.value = restored;
      selectedCheckpointNodeId.value = nodeId;
    } catch (e: unknown) { workspaceCheckpointError.value = errorMessage(e); }
    finally { options.clearBusy("ws:checkpoint-restore"); }
  }

  function checkpointNodeFileCount(node: WsCheckpointNode) : any {
    const files: any = node.metadata?.workspaceFileSnapshot?.files;
    return Array.isArray(files) ? files.length : 0;
  }

  function checkpointNodeBasePath(node: WsCheckpointNode) : any {
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
