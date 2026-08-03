import { computed, ref, watch, type Ref } from 'vue';
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import type { WsSession, WsWorkspace } from '../types/workspaces';
import { errorMessage } from '@meshrix/ui-console/error-message';
import * as workspacesClient from '../lib/workspaces-client';
import {
  confirmConsoleAction,
  copyConsoleTextWithFeedback,
} from './console-browser-effects';
import { useWorkspaceAssetController } from './console-workspace-asset-controller';
import { useWorkspaceCheckpointController } from './console-workspace-checkpoint-controller';
import { formatCompactDate } from './console-format-utils';
import {
  createConsoleBusyController,
  mergeConsoleBusyReaders,
  type ConsoleBusyController,
  type ConsoleBusyReader,
} from './console-busy-controller';
import {
  useWorkspaceManagementController,
  type WorkspacePanel,
} from './console-workspace-management-controller';
import { useWorkspaceSelectionController } from './console-workspace-selection-controller';
import { useWorkspaceSessionController } from './console-workspace-session-controller';

type WorkspacesConsoleOptions = {
  autoload?: boolean;
  /** Busy state owned by the surrounding shell, reflected alongside local work. */
  globalBusy?: ConsoleBusyReader;
};

export function useWorkspacesConsole(options: WorkspacesConsoleOptions = {}) : any {
  const localBusy: ConsoleBusyController = createConsoleBusyController();
  const busy: ConsoleBusyReader = options.globalBusy
    ? mergeConsoleBusyReaders(localBusy, options.globalBusy)
    : localBusy;
  const setBusy: (key: string) => void = localBusy.setBusy;
  const clearBusy: (key: string) => void = localBusy.clearBusy;

  const workspaces: any        = ref<WsWorkspace[]>([]);
  const sessions: any          = ref<WsSession[]>([]);
  const selectedId: any        = ref('');
  const expandedWorkspaceId: any = ref('');
  const chainData: any         = ref<any>(null);
  const contextData: any       = ref<any>(null);
  const workspaceFilesData: any = ref<any>(null);
  const localError: any        = ref('');
  const panel: any             = ref<WorkspacePanel>('list');
  const selection: any = useWorkspaceSelectionController({
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
    isBusyPrefix: busy.isBusyPrefix,
    localError,
    formatCompactDate,
    setBusy,
    clearBusy,
    reloadWorkspaceList: load,
  });

  async function load() : Promise<any> {
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
    finally { clearBusy('ws:load'); }
  }

  async function loadChain(id: string) : Promise<any> {
    chainData.value = null; contextData.value = null; workspaceFilesData.value = null;
    resetWorkspaceAssetState();
    resetWorkspaceCheckpoints();
    try {
      const bundle: any = await workspacesClient.getWorkspaceChainBundle(id);
      chainData.value = bundle.chain;
      contextData.value = bundle.context;
      workspaceFilesData.value = bundle.files;
      await loadWorkspaceCheckpoints(id);
    } catch (e: unknown) { localError.value = errorMessage(e); }
  }

  async function reloadWorkspaceChain() : Promise<any> {
    if (selectedId.value) {
      await loadChain(selectedId.value);
    }
  }

  function showListPanel() : any {
    panel.value = 'list';
  }

  watch(selectedId, (id?: any) : any => {
    if (id) {
      if (panel.value === 'list') expandedWorkspaceId.value = id;
      loadChain(id);
    } else {
      expandedWorkspaceId.value = '';
    }
  });

  watch(panel, (next?: any) : any => {
    if (next === 'list') {
      if (selectedId.value) expandedWorkspaceId.value = selectedId.value;
    } else {
      expandedWorkspaceId.value = '';
    }
  });

  function openLocalDir() : any {
    panel.value = 'localDir';
  }

  async function openWorkspaceAssets() : Promise<any> {
    panel.value = await prepareWorkspaceAssetsPanel();
  }

  async function copyToClipboard(event: MouseEvent, text: string) : Promise<any> {
    if (!text) return;
    try {
      await copyConsoleTextWithFeedback(event, text);
    } catch (err: any) {
      console.error('Failed to copy: ', err);
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  usePageRefreshHandler(
    (detail?: any) : any => detail.viewId === 'workspaces',
    async () : Promise<any> => {
      const activePanel: WorkspacePanel = panel.value;
      await load();
      if (selectedId.value) {
        await loadChain(selectedId.value);
        if (activePanel === 'assets') {
          await refreshWorkspaceAssets();
        }
      }
    },
  );

  if (options.autoload ?? true) {
    load();
  }

  return {
    isAnyBusy: busy.isAnyBusy,
    isBusy: busy.isBusy,
    isBusyPrefix: busy.isBusyPrefix,
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
