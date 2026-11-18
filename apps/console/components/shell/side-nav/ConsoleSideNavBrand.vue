<script setup lang="ts">
import MeshrixJsMark from "../../MeshrixJsMark.vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";

defineOptions({ name: "ConsoleSideNavBrand" });

const { consoleState, msg, tt } = useConsoleSideNavContext();
</script>

<template>
  <div class="brand-block" :class="{ 'is-loading': !consoleState }">
    <MeshrixJsMark class="brand-mark" />
    <div class="brand-text">
      <h1>Meshrix.js</h1>
      <p class="brand-subtitle">
        <span v-if="!consoleState" class="brand-loading-label" aria-live="polite">
          {{ msg.loading }}
          <span class="brand-loading-dots" aria-hidden="true">
            <span></span><span></span><span></span>
          </span>
        </span>
        <span v-else>{{ tt("控制面板") }}</span>
      </p>
    </div>
    <div v-if="!consoleState" class="brand-progress-bar" aria-hidden="true">
      <div class="brand-progress-fill"></div>
    </div>
  </div>
</template>
