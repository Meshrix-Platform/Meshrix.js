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
        <h3>概览</h3>
      </div>
    </div>

    <section class="metric-grid system-overview-metrics">
      <article class="metric-card" data-tone="primary">
        <div class="metric-card-header">
          <span>对象记录</span>
          <strong>{{ consoleState?.storage?.objectCount || 0 }}</strong>
        </div>
        <h3>{{ consoleState?.storage?.objectCount || 0 }}</h3>
        <p>通用对象索引中的记录数。</p>
      </article>

      <article class="metric-card" data-tone="accent">
        <div class="metric-card-header">
          <span>对象文件</span>
          <strong>{{ consoleState?.storage?.objectFileCount || 0 }}</strong>
        </div>
        <h3>{{ consoleState?.storage?.objectFileCount || 0 }}</h3>
        <p>对象目录中可定位的文件数。</p>
      </article>

      <article class="metric-card" data-tone="neutral">
        <div class="metric-card-header">
          <span>数据库</span>
          <strong>{{ consoleState?.storage?.databaseExists === false ? 0 : 1 }}</strong>
        </div>
        <h3>{{ consoleState?.storage?.databaseExists === false ? "缺失" : "可用" }}</h3>
        <p>SQLite storage kernel 状态。</p>
      </article>

      <article class="metric-card" data-tone="success">
        <div class="metric-card-header">
          <span>字节</span>
          <strong>{{ (consoleState?.storage?.objectBytes || 0).toLocaleString() }}</strong>
        </div>
        <h3>{{ (consoleState?.storage?.objectBytes || 0).toLocaleString() }}</h3>
        <p>当前对象目录的累计大小。</p>
      </article>
    </section>

    <div class="detail-metrics">
      <div>
        <span>对象记录</span>
        <strong>{{ consoleState?.storage?.objectCount || 0 }}</strong>
      </div>
      <div>
        <span>对象文件</span>
        <strong>{{ consoleState?.storage?.objectFileCount || 0 }}</strong>
      </div>
      <div>
        <span>数据库</span>
        <strong>{{ consoleState?.storage?.databaseExists === false ? 0 : 1 }}</strong>
      </div>
      <div>
        <span>字节</span>
        <strong>{{ (consoleState?.storage?.objectBytes || 0).toLocaleString() }}</strong>
      </div>
    </div>

  </article>
</template>
