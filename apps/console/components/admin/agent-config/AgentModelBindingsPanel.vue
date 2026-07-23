<script setup lang="ts">
import type { AgentModelConfig } from "../../../lib/types";
import { useAgentModelEntryCardContext } from "../../../composables/agentModelEntryCardContext";
import ConfigFoldCard from "../../ConfigFoldCard.vue";

defineProps<{
  entry: AgentModelConfig;
}>();

const {
  modelEntryBindings,
  modelEntryIsBound,
} = useAgentModelEntryCardContext();
</script>

<template>
  <ConfigFoldCard
    v-if="modelEntryIsBound(entry)"
    class="model-library-bindings"
    :title="`被引用的功能（${modelEntryBindings(entry).length}）`"
  >
    <div class="model-library-binding-list">
      <article
        v-for="binding in modelEntryBindings(entry)"
        :key="binding.bindingId"
        class="model-library-binding-item"
      >
        <div>
          <strong>{{ binding.label }}</strong>
          <span>{{ binding.category }}</span>
        </div>
        <p>{{ binding.detail }}</p>
      </article>
    </div>
  </ConfigFoldCard>
</template>
