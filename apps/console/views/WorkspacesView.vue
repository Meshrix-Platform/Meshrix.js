<script setup lang="ts">
import { computed, onMounted } from 'vue';
import StatusPill from '@meshrix/ui-console/status-pill';
import ConsoleEmptyState from '../components/ConsoleEmptyState.vue';
import SplitToggleCard from '../components/SplitToggleCard.vue';
import WorkspaceDetailPanel from '../components/workspaces/WorkspaceDetailPanel.vue';
import { provideWorkspacesView } from '@meshrix/ui-console/workspaces-view-context';
import { useServerConsoleShellContext } from '@meshrix/ui-console/server-console-shell-context';
import {
  workspaceContextContract,
  workspaceContextSignature,
} from '../lib/workspaces-client';
import { canAccessPluginConsoleEntry, type PluginConsoleEntry } from '../router/plugin-console-routes';

import { currentConsoleLocale, localizeConsoleText } from '../i18n/console';

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const shell = useServerConsoleShellContext();
const { workspacesConsole: workspacesView } = shell;
const localDirectoryEntry = computed(() =>
  (shell.consoleState.value?.features?.plugins?.consoleEntries || []).find(
    (entry: any) => entry.slotId === 'workspace.local-directory' && canAccessPluginConsoleEntry(
      entry as PluginConsoleEntry,
      shell.canAccessRouteMeta,
    ),
  ),
);
provideWorkspacesView(workspacesView);

const {
  formatCompactDate,
  workspaces,
  selectedId,
  localError,
  panel,
  shareForm,
  selected,
  workspaceExpansionSlotId,
  isWorkspaceExpanded,
  toggleWorkspaceCard,
  statusTone,
  copyToClipboard,
  openProfile,
  openParent,
  openWorkspaceAssets,
  openLocalDir,
} = workspacesView;

onMounted(() => {
  void workspacesView.load();
});

</script>

<template>
  <section
    class="workspaces-view"
    :data-workspace-context="workspaceContextSignature"
    :data-agent-session-id="workspaceContextContract.sessionLinkField"
    :data-workspace-endpoint="workspaceContextContract.workspaceEndpoint"
    :data-workspace-context-endpoint="workspaceContextContract.contextEndpoint"
    :data-workspace-sessions-endpoint="workspaceContextContract.sessionsEndpoint"
    :data-workspace-fork-label="workspaceContextContract.forkActionLabel"
  >
    <div v-if="localError" class="status-strip danger">
      <strong>错误</strong><span>{{ localError }}</span>
      <button class="status-strip-action" type="button" @click="localError = ''">关闭</button>
    </div>

    <!-- ─── Toolbar ──────────────────────────────────────────────────── -->
    <div class="ws-toolbar">
      <h2 class="ws-toolbar-title">智能体工作空间</h2>
      <div class="ws-toolbar-actions">
        <button class="tool-button" type="button" @click="panel = 'create'">新建工作空间</button>
      </div>
    </div>

    <!-- ─── Two-column layout ────────────────────────────────────────── -->
    <div class="ws-layout" :class="{ 'ws-layout-expanded-cards': panel === 'list' }">

      <!-- List column -->
      <div class="ws-list">
        <ConsoleEmptyState
          v-if="workspaces.length === 0"
          title="暂无工作空间"
          description="创建第一个工作空间来存放资产、检查点和共享配置。"
        >
          <template #action>
            <button class="tool-button" type="button" @click="panel = 'create'">
              新建工作空间
            </button>
          </template>
        </ConsoleEmptyState>
        <SplitToggleCard
          v-for="ws in workspaces"
          :key="ws.workspaceId"
          :id="`workspace-${ws.workspaceId}`"
          as="article"
          class="ws-card"
          :class="{ selected: selectedId === ws.workspaceId, expanded: isWorkspaceExpanded(ws) }"
          :expanded="isWorkspaceExpanded(ws)"
          :expanded-label="`收起 ${ws.title || ws.workspaceId.slice(0, 12)} 工作空间详情`"
          :collapsed-label="`展开 ${ws.title || ws.workspaceId.slice(0, 12)} 工作空间详情`"
          @toggle="toggleWorkspaceCard(ws)"
        >
          <template #summary>
            <div class="ws-card-summary">
              <div class="section-header ws-card-summary-header">
                <div class="ws-card-heading">
                  <div class="ws-card-title-row">
                    <h3>{{ ws.title || ws.workspaceId.slice(0, 12) }}</h3>
                    <span v-if="ws.parentWorkspaceId" class="ws-inherited-badge">↳ 继承</span>
                  </div>
                  <p v-if="ws.objective" class="module-note">{{ ws.objective }}</p>
                </div>
                <div class="workspace-status-row">
                  <StatusPill :tone="statusTone(ws.status)" :label="localizeStatusPillLabel(ws.status)" />
                </div>
              </div>

              <dl class="meta-list ws-card-meta-list">
                <div>
                  <dt>工作空间 ID</dt>
                  <dd>
                    <div
                      class="ws-copyable-wrapper"
                      data-split-toggle-ignore
                      :data-meshrix-tooltip="ws.workspaceId"
                      @click.stop="copyToClipboard($event, ws.workspaceId)"
                    >
                      <code class="ws-copyable-code">{{ ws.workspaceId }}</code>
                    </div>
                  </dd>
                </div>
                <div><dt>版本</dt><dd>Generation {{ ws.currentGeneration }}</dd></div>
                <div><dt>上级空间</dt><dd>{{ ws.parentWorkspaceId || '（根，无继承）' }}</dd></div>
                <div><dt>更新时间</dt><dd>{{ formatCompactDate(ws.updatedAt) }}</dd></div>
              </dl>

              <div class="ws-card-counts">
                <span>{{ ws.ownedSourceIds.length }} 个上游引用</span>
                <span>{{ ws.summary?.sessionCount ?? 0 }} 个会话</span>
                <span v-if="ws.accessibleWorkspaceIds.length">+ {{ ws.accessibleWorkspaceIds.length }} 共享</span>
              </div>

              <div class="ws-card-actions">
                <button class="table-action" type="button" @click.stop="openProfile(ws)">配置 Profile</button>
                <button class="table-action" type="button" @click.stop="openParent(ws)">设置继承</button>
                <button class="table-action" type="button" @click.stop="selectedId = ws.workspaceId; openWorkspaceAssets()">统一资产</button>
                <button v-if="localDirectoryEntry" class="table-action" type="button" @click.stop="selectedId = ws.workspaceId; openLocalDir()">本机目录</button>
                <button class="table-action" type="button" @click.stop="selectedId = ws.workspaceId; panel = 'share'; shareForm.action = 'share'">共享</button>
              </div>
            </div>
          </template>
          <div
            :id="workspaceExpansionSlotId(ws)"
            class="ws-card-expanded-slot"
            @click.stop
          ></div>
        </SplitToggleCard>
      </div>

      <WorkspaceDetailPanel />
    </div>

  </section>
</template>

<style scoped>
.workspaces-view {
  display: flex; flex-direction: column; gap: var(--space-4);
  padding: var(--space-4); min-height: 0;
}
.ws-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
}
.ws-toolbar-title { margin: 0; font-size: 1rem; font-weight: 600; }
.ws-toolbar-actions { display: flex; gap: var(--space-2); }

.ws-layout {
  display: grid; grid-template-columns: 320px 1fr; gap: var(--space-4); min-height: 0; flex: 1;
}
.ws-layout.ws-layout-expanded-cards { grid-template-columns: minmax(0, 1fr); }
@media (max-width: 900px) { .ws-layout { grid-template-columns: 1fr; } }
.ws-list  { display: flex; flex-direction: column; gap: 0; overflow: auto; }
.ws-layout.ws-layout-expanded-cards .ws-list { overflow: visible; }

.ws-card {
  --split-toggle-card-radius: var(--radius-m);
  --split-toggle-card-bg: var(--bg-surface);
  --split-toggle-card-open-bg: var(--accent-surface);
  --split-toggle-card-open-border-color: var(--accent);
  --split-toggle-card-padding: var(--space-3);
  --split-toggle-card-main-gap: var(--space-1);
  --split-toggle-card-body-gap: var(--space-3);
  --split-toggle-card-toggle-width: 58px;
  --split-toggle-card-toggle-padding: 24px 0;
  --split-toggle-card-toggle-hover-color: var(--accent);
  --split-toggle-card-focus-color: var(--accent);
  position: relative;
  transition: border-color 0.15s, background-color 0.15s;
}
.ws-card + .ws-card { margin-top: -1px; }
.ws-card:not(:first-of-type) {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
.ws-card:not(:last-of-type) {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.ws-card:hover { --split-toggle-card-border-color: var(--border-accent); }
.ws-card.selected {
  --split-toggle-card-border-color: var(--accent);
  --split-toggle-card-bg: var(--accent-surface);
  z-index: 1;
}
.ws-card.expanded {
  --split-toggle-card-open-border-color: var(--accent);
  --split-toggle-card-open-bg: var(--accent-surface);
  z-index: 2;
}
.ws-card-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}
.ws-card-summary-header {
  margin-bottom: 0;
}
.ws-card-heading {
  min-width: 0;
}
.ws-card-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}
.ws-card-title-row h3 {
  margin: 0;
  color: var(--brand);
  font-size: var(--text-2xl);
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.workspace-status-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-shrink: 0;
}
.ws-inherited-badge {
  font-size: 0.7rem; color: var(--info); border: 1px solid var(--info);
  padding: 1px 6px; border-radius: 4px;
}
.ws-card-meta-list {
  gap: var(--space-2);
}
.ws-card-meta-list > div {
  grid-template-columns: minmax(112px, 160px) minmax(0, 1fr);
}
.ws-card-meta-list dd {
  min-width: 0;
}
.ws-card-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.ws-card-actions {
  display: flex;
  flex-direction: row-reverse;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.ws-card-actions .table-action {
  height: 34px;
  padding: 0 var(--space-3);
  font-size: var(--text-base);
  color: var(--text-primary);
}
.ws-copyable-wrapper {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  cursor: copy;
}
.ws-copyable-wrapper::after {
  content: attr(data-meshrix-tooltip);
  position: absolute;
  top: -28px;
  left: 0;
  background: var(--meshrix-copy-popover-bg);
  color: var(--meshrix-copy-popover-fg);
  border: 1px solid var(--meshrix-copy-popover-border);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.1s ease-out, transform 0.1s ease-out;
  z-index: 100;
  box-shadow: var(--meshrix-copy-popover-shadow);
}
.ws-copyable-wrapper:hover::after {
  opacity: 1;
  transform: translateY(0);
}
.ws-copyable-code {
  user-select: all;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background-color 0.15s, color 0.15s;
}
.ws-copyable-wrapper:active .ws-copyable-code {
  background: var(--accent);
  color: var(--bg-surface);
}
.ws-card-expanded-slot { margin-top: 0; }
.meshrix-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
  animation: fade-in 0.2s ease-out;
}
.meshrix-modal {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-l);
  padding: var(--space-4);
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  animation: slide-up 0.3s var(--ease-out);
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-up {
  from { opacity: 0; transform: translateY(20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

</style>
