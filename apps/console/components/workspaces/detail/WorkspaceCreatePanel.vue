<script setup lang="ts">
import { useWorkspacesViewContext } from "../../../composables/workspacesViewContext";

const {
  isBusy,
  isBusyPrefix,
  createForm,
  createWorkspace,
  panel,
} = useWorkspacesViewContext();
</script>

<template>
  <div class="surface-card drawer-panel">
    <div class="panel-header">
      <h4>新建工作空间</h4>
      <p>创建后可设置继承关系和 profile 来复用其他工作空间的配置。</p>
    </div>
    <div class="form-grid">
      <label><span>标题 *</span><input v-model="createForm.title" autocomplete="off" placeholder="工作空间名称" /></label>
      <label><span>目标描述</span><input v-model="createForm.objective" autocomplete="off" /></label>
      <label>
        <span>继承自（父工作空间 ID，可选）</span>
        <input v-model="createForm.parentWorkspaceId" autocomplete="off" placeholder="留空 = 根工作空间" />
      </label>
    </div>
    <div class="module-actions">
      <button class="tool-button" type="button" :disabled="!createForm.title || isBusyPrefix('ws:')" @click="createWorkspace">
        {{ isBusy('ws:create') ? '创建中…' : '创建' }}
      </button>
      <button class="tool-button tool-button-ghost" type="button" @click="panel = 'list'">取消</button>
    </div>
  </div>
</template>
