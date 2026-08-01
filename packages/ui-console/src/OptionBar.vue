<script setup lang="ts">
import { Moon, Sunny } from "@element-plus/icons-vue";
import type { Component } from "vue";

type OptionBarValue = string | number | boolean;
type OptionBarModelValue = OptionBarValue | OptionBarValue[];
type OptionBarIcon = "moon" | "sun";
type OptionBarOption = {
  value: OptionBarValue;
  label: string;
  disabled?: boolean;
  icon?: OptionBarIcon;
  swatches?: string[];
};

const props = withDefaults(defineProps<{
  modelValue: OptionBarModelValue;
  options: OptionBarOption[];
  label?: string;
  placeholder?: string;
  multiple?: boolean;
  collapseTags?: boolean;
  collapseTagsTooltip?: boolean;
  filterable?: boolean;
  teleported?: boolean;
  persistent?: boolean;
  popperClass?: string;
  disabled?: boolean;
  clearable?: boolean;
  size?: string;
}>(), {
  label: "",
  placeholder: "",
  multiple: false,
  collapseTags: false,
  collapseTagsTooltip: true,
  filterable: false,
  teleported: true,
  persistent: false,
  popperClass: "meshrix-select-popper",
  disabled: false,
  clearable: false,
  size: "default",
});

const emit = defineEmits<{
  "update:modelValue": [value: OptionBarModelValue];
  change: [value: OptionBarModelValue];
}>();

const optionIconComponents: Record<OptionBarIcon, Component> = {
  moon: Moon,
  sun: Sunny,
};

function optionIconComponent(icon?: OptionBarIcon) {
  return icon ? optionIconComponents[icon] : undefined;
}

function optionIconForValue(value: unknown) {
  const option = props.options.find((item: any) => Object.is(item.value, value));
  return optionIconComponent(option?.icon);
}

function updateValue(value: OptionBarModelValue) {
  emit("update:modelValue", value);
}

function changeValue(value: OptionBarModelValue) {
  emit("change", value);
}
</script>

<template>
  <label class="option-bar" :data-has-label="Boolean(label)">
    <span v-if="label" class="option-bar-label">{{ label }}</span>
    <el-select
      class="option-bar-select"
      :model-value="modelValue"
      :multiple="multiple"
      :collapse-tags="collapseTags"
      :collapse-tags-tooltip="collapseTagsTooltip"
      :teleported="teleported"
      :filterable="filterable"
      :placeholder="placeholder"
      :persistent="persistent"
      :popper-class="popperClass"
      :disabled="disabled"
      :clearable="clearable"
      :size="size"
      @update:model-value="updateValue"
      @change="changeValue"
    >
      <template #label="{ label: selectedLabel, value: selectedValue }">
        <span class="option-bar-value-row" :data-has-icon="Boolean(optionIconForValue(selectedValue))">
          <component
            :is="optionIconForValue(selectedValue)"
            v-if="optionIconForValue(selectedValue)"
            class="option-bar-option-icon"
            aria-hidden="true"
          />
          <span class="option-bar-value-label">{{ selectedLabel }}</span>
        </span>
      </template>
      <el-option
        v-for="option in options"
        :key="String(option.value)"
        :label="option.label"
        :value="option.value"
        :disabled="option.disabled"
      >
        <span
          class="option-bar-option-row"
          :data-has-icon="Boolean(option.icon)"
          :data-has-swatches="Boolean(option.swatches?.length)"
        >
          <span class="option-bar-option-main">
            <component
              :is="optionIconComponent(option.icon)"
              v-if="optionIconComponent(option.icon)"
              class="option-bar-option-icon"
              aria-hidden="true"
            />
            <span class="option-bar-option-label">{{ option.label }}</span>
          </span>
          <span v-if="option.swatches?.length" class="option-bar-option-swatches" aria-hidden="true">
            <span
              v-for="(swatch, index) in option.swatches"
              :key="`${String(option.value)}-${index}-${swatch}`"
              class="option-bar-option-swatch"
              :style="{ backgroundColor: swatch }"
            />
          </span>
        </span>
      </el-option>
    </el-select>
  </label>
</template>

<style scoped>
.option-bar {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.option-bar[data-has-label="false"] { gap: 0; }

.option-bar-label {
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
  color: var(--text-secondary);
}

.option-bar-select { width: 100%; min-width: 0; }

.option-bar-value-row,
.option-bar-option-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.option-bar-option-row {
  justify-content: space-between;
  width: 100%;
}

.option-bar-value-row {
  color: inherit;
}

.option-bar-option-main {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.option-bar-value-label,
.option-bar-option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-bar-option-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  color: var(--text-secondary);
}

.option-bar-option-swatches {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.option-bar-option-swatch {
  width: 12px;
  height: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
}
</style>
