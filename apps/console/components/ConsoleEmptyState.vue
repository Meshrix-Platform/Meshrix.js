<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  description?: string;
  tone?: "neutral" | "danger";
  compact?: boolean;
  /** 在 <ul> 等列表容器内使用时传入 "li" 保持 HTML 语义合法。 */
  as?: "div" | "li";
}>(), {
  description: "",
  tone: "neutral",
  compact: false,
  as: "div",
});
</script>

<template>
  <component
    :is="as"
    class="console-empty-state"
    :class="{ 'is-compact': compact, 'tone-danger': tone === 'danger' }"
  >
    <strong class="console-empty-state-title">{{ title }}</strong>
    <span v-if="description" class="console-empty-state-description">{{ description }}</span>
    <div
      v-if="$slots.action"
      class="console-empty-state-actions horizontal-action-group"
    >
      <slot name="action" />
    </div>
    <slot />
  </component>
</template>

<style scoped>
.console-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-12) var(--space-6);
  text-align: center;
  color: var(--text-muted);
}

.console-empty-state::before {
  content: "";
  display: block;
  width: 48px;
  height: 48px;
  margin-bottom: var(--space-3);
  background-color: var(--border-strong);
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='22 12 16 12 14 15 10 15 8 12 2 12'/%3E%3Cpath d='M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'/%3E%3C/svg%3E");
  -webkit-mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='22 12 16 12 14 15 10 15 8 12 2 12'/%3E%3Cpath d='M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'/%3E%3C/svg%3E");
  mask-size: contain;
  mask-repeat: no-repeat;
  mask-position: center;
}

.console-empty-state.is-compact {
  padding: var(--space-8) var(--space-4);
}

.console-empty-state.is-compact::before {
  display: none;
}

.console-empty-state-title {
  color: var(--text-secondary);
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
}

.console-empty-state-description {
  max-width: 360px;
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}

/* 起步操作区沿用共享的水平操作组契约，保持同一行控件等高。 */
.console-empty-state-actions {
  --horizontal-action-control-height: 32px;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
  margin-top: var(--space-2);
}

.console-empty-state.is-compact .console-empty-state-actions {
  margin-top: var(--space-1);
}

.console-empty-state.tone-danger .console-empty-state-title {
  color: var(--danger);
}

.console-empty-state.tone-danger::before {
  background-color: var(--danger);
}
</style>
