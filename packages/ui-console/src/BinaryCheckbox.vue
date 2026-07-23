<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: boolean;
  label: string;
  disabled?: boolean;
  readonly?: boolean;
}>(), {
  disabled: false,
  readonly: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  change: [value: boolean];
}>();

function toggle() {
  if (props.disabled || props.readonly) {
    return;
  }
  const nextValue = !props.modelValue;
  emit("update:modelValue", nextValue);
  emit("change", nextValue);
}
</script>

<template>
  <button
    class="binary-checkbox"
    type="button"
    role="checkbox"
    :aria-checked="modelValue"
    :aria-readonly="readonly || undefined"
    :data-checked="modelValue"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="binary-checkbox-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path d="M3.3 8.2 6.5 11.3 12.8 4.8" />
      </svg>
    </span>
    <span class="binary-checkbox-spacer" aria-hidden="true"></span>
    <span class="binary-checkbox-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.binary-checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1) var(--space-2-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-md);
  font-weight: var(--font-medium);
  line-height: var(--leading-tight);
  white-space: nowrap;
  cursor: pointer;
  transition:
    border-color var(--dur-base) var(--ease-std),
    background var(--dur-base) var(--ease-std),
    color var(--dur-base) var(--ease-std),
    box-shadow var(--dur-base) var(--ease-std);
}

.binary-checkbox[data-checked="true"] {
  border-color: var(--brand-muted);
  background: var(--brand-subtle);
  color: var(--brand-strong);
  font-weight: var(--font-semibold);
}

.binary-checkbox:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.binary-checkbox[aria-readonly="true"] {
  cursor: default;
}

.binary-checkbox:hover:not(:disabled):not([aria-readonly="true"]) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.binary-checkbox[data-checked="true"]:hover:not(:disabled):not([aria-readonly="true"]) {
  border-color: var(--brand);
  background: var(--brand-muted);
}

.binary-checkbox:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.binary-checkbox-icon {
  display: inline-grid;
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  place-items: center;
  border: 1.5px solid currentColor;
  border-radius: var(--radius-xs);
  transition: background var(--dur-fast) var(--ease-std),
              border-color var(--dur-fast) var(--ease-std);
}

.binary-checkbox[data-checked="true"] .binary-checkbox-icon {
  border-color: var(--brand);
  background: var(--brand);
  color: var(--text-on-brand);
}

.binary-checkbox-icon svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transform: scale(0.6);
  transition: opacity var(--dur-fast) var(--ease-std),
              transform var(--dur-fast) var(--ease-emphasized);
}

.binary-checkbox[data-checked="true"] .binary-checkbox-icon svg {
  opacity: 1;
  transform: scale(1);
}

.binary-checkbox-spacer { display: none; }

.binary-checkbox-label { min-width: 0; }
</style>
