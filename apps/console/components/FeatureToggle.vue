<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  modelValue: boolean;
  onLabel?: string;
  offLabel?: string;
  ariaLabel?: string;
  disabled?: boolean;
}>(), {
  onLabel: "已开启",
  offLabel: "已关闭",
  ariaLabel: "",
  disabled: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  change: [value: boolean];
}>();

const currentLabel = computed(() => (props.modelValue ? props.onLabel : props.offLabel));
const accessibleLabel = computed(() => props.ariaLabel || currentLabel.value);

function toggle() {
  if (props.disabled) {
    return;
  }
  const nextValue = !props.modelValue;
  emit("update:modelValue", nextValue);
  emit("change", nextValue);
}
</script>

<template>
  <button
    class="feature-toggle"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="accessibleLabel"
    :disabled="disabled"
    :data-enabled="modelValue"
    @click="toggle"
  >
    <span class="feature-toggle-track" aria-hidden="true">
      <span class="feature-toggle-knob" />
    </span>
  </button>
</template>

<style scoped>
.feature-toggle {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  line-height: 1;
}

.feature-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.feature-toggle:focus-visible { outline: none; }

.feature-toggle:focus-visible .feature-toggle-track {
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.20);
}

.feature-toggle-track {
  position: relative;
  width: 40px;
  height: 22px;
  border-radius: var(--radius-full);
  background: var(--border-strong);
  transition: background var(--dur-base) var(--ease-std);
}

.feature-toggle[data-enabled="true"] .feature-toggle-track {
  background: var(--success);
}

.feature-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--bg-surface);
  box-shadow: 0 1px 3px rgba(0,0,0,0.25);
  transition: transform var(--dur-base) var(--ease-emphasized);
  will-change: transform;
}

.feature-toggle[data-enabled="true"] .feature-toggle-knob {
  transform: translateX(18px);
}
</style>
