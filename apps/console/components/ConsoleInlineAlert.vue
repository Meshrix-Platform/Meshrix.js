<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  tone?: "info" | "success" | "danger";
}>(), {
  tone: "info",
});

const role = computed(() => (props.tone === "danger" ? "alert" : "status"));
</script>

<template>
  <div class="console-inline-alert" :class="`tone-${tone}`" :role="role">
    <slot />
  </div>
</template>

<style scoped>
.console-inline-alert {
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid var(--info-border);
  border-radius: var(--radius-md);
  background: var(--info-surface);
  color: var(--info);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  white-space: pre-line;
  word-break: break-word;
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
</style>
