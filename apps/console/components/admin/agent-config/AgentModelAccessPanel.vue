<script setup lang="ts">
import type { AgentModelConfig } from "../../../lib/types";
import { useAgentModelEntryCardContext } from "../../../composables/agentModelEntryCardContext";
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import ConfigFoldCard from "../../ConfigFoldCard.vue";
import OptionBar from "@meshrix/ui-console/option-bar";

defineProps<{
  entry: AgentModelConfig;
}>();

const {
  intelligentModuleDefinitions,
  modelEntryModuleAccess,
  moduleAccessModeOptionBarOptions,
  setModelEntryModuleAccessMode,
  toggleModelEntryModuleAccess,
} = useAgentModelEntryCardContext();
</script>

<template>
  <ConfigFoldCard title="功能可见性">
    <OptionBar
      :model-value="modelEntryModuleAccess(entry).mode"
      label="开放范围"
      :options="moduleAccessModeOptionBarOptions"
      @update:model-value="setModelEntryModuleAccessMode(entry, String($event))"
    />
    <div
      v-if="modelEntryModuleAccess(entry).mode === 'selected'"
      class="model-library-module-access-list"
    >
      <BinaryCheckbox
        v-for="moduleDefinition in intelligentModuleDefinitions"
        :key="moduleDefinition.id"
        :model-value="modelEntryModuleAccess(entry).moduleIds.includes(moduleDefinition.id)"
        :label="moduleDefinition.label"
        @update:model-value="toggleModelEntryModuleAccess(entry, moduleDefinition.id, Boolean($event))"
      />
    </div>
    <p class="module-note">
      没有授权给某个功能时，该功能的智能体选项中不会出现这个智能体。
    </p>
  </ConfigFoldCard>
</template>
