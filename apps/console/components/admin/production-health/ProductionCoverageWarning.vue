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
  border-color: var(--console-rule);
  background: var(--bg-surface);
}

.production-token-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.production-token-list span {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--console-rule);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--console-ink-secondary);
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
}
</style>
