<script setup lang="ts">
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";

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
  <BinaryCheckbox
    class="agent-config-invocation-toggle"
    :model-value="modelValue"
    :label="label"
    :disabled="disabled"
    @update:model-value="emit('update:modelValue', $event)"
    @change="emit('change', $event)"
  />
</template>

<style scoped>
:deep(.agent-config-invocation-toggle.binary-checkbox) {
  width: 100%;
  min-height: 48px;
  justify-content: flex-start;
  padding: 10px 14px;
}
</style>
