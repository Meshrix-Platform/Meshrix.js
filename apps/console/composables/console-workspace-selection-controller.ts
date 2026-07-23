import { computed, type Ref } from 'vue';
import type { WsWorkspace } from '../types/workspaces';
import type { WorkspacePanel } from './console-workspace-management-controller';

type WorkspaceSelectionControllerOptions = {
  workspaces: Ref<WsWorkspace[]>;
  selectedId: Ref<string>;
  panel: Ref<WorkspacePanel>;
  expandedWorkspaceId: Ref<string>;
};

export function useWorkspaceSelectionController({
  workspaces,
  selectedId,
  panel,
  expandedWorkspaceId,
}: WorkspaceSelectionControllerOptions) {
  const selected = computed(() => workspaces.value.find(w => w.workspaceId === selectedId.value) ?? null);
  const workspaceOptions = computed(() =>
    workspaces.value.map(w => ({ value: w.workspaceId, label: w.title || w.workspaceId.slice(0, 12) }))
  );

  function workspaceExpansionSlotId(ws: WsWorkspace) {
    return `workspace-expansion-${ws.workspaceId}`;
  }

  function isWorkspaceExpanded(ws: WsWorkspace) {
    return panel.value === 'list' && expandedWorkspaceId.value === ws.workspaceId;
  }

  function toggleWorkspaceCard(ws: WsWorkspace) {
    const shouldCollapse = isWorkspaceExpanded(ws);
    selectedId.value = ws.workspaceId;
    panel.value = 'list';
    expandedWorkspaceId.value = shouldCollapse ? '' : ws.workspaceId;
  }

  function statusTone(status: string) {
    return status === 'active' ? 'success' : status === 'archived' ? 'neutral' : 'info';
  }

  return {
    selected,
    workspaceExpansionSlotId,
    isWorkspaceExpanded,
    toggleWorkspaceCard,
    workspaceOptions,
    statusTone,
  };
}
