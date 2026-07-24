<script setup lang="ts">
import { useStorageViewContext } from "../../../composables/storageViewContext";

const {
  busyKey,
  currentUser,
  logoutConsole,
} = useStorageViewContext();
</script>

<template>
  <article class="surface-card detail-card">
    <div class="section-header">
      <div>
        <h3>当前会话</h3>
      </div>
    </div>
    <dl v-if="currentUser" class="meta-list">
      <div>
        <dt>用户</dt>
        <dd>{{ currentUser.displayName }}</dd>
      </div>
      <div>
        <dt>角色</dt>
        <dd>{{ currentUser.roleLabel }}</dd>
      </div>
    </dl>
    <div class="section-actions" style="margin-top: 12px;">
      <button
        class="tool-button tool-button-ghost"
        type="button"
        :disabled="busyKey === 'auth:logout'"
        @click="logoutConsole"
      >
        退出登录
      </button>
    </div>
  </article>
</template>
