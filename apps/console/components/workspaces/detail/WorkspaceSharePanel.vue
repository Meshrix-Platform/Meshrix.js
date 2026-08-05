<script setup lang="ts">
import OptionBar from "@meshrix/ui-console/option-bar";
import { useWorkspacesViewContext } from "@meshrix/ui-console/workspaces-view-context";

const {
  isBusy,
  isBusyPrefix,
  panel,
  selected,
  shareForm,
  shareOrUnshare,
} = useWorkspacesViewContext();
</script>

<template>
  <div v-if="selected" class="surface-card drawer-panel">
    <div class="panel-header">
      <h4>共享工作空间访问权 — {{ selected.title }}</h4>
      <p>
        将当前工作空间的本地资源（含继承来源）授权给目标工作空间可读取。
        目标工作空间即时可用，无需等待。
      </p>
    </div>
    <div class="form-grid">
      <OptionBar
        v-model="shareForm.action"
        label="操作"
        :options="[{ value: 'share', label: '授权共享' }, { value: 'unshare', label: '撤销共享' }]"
      />
      <label>
        <span>目标工作空间 ID</span>
        <input v-model="shareForm.targetWorkspaceId" autocomplete="off" placeholder="workspace_xxxxxx" />
      </label>
    </div>
    <p class="module-note">当前已共享给：
      <code v-for="id in selected.accessibleWorkspaceIds" :key="id" class="shared-ws-id">{{ id }}</code>
      <em v-if="selected.accessibleWorkspaceIds.length === 0">（无）</em>
    </p>
    <div class="module-actions">
      <button class="tool-button" type="button" :disabled="!shareForm.targetWorkspaceId || isBusyPrefix('ws:')" @click="shareOrUnshare">
        {{ isBusy('ws:share') ? '处理中…' : (shareForm.action === 'share' ? '授权' : '撤销') }}
      </button>
      <button class="tool-button tool-button-ghost" type="button" @click="panel = 'list'">取消</button>
    </div>
  </div>
</template>

<style scoped>
.shared-ws-id {
  margin-right: var(--space-2);
}
</style>
