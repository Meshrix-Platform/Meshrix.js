import { computed, ref, watch, type Ref } from 'vue';
import { usePageRefreshHandler } from "@lico/ui-console/page-refresh";
import type { WsSession, WsWorkspace } from '../types/workspaces';
import { errorMessage } from '@lico/ui-console/error-message';
import * as workspacesClient from '../lib/workspaces-client';
import {
  confirmConsoleAction,
  copyConsoleTextWithFeedback,
} from './console-browser-effects';
import { useWorkspaceAssetController } from './console-workspace-asset-controller';
import { useWorkspaceCheckpointController } from './console-workspace-checkpoint-controller';
import { formatCompactDate } from './console-format-utils';
import {
  useWorkspaceManagementController,
  type WorkspacePanel,
} from './console-workspace-management-controller';
import { useWorkspaceSelectionController } from './console-workspace-selection-controller';
import { useWorkspaceSessionController } from './console-workspace-session-controller';

type WorkspacesConsoleOptions = {
  autoload?: boolean;
  globalBusyKey?: Ref<string>;
};

export function useWorkspacesConsole(options: WorkspacesConsoleOptions = {}) {
  const globalBusyKey = options.globalBusyKey ?? ref('');
  const localBusyKey = ref('');
  const busyKey = computed(() => localBusyKey.value || globalBusyKey.value);

  const workspaces        = ref<WsWorkspace[]>([]);
  const sessions          = ref<WsSession[]>([]);
  const selectedId        = ref('');
  const expandedWorkspaceId = ref('');
  const chainData         = ref<any>(null);
  const contextData       = ref<any>(null);
  const workspaceFilesData = ref<any>(null);
  const localError        = ref('');
  const panel             = ref<WorkspacePanel>('list');
  const selection = useWorkspaceSelectionController({
    workspaces,
    selectedId,
    panel,
    expandedWorkspaceId,
  });

  const {
    workspaceAssetData,
    workspaceAssetDetail,
    workspaceAssetResult,
    workspaceAuditItems,
    workspaceAssetForm,
    workspaceAssetItems,
    workspaceOperationHistory,
    workspaceOperationRevertPreview,
    selectedWorkspaceAsset,
    resetWorkspaceAssetState,
    openWorkspaceAssets: prepareWorkspaceAssetsPanel,
    refreshWorkspaceAssets,
    selectWorkspaceAsset,
    submitWorkspaceAsset,
    loadWorkspaceAssetReceipts,
    backfillWorkspaceAssets,
    loadWorkspaceOperationHistory,
    previewWorkspaceOperationRevert,
    applyWorkspaceOperationRevert,
  } = useWorkspaceAssetController({
    selectedId,
    localError,
    setBusy,
    clearBusy,
    confirmAction: confirmConsoleAction,
  });

  const {
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
  } = useWorkspaceCheckpointController({
    selectedId,
    localError,
    setBusy,
    clearBusy,
    confirmAction: confirmConsoleAction,
    reloadWorkspaceChain,
  });

  const {
    createForm,
    createWorkspace,
    deleteWorkspace,
    hotSwapProfile,
    openParent,
    openProfile,
    parentForm,
    profileForm,
    setParent,
    shareForm,
    shareOrUnshare,
  } = useWorkspaceManagementController({
    selectedId,
    panel,
    localError,
    setBusy,
    clearBusy,
    confirmAction: confirmConsoleAction,
    load,
    loadChain,
  });

  const {
    selectedSessionId,
    selectedSession,
    sessionContextData,
    sessionItems,
    selectSession,
    forkSession,
  } = useWorkspaceSessionController({
    sessions,
    selectedId,
    busyKey,
    localError,
    formatCompactDate,
    setBusy,
    clearBusy,
    reloadWorkspaceList: load,
  });

  async function load() {
    setBusy('ws:load');
    localError.value = '';
    try {
      const [workspaceData, sessionData] = await Promise.all([
        workspacesClient.listWorkspaceSummaries(),
        workspacesClient.listWorkspaceSessions(),
      ]);
      workspaces.value = workspaceData.workspaces ?? [];
      sessions.value = sessionData.sessions ?? [];
    } catch (e: unknown) { localError.value = errorMessage(e); }
    finally { clearBusy(); }
  }

  async function loadChain(id: string) {
    chainData.value = null; contextData.value = null; workspaceFilesData.value = null;
    resetWorkspaceAssetState();
    resetWorkspaceCheckpoints();
    try {
      const bundle = await workspacesClient.getWorkspaceChainBundle(id);
      chainData.value = bundle.chain;
      contextData.value = bundle.context;
      workspaceFilesData.value = bundle.files;
      await loadWorkspaceCheckpoints(id);
    } catch (e: unknown) { localError.value = errorMessage(e); }
  }

  async function reloadWorkspaceChain() {
    if (selectedId.value) {
      await loadChain(selectedId.value);
    }
  }

  function showListPanel() {
    panel.value = 'list';
  }

  watch(selectedId, (id) => {
    if (id) {
      if (panel.value === 'list') expandedWorkspaceId.value = id;
      loadChain(id);
    } else {
      expandedWorkspaceId.value = '';
    }
  });

  watch(panel, (next) => {
    if (next === 'list') {
      if (selectedId.value) expandedWorkspaceId.value = selectedId.value;
    } else {
      expandedWorkspaceId.value = '';
    }
  });

  function openLocalDir() {
    panel.value = 'localDir';
  }

  async function openWorkspaceAssets() {
    panel.value = await prepareWorkspaceAssetsPanel();
  }

  // busyKey helpers (work on the existing string-compat ref)
  function setBusy(k: string)  { localBusyKey.value = k; }
  function clearBusy()         { localBusyKey.value = ''; }

  async function copyToClipboard(event: MouseEvent, text: string) {
    if (!text) return;
    try {
      await copyConsoleTextWithFeedback(event, text);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  usePageRefreshHandler(
    (detail) => detail.viewId === 'workspaces',
    async () => {
      await load();
      if (selectedId.value) {
        await loadChain(selectedId.value);
      }
    },
  );

  if (options.autoload ?? true) {
    load();
  }

  return {
    busyKey,
    formatCompactDate,
    workspaces,
    sessions,
    selectedId,
    expandedWorkspaceId,
    selectedSessionId,
    selectedSession,
    chainData,
    contextData,
    workspaceFilesData,
    workspaceAssetData,
    workspaceAssetDetail,
    workspaceAssetResult,
    workspaceAuditItems,
    workspaceAssetForm,
    workspaceAssetItems,
    workspaceOperationHistory,
    workspaceOperationRevertPreview,
    selectedWorkspaceAsset,
    workspaceCheckpointTrees,
    workspaceCheckpointDetail,
    workspaceCheckpointPreview,
    workspaceCheckpointError,
    selectedCheckpointTreeId,
    selectedCheckpointNodeId,
    sessionContextData,
    localError,
    panel,
    createForm,
    profileForm,
    parentForm,
    shareForm,
    ...selection,
    workspaceCheckpointNodes,
    workspaceCheckpointPreviewRestore,
    sessionItems,
    checkpointNodeFileCount,
    checkpointNodeBasePath,
    load,
    loadChain,
    loadWorkspaceCheckpoints,
    loadWorkspaceCheckpointTree,
    previewWorkspaceCheckpointRestore,
    restoreWorkspaceCheckpoint,
    selectSession,
    forkSession,
    createWorkspace,
    deleteWorkspace,
    setParent,
    hotSwapProfile,
    shareOrUnshare,
    openProfile,
    openParent,
    openLocalDir,
    openWorkspaceAssets,
    refreshWorkspaceAssets,
    selectWorkspaceAsset,
    submitWorkspaceAsset,
    loadWorkspaceAssetReceipts,
    backfillWorkspaceAssets,
    loadWorkspaceOperationHistory,
    previewWorkspaceOperationRevert,
    applyWorkspaceOperationRevert,
    copyToClipboard,
  };
}
