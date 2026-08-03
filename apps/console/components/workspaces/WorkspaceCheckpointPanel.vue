<script setup lang="ts">
import ConfigFoldCard from "../ConfigFoldCard.vue";
import ConsoleEmptyState from "../ConsoleEmptyState.vue";
import { useWorkspacesViewContext } from "../../composables/workspacesViewContext";

const {
  isBusy,
  isBusyPrefix,
  checkpointNodeBasePath,
  checkpointNodeFileCount,
  formatCompactDate,
  loadWorkspaceCheckpointTree,
  previewWorkspaceCheckpointRestore,
  restoreWorkspaceCheckpoint,
  selectedCheckpointNodeId,
  selectedCheckpointTreeId,
  workspaceCheckpointError,
  workspaceCheckpointNodes,
  workspaceCheckpointPreview,
  workspaceCheckpointPreviewRestore,
  workspaceCheckpointTrees,
} = useWorkspacesViewContext();
</script>

<template>
  <ConfigFoldCard title="文件回退点（管控台）">
    <div class="checkpoint-panel">
      <div class="checkpoint-toolbar">
        <div>
          <strong>{{ workspaceCheckpointTrees.length }} 个文件 checkpoint tree</strong>
          <span>来源：workspace_files 快照；用于管理员手动预览和回退本机共享文件夹。</span>
        </div>
      </div>

      <p v-if="workspaceCheckpointError" class="checkpoint-error">{{ workspaceCheckpointError }}</p>

      <div v-if="workspaceCheckpointTrees.length" class="checkpoint-grid">
        <aside class="checkpoint-tree-list">
          <button
            v-for="tree in workspaceCheckpointTrees"
            :key="tree.treeId"
            type="button"
            class="checkpoint-tree-item"
            :class="{ selected: selectedCheckpointTreeId === tree.treeId }"
            :disabled="isBusyPrefix('ws:')"
            @click="loadWorkspaceCheckpointTree(tree.treeId)"
          >
            <strong>{{ tree.treeId.slice(0, 18) }}</strong>
	            <span>{{ tree.status }}</span>
	            <span>{{ tree.nodeCount }} 节点</span>
		            <span>{{ formatCompactDate(tree.updatedAt || "") }}</span>
          </button>
        </aside>

        <div class="checkpoint-node-list">
          <template v-if="workspaceCheckpointNodes.length">
            <article
              v-for="node in workspaceCheckpointNodes"
              :key="node.nodeId"
              class="checkpoint-node-card"
              :class="{ selected: selectedCheckpointNodeId === node.nodeId }"
            >
              <div class="checkpoint-node-main">
                <strong>{{ node.label || node.nodeId }}</strong>
	                <span>{{ node.nodeId }}</span>
	                <span>{{ checkpointNodeFileCount(node) }} 个文件</span>
	                <span>{{ checkpointNodeBasePath(node) }}</span>
                <small>{{ formatCompactDate(node.updatedAt || node.createdAt || '') }}</small>
              </div>
              <div class="checkpoint-node-actions">
                <button class="table-action" type="button" :disabled="isBusyPrefix('ws:')" @click="previewWorkspaceCheckpointRestore(node.nodeId)">
                  {{ isBusy('ws:checkpoint-preview') && selectedCheckpointNodeId === node.nodeId ? '预览中…' : '预览' }}
                </button>
                <button class="table-action danger-link" type="button" :disabled="isBusyPrefix('ws:')" @click="restoreWorkspaceCheckpoint(node.nodeId)">
                  {{ isBusy('ws:checkpoint-restore') && selectedCheckpointNodeId === node.nodeId ? '回退中…' : '回退到此处' }}
                </button>
              </div>
            </article>
          </template>
          <ConsoleEmptyState v-else compact title="当前 checkpoint tree 没有可直接回退的文件快照节点。" />
        </div>
      </div>
      <ConsoleEmptyState
        v-else-if="!workspaceCheckpointError"
        compact
        title="当前工作空间还没有文件 checkpoint。写入、上传或删除文件后会自动出现回退点。"
      />

      <div v-if="workspaceCheckpointPreview" class="checkpoint-preview">
        <strong>{{ workspaceCheckpointPreview.applied ? '已执行回退' : '回退预览' }}</strong>
        <span v-if="workspaceCheckpointPreviewRestore">
          {{ workspaceCheckpointPreviewRestore.dryRun ? '预览' : '执行' }}
          {{ workspaceCheckpointPreviewRestore.actions?.length ?? workspaceCheckpointPreviewRestore.appliedActions?.length ?? 0 }}
          个文件动作
        </span>
        <span v-if="workspaceCheckpointPreview.restoreId">restoreId: {{ workspaceCheckpointPreview.restoreId }}</span>
        <pre class="config-json-preview">{{ JSON.stringify(workspaceCheckpointPreview.workspaceFileRestore || workspaceCheckpointPreview, null, 2) }}</pre>
      </div>
    </div>
  </ConfigFoldCard>
</template>
