<script setup lang="ts">
import { computed } from "vue";
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import ConfigFoldCard from "./ConfigFoldCard.vue";

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
  layout?: "auto" | "stacked" | "fold" | "list";
  disabled?: boolean;
  open?: boolean;
  selectAllLabel?: string;
}>(), {
  title: "",
  summary: "",
  layout: "auto",
  disabled: false,
  open: true,
  selectAllLabel: "",
});

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
  change: [value: string[]];
}>();

const selectedValues = computed(() => new Set(props.modelValue.map(String)));

const selectableOptions = computed(() =>
  props.options.filter((option) => !option.disabled),
);

const allSelectableSelected = computed(() => {
  const selectable = selectableOptions.value;
  return selectable.length > 0
    && selectable.every((option) => selectedValues.value.has(option.value));
});

const showSelectAll = computed(() =>
  props.layout === "list" && Boolean(props.selectAllLabel) && selectableOptions.value.length > 0,
);

function emitOrdered(next: Set<string>) {
  const nextValue = props.options
    .map((option) => option.value)
    .filter((optionValue) => next.has(optionValue));
  emit("update:modelValue", nextValue);
  emit("change", nextValue);
}

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
  emitOrdered(next);
}

function toggleAll(checked: boolean) {
  if (props.disabled) {
    return;
  }
  if (checked) {
    emitOrdered(new Set(selectableOptions.value.map((option) => option.value)));
    return;
  }
  emitOrdered(new Set());
}

function stopSummaryToggle(event: Event) {
  event.stopPropagation();
}
</script>

<template>
  <section class="multi-choice-card-group" :data-layout="layout">
    <ConfigFoldCard
      v-if="layout === 'list'"
      class="multi-choice-list-card"
      :title="title"
      :subtitle="summary"
      :open="open"
    >
      <div class="multi-choice-card-list" role="list">
        <div
          v-if="showSelectAll"
          class="multi-choice-list-row multi-choice-list-select-all"
          role="listitem"
          :data-active="allSelectableSelected"
          :data-disabled="disabled"
        >
          <BinaryCheckbox
            class="multi-choice-list-item"
            :model-value="allSelectableSelected"
            :label="selectAllLabel"
            :disabled="disabled"
            @update:model-value="toggleAll"
          />
        </div>
        <div
          v-for="option in options"
          :key="option.value"
          class="multi-choice-list-row"
          role="listitem"
          :data-active="selectedValues.has(option.value)"
          :data-disabled="disabled || option.disabled"
        >
          <BinaryCheckbox
            class="multi-choice-list-item"
            :model-value="selectedValues.has(option.value)"
            :label="option.label"
            :disabled="disabled || option.disabled"
            :title="option.description || option.value"
            @update:model-value="(checked) => updateOption(option.value, checked)"
          />
        </div>
      </div>
    </ConfigFoldCard>

    <template v-else>
      <header v-if="title || summary" class="multi-choice-card-header">
        <strong v-if="title">{{ title }}</strong>
        <span v-if="summary">{{ summary }}</span>
      </header>

      <div v-if="layout === 'fold'" class="multi-choice-card-fold-list">
        <ConfigFoldCard
          v-for="option in options"
          :key="option.value"
          class="multi-choice-fold-card"
          :title="option.label"
          :data-active="selectedValues.has(option.value)"
          :data-disabled="disabled || option.disabled"
        >
          <template #summary>
            <div class="multi-choice-fold-summary" @click="stopSummaryToggle">
              <BinaryCheckbox
                :model-value="selectedValues.has(option.value)"
                :label="option.label"
                :disabled="disabled || option.disabled"
                @update:model-value="(checked) => updateOption(option.value, checked)"
              />
            </div>
          </template>
          <p v-if="option.description" class="multi-choice-fold-detail">{{ option.description }}</p>
          <p v-else class="multi-choice-fold-detail is-empty">{{ option.value }}</p>
        </ConfigFoldCard>
      </div>

      <div v-else class="multi-choice-card-grid">
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
    </template>

    <slot name="details" />
  </section>
</template>

<style scoped>
.multi-choice-card-group {
  display: grid;
  gap: var(--space-2-5);
  padding: var(--space-3);
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
  padding: var(--space-2-5);
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

.multi-choice-card-group[data-layout="list"] {
  padding: 0;
  border: 0;
  background: transparent;
  gap: 0;
}

.multi-choice-card-group[data-layout="list"] :deep(.multi-choice-list-card.config-fold-card),
.multi-choice-card-group[data-layout="list"] :deep(.config-fold-card.multi-choice-list-card) {
  margin-block: var(--space-4);
}

.multi-choice-card-group[data-layout="list"] :deep(.config-fold-body) {
  padding: 0;
  gap: 0;
  background: var(--bg-surface);
}

.multi-choice-card-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.multi-choice-list-row {
  display: block;
  width: 100%;
  min-width: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.multi-choice-list-row:last-child {
  border-bottom: 0;
}

.multi-choice-list-row[data-active="true"] {
  background: color-mix(in srgb, var(--info-surface) 70%, var(--bg-surface) 30%);
}

.multi-choice-list-select-all {
  background: var(--bg-subtle);
}

.multi-choice-list-select-all :deep(.binary-checkbox-label) {
  font-weight: var(--font-semibold);
}

.multi-choice-list-row[data-disabled="true"] {
  opacity: 0.58;
}

.multi-choice-list-row:hover:not([data-disabled="true"]) {
  background: color-mix(in srgb, var(--bg-subtle) 80%, var(--bg-surface) 20%);
}

.multi-choice-list-row[data-active="true"]:hover:not([data-disabled="true"]) {
  background: color-mix(in srgb, var(--info-surface) 80%, var(--bg-surface) 20%);
}

.multi-choice-card-list :deep(.binary-checkbox.multi-choice-list-item) {
  display: flex !important;
  width: 100% !important;
  max-width: none !important;
  justify-content: flex-start;
  box-sizing: border-box;
  min-height: 44px;
  padding: var(--space-2-5) var(--space-3-5);
  border: 0 !important;
  border-radius: 0 !important;
  outline: none !important;
  background: transparent !important;
  box-shadow: none !important;
  white-space: normal;
  color: var(--text-primary);
}

.multi-choice-card-list :deep(.binary-checkbox.multi-choice-list-item[data-checked="true"]) {
  color: var(--brand-strong);
  font-weight: var(--font-semibold);
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.multi-choice-card-list :deep(.binary-checkbox.multi-choice-list-item):hover {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--text-primary);
}

.multi-choice-card-list :deep(.binary-checkbox.multi-choice-list-item[data-checked="true"]):hover {
  color: var(--brand-strong);
  border: 0 !important;
  background: transparent !important;
}

.multi-choice-card-fold-list {
  display: grid;
  gap: var(--space-1-5);
  min-width: 0;
}

.multi-choice-fold-summary {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
}

.multi-choice-fold-detail {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.multi-choice-fold-detail.is-empty {
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-card) {
  border-radius: var(--radius-sm);
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-card + .config-fold-card) {
  margin-top: 0;
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-summary) {
  min-height: 44px;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-card[data-active="true"]) {
  border-color: var(--brand-muted);
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-card[data-active="true"] .config-fold-summary) {
  background: color-mix(in srgb, var(--info-surface) 70%, var(--bg-surface) 30%);
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-card[data-disabled="true"]) {
  opacity: 0.58;
}

.multi-choice-card-group[data-layout="fold"] :deep(.config-fold-body) {
  padding: var(--space-2) var(--space-3) var(--space-2-5);
  background: var(--bg-surface);
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
