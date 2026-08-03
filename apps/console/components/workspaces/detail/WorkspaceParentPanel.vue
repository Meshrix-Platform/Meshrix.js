<script setup lang="ts">
import { useWorkspacesViewContext } from "../../../composables/workspacesViewContext";

const {
  isBusy,
  isBusyPrefix,
  panel,
  parentForm,
  selected,
  selectedId,
  setParent,
  workspaces,
} = useWorkspacesViewContext();
</script>

<template>
  <div v-if="selected" class="surface-card drawer-panel">
    <div class="panel-header">
      <h4>设置继承父级 — {{ selected.title }}</h4>
      <p>
        子工作空间将从父级的继承链中继承本地资源和 profile 配置。
        只需声明与父级不同的部分，其余自动继承。
      </p>
    </div>
    <div class="form-grid">
      <label>
        <span>父工作空间 ID（留空移除继承关系）</span>
        <input v-model="parentForm.parentWorkspaceId" autocomplete="off" placeholder="workspace_xxxxxx" />
      </label>
    </div>
    <p class="module-note">当前可用工作空间：</p>
    <ul class="ws-id-list">
      <li v-for="ws in workspaces.filter((w: any) => w.workspaceId !== selectedId)" :key="ws.workspaceId">
        <code @click="parentForm.parentWorkspaceId = ws.workspaceId" style="cursor:pointer">{{ ws.workspaceId }}</code>
        <span>{{ ws.title }}</span>
      </li>
    </ul>
    <div class="module-actions">
      <button class="tool-button" type="button" :disabled="isBusyPrefix('ws:')" @click="setParent">
        {{ isBusy('ws:parent') ? '保存中…' : '设置继承' }}
      </button>
      <button class="tool-button tool-button-ghost" type="button" @click="panel = 'list'">取消</button>
    </div>
  </div>
</template>
