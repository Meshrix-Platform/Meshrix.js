<script setup lang="ts">
import FeatureToggle from "../../FeatureToggle.vue";

defineProps<{
  modelValue: boolean;
  label: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  change: [value: boolean];
}>();
</script>

<template>
  <FeatureToggle
    class="agent-config-invocation-toggle"
    :model-value="modelValue"
    :label="label"
    :aria-label="modelValue ? `关闭${label}` : `开启${label}`"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  />
</template>

<style scoped>
:deep(.agent-config-invocation-toggle.feature-toggle) {
  width: 100%;
  min-height: 48px;
  justify-content: flex-start;
  padding: 10px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
</style>
