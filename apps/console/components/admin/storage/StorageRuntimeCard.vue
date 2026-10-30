<script setup lang="ts">
import { useStorageViewContext } from "../../../composables/storageViewContext";
import { consoleMessages, currentConsoleLocale } from "../../../i18n/console";

const {
  consoleState,
  enabledMountCount,
  openAdmin,
  totalMountCount,
} = useStorageViewContext();
</script>

<template>
  <article class="surface-card detail-card">
    <div class="section-header">
      <div>
        <h3>{{ consoleMessages[currentConsoleLocale].operations.runtimeConfiguration }}</h3>
      </div>
      <button
        class="inline-link"
        type="button"
        @click="openAdmin('modules')"
      >
        查看模块管理
      </button>
    </div>

    <dl class="meta-list">
      <div>
        <dt>运行档位</dt>
        <dd>{{ consoleState?.runtime?.profile || "default" }}</dd>
      </div>
      <div>
        <dt>挂载代次</dt>
        <dd>{{ consoleState?.runtime?.mountGeneration || 0 }}</dd>
      </div>
      <div>
        <dt>挂载模块</dt>
        <dd>{{ enabledMountCount }}/{{ totalMountCount }}</dd>
      </div>
    </dl>
  </article>
</template>
