<script setup lang="ts">
import { computed } from "vue";
import type { AgentModelConfig } from "../../../lib/types";
import { useAgentModelEntryCardContext } from "../../../composables/agentModelEntryCardContext";

const props = defineProps<{
  entry: AgentModelConfig;
}>();

const {
  busyKey,
  duplicateModelEntry,
  exportAgentModelEntryConfig,
  modelEntryBindingSummary,
  modelEntryIsBound,
  modelEntryStatusKey,
  modelProbeResults,
  probeModelEntry,
  removeModelProvider,
} = useAgentModelEntryCardContext();

const entryKey = computed(() => modelEntryStatusKey(props.entry));
const probeBusy = computed(() => busyKey.value === `model-probe:${entryKey.value}`);
const removeBusy = computed(() => busyKey.value === `model-remove:${entryKey.value}`);
const probeResult = computed(() => modelProbeResults.value[entryKey.value]);
const boundTitle = computed(() =>
  modelEntryIsBound(props.entry)
    ? `已绑定到 ${modelEntryBindingSummary(props.entry)}，请先解除引用。`
    : "",
);
</script>

<template>
  <div class="model-library-summary-row">
    <div class="model-library-uid">
      <code>{{ entryKey }}</code>
    </div>

    <div class="model-library-card-actions">
      <button class="tool-button tool-button-ghost compact-action" type="button" :disabled="probeBusy" @click.stop="probeModelEntry(entry)">
        {{ probeBusy ? "探测中" : "探测" }}
      </button>
      <button class="tool-button tool-button-ghost compact-action" type="button" @click.stop="exportAgentModelEntryConfig(entry)">
        导出
      </button>
      <button class="tool-button tool-button-ghost compact-action" type="button" @click.stop="duplicateModelEntry(entry)">
        复制
      </button>
      <button
        class="tool-button tool-button-ghost compact-action"
        type="button"
        :disabled="removeBusy || modelEntryIsBound(entry)"
        :title="boundTitle"
        @click.stop="removeModelProvider(entry)"
      >
        {{ removeBusy ? "移除中" : "移除" }}
      </button>
    </div>
  </div>

  <p v-if="probeResult" class="model-probe-result" :data-ok="probeResult.ok ? 'true' : 'false'">
    <span class="model-probe-response">
      <strong v-if="probeResult.statusCode">
        HTTP {{ probeResult.statusCode }}
      </strong>
      <span v-if="probeResult.statusCode" class="model-probe-separator">/</span>
      <span>{{ probeResult.answerSnippet || probeResult.message }}</span>
    </span>
    <small>{{ probeResult.latencyMs }}ms</small>
  </p>
</template>
