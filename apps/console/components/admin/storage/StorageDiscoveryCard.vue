<script setup lang="ts">
import { useStorageViewContext } from "../../../composables/storageViewContext";

const {
  consoleState,
  openDrawer,
} = useStorageViewContext();
</script>

<template>
  <article class="surface-card detail-card">
    <div class="section-header">
      <div>
        <h3>引导网络</h3>
      </div>
      <button
        class="inline-link"
        type="button"
        @click="openDrawer('discovery')"
      >
        修改
      </button>
    </div>

    <dl class="meta-list">
      <div>
        <dt>服务 ID</dt>
        <dd :title="consoleState?.discovery?.value?.serverId || undefined">{{ consoleState?.discovery?.value?.serverId || "未配置" }}</dd>
      </div>
      <div>
        <dt>对外服务地址</dt>
        <dd>
          {{ consoleState?.discovery?.value?.advertisedBaseUrl || "未配置" }}
        </dd>
      </div>
      <div>
        <dt>活跃服务地址</dt>
        <dd>
          {{ consoleState?.discovery?.value?.activeServiceUrl || "未配置" }}
        </dd>
      </div>
      <div>
        <dt>配置版本</dt>
        <dd>{{ consoleState?.discovery?.value?.configVersion || "未配置" }}</dd>
      </div>
    </dl>
  </article>
</template>
