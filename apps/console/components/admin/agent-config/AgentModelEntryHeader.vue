<script setup lang="ts">
import type { AgentModelConfig } from "../../../lib/types";
import { useAgentModelEntryCardContext } from "../../../composables/agentModelEntryCardContext";
import StatusPill from "@meshrix/ui-console/status-pill";

import { currentConsoleLocale, localizeConsoleText } from "../../../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

defineProps<{
  entry: AgentModelConfig;
}>();

const {
  isModelLibraryCardExpanded,
  modelEntryIsBound,
  modelEntryProbeResult,
  modelEntryProbeStatusLabel,
  modelEntryProbeStatusTone,
  modelEntryStatusKey,
  modelProviderDefinition,
  providerLabel,
  toggleModelLibraryCard,
} = useAgentModelEntryCardContext();
</script>

<template>
  <button
    class="model-library-card-toggle"
    type="button"
    :aria-expanded="isModelLibraryCardExpanded(entry) ? 'true' : 'false'"
    :aria-label="`${entry.label || modelEntryStatusKey(entry)} ${isModelLibraryCardExpanded(entry) ? '收起配置' : '展开配置'}`"
    :title="isModelLibraryCardExpanded(entry) ? '收起配置' : '展开配置'"
    @click="toggleModelLibraryCard(entry)"
  >
    <div class="model-library-card-header">
      <div>
        <strong>{{ entry.label || modelEntryStatusKey(entry) }}</strong>
        <small>
          {{ modelProviderDefinition(entry.provider)?.label || providerLabel(entry.provider) }}
          /
          {{ entry.model || modelEntryStatusKey(entry) }}
        </small>
      </div>
      <div class="model-library-card-statuses">
        <StatusPill
          v-if="modelEntryIsBound(entry)"
          tone="info"
          :label="localizeStatusPillLabel('已绑定')"
        />
        <StatusPill
          v-if="modelEntryProbeResult(entry)"
          :tone="modelEntryProbeStatusTone(entry)"
          :label="localizeStatusPillLabel(modelEntryProbeStatusLabel(entry))"
        />
      </div>
    </div>
    <span
      class="model-library-expand-icon"
      :data-expanded="isModelLibraryCardExpanded(entry)"
      aria-hidden="true"
    >
      <span />
    </span>
  </button>
</template>
