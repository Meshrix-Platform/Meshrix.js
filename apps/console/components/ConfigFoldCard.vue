<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <details class="config-fold-card">
    <summary class="config-fold-summary">
      <slot name="summary">
        <span class="config-fold-title">{{ title }}</span>
        <small v-if="subtitle" class="config-fold-subtitle">{{ subtitle }}</small>
      </slot>
      <span class="config-fold-chevron" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
    </summary>
    <div class="config-fold-body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.config-fold-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.config-fold-card + .config-fold-card {
  margin-top: var(--space-2);
}

.config-fold-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2-5) var(--space-3-5);
  background: var(--bg-subtle);
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background var(--dur-fast) var(--ease-std);
}

.config-fold-summary::-webkit-details-marker { display: none; }

.config-fold-summary:hover { background: var(--bg-inset); }

.config-fold-title {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--text-primary);
  min-width: 0;
  flex: 1;
}

.config-fold-subtitle {
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  color: var(--text-muted);
  white-space: nowrap;
}

.config-fold-chevron {
  color: var(--text-muted);
  transition: transform var(--dur-base) var(--ease-std);
  flex-shrink: 0;
}

details[open] .config-fold-chevron {
  transform: rotate(180deg);
}

.config-fold-body {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
</style>
