<script setup lang="ts">
import { useWorkspacesViewContext } from "@meshrix/ui-console/workspaces-view-context";

const { isBusy, deleteWorkspace } = useWorkspacesViewContext();
</script>

<template>
  <div class="workspace-delete-actions">
    <button
      class="tool-button workspace-delete-button"
      type="button"
      :disabled="isBusy('ws:delete')"
      :aria-busy="isBusy('ws:delete')"
      @click="deleteWorkspace"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
      {{ isBusy('ws:delete') ? '正在移除…' : '删除' }}
    </button>
  </div>
</template>
