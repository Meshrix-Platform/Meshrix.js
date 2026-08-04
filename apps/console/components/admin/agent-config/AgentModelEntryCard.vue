<script setup lang="ts">
import type { AgentModelConfig } from "../../../lib/types";
import { useServerConsoleShellContext } from "@meshrix/ui-console/server-console-shell-context";
import {
  createAgentModelEntryCardContext,
  provideAgentModelEntryCardContext,
} from "../../../composables/agentModelEntryCardContext";
import AgentModelAccessPanel from "./AgentModelAccessPanel.vue";
import AgentModelBindingsPanel from "./AgentModelBindingsPanel.vue";
import AgentModelEntryHeader from "./AgentModelEntryHeader.vue";
import AgentModelEntrySummaryActions from "./AgentModelEntrySummaryActions.vue";
import AgentModelPromptPanel from "./AgentModelPromptPanel.vue";
import AgentModelProviderFields from "./AgentModelProviderFields.vue";

defineProps<{
  entry: AgentModelConfig;
}>();

const shell = useServerConsoleShellContext();
const {
  isModelLibraryCardExpanded,
} = shell;

provideAgentModelEntryCardContext(createAgentModelEntryCardContext(shell));
</script>

<template>
  <section
    class="model-library-card"
    :data-expanded="isModelLibraryCardExpanded(entry) ? 'true' : 'false'"
  >
    <AgentModelEntryHeader :entry="entry" />

    <AgentModelEntrySummaryActions :entry="entry" />
    <div v-if="isModelLibraryCardExpanded(entry)" class="model-library-card-body">
      <div class="form-grid compact-form-grid">
        <label>
          <span>智能体名称</span>
          <input v-model="entry.label" autocomplete="off" />
        </label>
        <label>
          <span>模型 ID</span>
          <input v-model="entry.model" autocomplete="off" />
        </label>
      </div>

      <AgentModelProviderFields :entry="entry" />
      <AgentModelAccessPanel :entry="entry" />
      <AgentModelBindingsPanel :entry="entry" />
      <AgentModelPromptPanel :entry="entry" />
    </div>
  </section>
</template>
