<script setup lang="ts">
import { computed } from "vue";
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";

type ChoiceCardOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

const props = withDefaults(defineProps<{
  modelValue: string[];
  options: ChoiceCardOption[];
  title?: string;
  summary?: string;
  layout?: "auto" | "stacked";
  disabled?: boolean;
}>(), {
  title: "",
  summary: "",
  layout: "auto",
  disabled: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
  change: [value: string[]];
}>();

const selectedValues = computed(() => new Set(props.modelValue.map(String)));

function updateOption(value: string, checked: boolean) {
  if (props.disabled) {
    return;
  }
  const next = new Set(selectedValues.value);
  if (checked) {
    next.add(value);
  } else {
    next.delete(value);
  }
  const nextValue = props.options
    .map((option) => option.value)
    .filter((optionValue) => next.has(optionValue));
  emit("update:modelValue", nextValue);
  emit("change", nextValue);
}
</script>

<template>
  <section class="multi-choice-card-group" :data-layout="layout">
    <header v-if="title || summary" class="multi-choice-card-header">
      <strong v-if="title">{{ title }}</strong>
      <span v-if="summary">{{ summary }}</span>
    </header>

    <div class="multi-choice-card-grid">
      <article
        v-for="option in options"
        :key="option.value"
        class="multi-choice-card-option"
        :data-active="selectedValues.has(option.value)"
        :data-disabled="disabled || option.disabled"
      >
        <BinaryCheckbox
          :model-value="selectedValues.has(option.value)"
          :label="option.label"
          :disabled="disabled || option.disabled"
          @update:model-value="(checked) => updateOption(option.value, checked)"
        />
        <small v-if="option.description">{{ option.description }}</small>
      </article>
    </div>

    <slot name="details" />
  </section>
</template>

<style scoped>
.multi-choice-card-group {
  display: grid;
  gap: var(--space-2-5);
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}

.multi-choice-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
}

.multi-choice-card-header strong {
  color: var(--text-primary);
  font-size: var(--text-base);
}

.multi-choice-card-header span {
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-choice-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: var(--space-2);
}

.multi-choice-card-group[data-layout="stacked"] .multi-choice-card-grid {
  grid-template-columns: minmax(0, 1fr);
}

.multi-choice-card-option {
  display: grid;
  align-content: start;
  gap: var(--space-2);
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}

.multi-choice-card-option[data-active="true"] {
  border-color: var(--brand-muted);
  background: color-mix(in srgb, var(--info-surface) 70%, var(--bg-surface) 30%);
}

.multi-choice-card-option[data-disabled="true"] {
  opacity: 0.58;
}

.multi-choice-card-option small {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.45;
}

@media (max-width: 720px) {
  .multi-choice-card-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .multi-choice-card-header span {
    text-align: left;
    white-space: normal;
  }
}
</style>
