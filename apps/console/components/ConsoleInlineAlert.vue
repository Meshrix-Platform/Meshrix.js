<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  tone?: "info" | "success" | "danger";
  /** 可选标题，用于需要区分标题和正文的较长提示。 */
  title?: string;
  /** 渲染关闭控件并在点击时抛出 dismiss 事件。 */
  dismissible?: boolean;
  /** 关闭控件的无障碍名称。 */
  dismissLabel?: string;
}>(), {
  tone: "info",
  title: "",
  dismissible: false,
  dismissLabel: "关闭提示",
});

defineEmits<{ dismiss: [] }>();

const role = computed(() => (props.tone === "danger" ? "alert" : "status"));
</script>

<template>
  <div class="console-inline-alert" :class="`tone-${tone}`" :role="role">
    <div class="console-inline-alert-main">
      <strong v-if="title" class="console-inline-alert-title">{{ title }}</strong>
      <slot />
    </div>
    <div
      v-if="$slots.action || dismissible"
      class="console-inline-alert-actions horizontal-action-group"
    >
      <slot name="action" />
      <button
        v-if="dismissible"
        class="console-inline-alert-dismiss"
        type="button"
        :aria-label="dismissLabel"
        @click="$emit('dismiss')"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.console-inline-alert {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid var(--info-border);
  border-radius: var(--radius-md);
  background: var(--info-surface);
  color: var(--info);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  word-break: break-word;
}

/* 正文保留换行语义，标题与操作区不受影响。 */
.console-inline-alert-main {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-line;
}

.console-inline-alert-title {
  display: block;
  font-weight: var(--font-semibold);
}

/* 操作区沿用共享的水平操作组契约，仅收紧为提示条内的紧凑高度。 */
.console-inline-alert-actions {
  --horizontal-action-control-height: 32px;
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-2);
  white-space: normal;
}

.console-inline-alert-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font-size: var(--text-lg);
  line-height: 1;
  cursor: pointer;
}

.console-inline-alert-dismiss:hover {
  border-color: currentColor;
}

.console-inline-alert-dismiss:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.console-inline-alert.tone-success {
  border-color: var(--success-border);
  background: var(--success-surface);
  color: var(--success);
}

.console-inline-alert.tone-danger {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger);
}

@media (max-width: 720px) {
  .console-inline-alert {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
