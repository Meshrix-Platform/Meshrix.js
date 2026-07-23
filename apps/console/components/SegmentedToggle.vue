<script setup lang="ts">
import { computed } from 'vue';

type ToggleOption = {
  label: string;
  value: string | number;
};

const props = defineProps<{
  modelValue: string | number;
  options: ToggleOption[];
  ariaLabel?: string;
  size?: 'default' | 'small' | 'large';
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string | number];
  'change': [value: string | number];
}>();

function selectOption(value: string | number) {
  emit('update:modelValue', value);
  emit('change', value);
}

const gridColumns = computed(() => `repeat(${props.options.length}, minmax(0, 1fr))`);
</script>

<template>
  <div
    class="lico-segmented-toggle"
    :class="[`size-${size || 'default'}`]"
    role="tablist"
    :aria-label="ariaLabel || '选项切换'"
    :style="{ gridTemplateColumns: gridColumns }"
  >
    <button
      v-for="option in options"
      :key="String(option.value)"
      class="lico-segmented-toggle-tab"
      :class="{ active: modelValue === option.value }"
      type="button"
      role="tab"
      :aria-selected="modelValue === option.value"
      @click="selectOption(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.lico-segmented-toggle {
  display: grid;
  gap: var(--space-1);
  width: min(360px, 100%);
  min-height: 44px;
  padding: 4px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--info-surface);
  margin: 0 auto;
}

.lico-segmented-toggle.size-small {
  min-height: 36px;
  width: auto;
}
.lico-segmented-toggle.size-small .lico-segmented-toggle-tab {
  min-height: 28px;
  font-size: var(--text-sm);
}

.lico-segmented-toggle.size-large {
  width: min(500px, 100%);
  min-height: 52px;
}
.lico-segmented-toggle.size-large .lico-segmented-toggle-tab {
  min-height: 44px;
  font-size: var(--text-md);
}

.lico-segmented-toggle-tab {
  min-width: 0;
  min-height: 36px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--info);
  font: inherit;
  font-size: var(--text-base);
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.lico-segmented-toggle-tab:hover,
.lico-segmented-toggle-tab:focus-visible {
  color: var(--brand);
  background: var(--bg-surface);
}

.lico-segmented-toggle-tab.active {
  color: var(--text-on-brand);
  background: var(--brand);
  box-shadow: 0 2px 6px var(--brand-shadow);
}
</style>
