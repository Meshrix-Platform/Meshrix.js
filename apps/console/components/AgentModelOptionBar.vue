<script setup lang="ts">
import {
  EMPTY_MODEL_LIBRARY_ACTION,
  useAgentModelOptionBarController,
  type AgentModelOptionBarEmits,
  type AgentModelOptionBarProps,
} from "../composables/agentModelOptionBarController";

defineOptions({ name: "AgentModelOptionBar" });

const props = withDefaults(defineProps<AgentModelOptionBarProps>(), {
  modelValue: "",
  label: "",
  placeholder: "未选择智能体",
  disabled: false,
  includeEmpty: false,
  emptyLabel: "未分配智能体",
  showDisabledReason: true,
  filterable: false,
  teleported: true,
  persistent: false,
  popperClass: "",
  clearable: false,
  size: "default",
  emptyLibraryLabel: "当前模型库为空，请前往大模型配置。",
  emptyLibraryRoute: "/admin/agent-config",
  emptyLibraryActionIcon: "+",
});

const emit = defineEmits<AgentModelOptionBarEmits>();

const {
  emptyLibraryActionLabel,
  handleChange,
  handleSelectClick,
  handleSelectKeydown,
  hasConfiguredOptions,
  selectOptions,
  selectValue,
} = useAgentModelOptionBarController(props, emit);
</script>

<template>
  <label
    class="agent-option-bar"
    :data-has-label="Boolean(label)"
    :data-size="size"
    :data-disabled="disabled"
  >
    <span v-if="label" class="agent-option-label">{{ label }}</span>
    <span class="agent-option-shell" :data-empty-library="!hasConfiguredOptions">
      <span v-if="!hasConfiguredOptions" class="agent-option-empty-action" aria-hidden="true">
        <span class="agent-option-add-icon">{{ emptyLibraryActionIcon || "+" }}</span>
        <span class="agent-option-empty-text">{{ emptyLibraryLabel }}</span>
      </span>
      <select
        class="agent-option-select"
        :value="selectValue"
        :disabled="disabled"
        @click="handleSelectClick"
        @keydown="handleSelectKeydown"
        @change="handleChange"
      >
        <option v-if="!hasConfiguredOptions" :value="EMPTY_MODEL_LIBRARY_ACTION">
          {{ emptyLibraryActionLabel }}
        </option>
        <template v-else>
          <option v-if="includeEmpty" value="">{{ emptyLabel }}</option>
          <option v-else-if="!modelValue" value="" disabled>{{ placeholder }}</option>
          <option
            v-for="option in selectOptions"
            :key="String(option.value)"
            :value="String(option.value)"
            :disabled="option.disabled"
          >
            {{ option.label }}
          </option>
        </template>
      </select>
      <span class="agent-option-chevron" aria-hidden="true"></span>
    </span>
  </label>
</template>

<style scoped src="./AgentModelOptionBar.css"></style>
