<script setup lang="ts">
import { useServerConsoleShellContext } from "../../../composables/serverConsoleShellContext";
import OptionBar from "@meshrix/ui-console/option-bar";
import AgentModelEntryCard from "./AgentModelEntryCard.vue";

const {
  addModelProvider,
  addableModelProviderOptionBarOptions,
  busyKey,
  highlightedConfigTarget,
  saveModelLibrarySettings,
  selectedModelProvider,
  visibleModelEntries,
} = useServerConsoleShellContext();
</script>

<template>
  <article
    class="surface-card"
    data-config-target="agent-model-library"
    :data-config-highlighted="highlightedConfigTarget === 'agent-model-library'"
  >
    <form class="drawer-panel" @submit.prevent="saveModelLibrarySettings">
      <div class="section-header">
        <div>
          <h3>模型库</h3>
        </div>
      </div>

      <div class="model-library-toolbar">
        <OptionBar
          v-model="selectedModelProvider"
          :options="addableModelProviderOptionBarOptions"
        />
        <button
          class="tool-button"
          type="button"
          @click="addModelProvider"
        >
          新增模型
        </button>
      </div>

      <p v-if="visibleModelEntries.length === 0" class="empty-note">
        当前模型库为空。
      </p>

      <div v-else class="model-library-list">
        <AgentModelEntryCard
          v-for="entry in visibleModelEntries"
          :key="entry.instanceId"
          :entry="entry"
        />
      </div>

      <div class="source-actions model-library-save-actions">
        <button class="tool-button" type="submit" :disabled="busyKey === 'model-library-save'">
          {{ busyKey === "model-library-save" ? "探测并保存中" : "保存配置" }}
        </button>
      </div>
    </form>
  </article>
</template>
