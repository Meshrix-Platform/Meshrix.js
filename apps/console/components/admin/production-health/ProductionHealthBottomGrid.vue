<script setup lang="ts">
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import StatusPill from "../../StatusPill.vue";
import {
  formatDateTime,
  statusLabel,
  statusTone,
  type ProductionHealthResponse,
} from "../../../lib/production-health";

defineProps<{
  actions: ProductionHealthResponse["actions"];
  history: NonNullable<ProductionHealthResponse["history"]>;
}>();
</script>

<template>
  <section class="production-health-bottom-grid">
    <article class="surface-card production-health-bottom-card">
      <div class="section-header compact-section-header">
        <div>
          <h3>报告历史</h3>
        </div>
        <div class="section-tags">
          <span>{{ history.length }} 条</span>
        </div>
      </div>
      <div v-if="history.length" class="production-history-list">
        <div v-for="item in history" :key="item.runId">
          <StatusPill :tone="statusTone(item.status)" :label="statusLabel(item.status)" />
          <strong>{{ item.runId }}</strong>
          <span>{{ formatDateTime(item.generatedAt) }}</span>
        </div>
      </div>
      <ConsoleEmptyState v-else compact title="没有历史报告" />
    </article>

    <article class="surface-card production-health-bottom-card">
      <div class="section-header compact-section-header">
        <div>
          <h3>执行入口</h3>
        </div>
      </div>
      <div class="production-action-list">
        <div v-for="action in actions" :key="action.id">
          <strong>{{ action.label }}</strong>
          <code>{{ action.command }}</code>
        </div>
      </div>
    </article>
  </section>
</template>

<style scoped>
.production-health-bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: stretch;
  gap: var(--space-4);
}

.production-health-bottom-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin-top: 0;
}

.compact-section-header {
  align-items: flex-start;
}

.production-history-list,
.production-action-list {
  display: flex;
  flex-direction: column;
  flex-wrap: wrap;
  flex: 1;
  gap: var(--space-2);
}

.production-history-list div,
.production-action-list div {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.production-action-list div {
  grid-template-columns: minmax(120px, 0.35fr) minmax(0, 1fr);
}

.production-history-list div:last-child,
.production-action-list div:last-child {
  border-bottom: 0;
}

.production-history-list strong,
.production-action-list strong {
  min-width: 0;
  color: var(--text-primary);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}

.production-history-list span {
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.production-action-list code {
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

@media (max-width: 1120px) {
  .production-health-bottom-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {
  .production-history-list div,
  .production-action-list div {
    grid-template-columns: 1fr;
    align-items: flex-start;
  }
}
</style>
