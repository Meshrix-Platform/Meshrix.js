<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import WorkspaceExpandedDetail from "./WorkspaceExpandedDetail.vue";
import WorkspaceAssetPanel from "./detail/WorkspaceAssetPanel.vue";
import WorkspaceCreatePanel from "./detail/WorkspaceCreatePanel.vue";
import WorkspaceParentPanel from "./detail/WorkspaceParentPanel.vue";
import WorkspaceProfilePanel from "./detail/WorkspaceProfilePanel.vue";
import WorkspaceSharePanel from "./detail/WorkspaceSharePanel.vue";
import ConsoleEmptyState from "../ConsoleEmptyState.vue";
import { useWorkspacesViewContext } from "@meshrix/ui-console/workspaces-view-context";
import { useServerConsoleShellContext } from "#meshrix/console/server-console-shell-context";
import {
  canAccessPluginConsoleEntry,
  resolveAccessiblePluginConsoleComponent,
  type PluginConsoleEntry,
} from "../../router/plugin-console-routes";

const {
  expandedWorkspaceId,
  panel,
  selected,
} = useWorkspacesViewContext();
const shell = useServerConsoleShellContext();
const localDirectoryEntry = computed(() =>
  (shell.runtime.consoleState.value?.features?.plugins?.consoleEntries || []).find(
    (entry: any) => entry.slotId === "workspace.local-directory" && canAccessPluginConsoleEntry(
      entry as PluginConsoleEntry,
      shell.access.canAccessRouteMeta,
    ),
  ) as PluginConsoleEntry | undefined,
);
const localDirectoryComponent = computed(() => {
  const entry = localDirectoryEntry.value;
  if (!entry) return null;
  const loader = resolveAccessiblePluginConsoleComponent(entry, shell.access.canAccessRouteMeta);
  return loader ? defineAsyncComponent(loader) : null;
});
</script>

<template>
  <div
    v-if="panel !== 'list' || (selected && expandedWorkspaceId === selected.workspaceId)"
    class="ws-detail"
  >
    <WorkspaceCreatePanel v-if="panel === 'create'" />
    <WorkspaceProfilePanel v-else-if="panel === 'profile' && selected" />
    <WorkspaceParentPanel v-else-if="panel === 'parent' && selected" />
    <WorkspaceSharePanel v-else-if="panel === 'share' && selected" />
    <WorkspaceAssetPanel v-else-if="panel === 'assets' && selected" />
    <component :is="localDirectoryComponent" v-else-if="panel === 'localDir' && selected && localDirectoryComponent" />
    <WorkspaceExpandedDetail v-else-if="panel === 'list' && selected && expandedWorkspaceId === selected.workspaceId" />
    <ConsoleEmptyState v-else title="从左侧选择一个工作空间" description='或点击"新建工作空间"。' />
  </div>
</template>

<style>
.ws-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow: auto;
}

.ws-layout.ws-layout-expanded-cards .ws-detail {
  min-height: 0;
  overflow: visible;
}

.ws-detail .ws-id-list {
  list-style: none;
  padding: 0;
  margin: var(--space-1) 0;
  font-size: 0.8rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ws-detail .ws-id-list li,
.ws-detail .ws-chain-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.ws-detail .ws-id-list code {
  background: var(--bg-subtle);
  padding: var(--space-px) var(--space-1-5);
  border-radius: var(--radius-xs);
}

.ws-detail .module-field-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-3);
}

.ws-detail .module-field-block textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  font-family: var(--font-mono);
}

.ws-detail .workspace-mount-list {
  margin-top: var(--space-4);
}

.ws-detail .workspace-mount-row {
  justify-content: space-between;
}

.ws-detail .config-json-preview {
  font-size: 0.78rem;
  line-height: 1.5;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  overflow: auto;
  max-height: 240px;
  white-space: pre;
}
</style>
