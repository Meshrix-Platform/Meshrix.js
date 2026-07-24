<script setup lang="ts">
defineProps<{
  missing: string[];
}>();
</script>

<template>
  <article class="surface-card production-health-warning">
    <div class="section-header">
      <div>
        <h3>覆盖缺口</h3>
      </div>
      <div class="section-tags">
        <span>{{ missing.length }} 项</span>
      </div>
    </div>
    <div class="production-token-list">
      <span v-for="item in missing" :key="item">{{ item }}</span>
    </div>
  </article>
</template>

<style scoped>
.production-health-warning {
  border-color: var(--warning-border);
  background: var(--warning-surface);
}

.production-token-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.production-token-list span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
}
</style>
