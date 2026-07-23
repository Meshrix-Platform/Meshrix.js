<script setup lang="ts">
import type { AgentModelConfig } from "../../../lib/types";
import ConfigFoldCard from "../../ConfigFoldCard.vue";

defineProps<{
  entry: AgentModelConfig;
}>();
</script>

<template>
  <ConfigFoldCard title="智能体提示词与调用参数">
    <label>
      <span>系统提示词</span>
      <textarea v-model="entry.systemPrompt" rows="5" autocomplete="off"></textarea>
    </label>
    <label>
      <span>调用参数 JSON</span>
      <textarea v-model="entry.parametersText" rows="6" spellcheck="false"></textarea>
    </label>
  </ConfigFoldCard>
</template>
