<script setup lang="ts">
import { useStorageViewContext } from "../../../composables/storageViewContext";

const {
  consoleState,
} = useStorageViewContext();
</script>

<template>
  <article class="surface-card detail-card system-overview-card">
    <div class="section-header">
      <div>
        <h3>运行状态</h3>
      </div>
    </div>

    <section class="metric-grid system-overview-metrics">
      <article class="metric-card">
        <div class="metric-card-header">
          <span>对象记录</span>
        </div>
        <h3>{{ consoleState?.storage?.objectCount || 0 }}</h3>
        <p>通用对象索引中的记录数。</p>
      </article>

      <article class="metric-card">
        <div class="metric-card-header">
          <span>对象文件</span>
        </div>
        <h3>{{ consoleState?.storage?.objectFileCount || 0 }}</h3>
        <p>对象目录中可定位的文件数。</p>
      </article>

      <article class="metric-card">
        <div class="metric-card-header">
          <span>数据库</span>
        </div>
        <h3>{{ consoleState?.storage?.databaseExists === false ? "缺失" : "可用" }}</h3>
        <p>SQLite storage kernel 状态。</p>
      </article>

      <article class="metric-card">
        <div class="metric-card-header">
          <span>字节</span>
        </div>
        <h3>{{ (consoleState?.storage?.objectBytes || 0).toLocaleString() }}</h3>
        <p>当前对象目录的累计大小。</p>
      </article>
    </section>

  </article>
</template>
