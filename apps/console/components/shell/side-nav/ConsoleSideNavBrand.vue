<script setup lang="ts">
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";

defineOptions({ name: "ConsoleSideNavBrand" });

const { consoleState, msg, tt } = useConsoleSideNavContext();
</script>

<template>
  <div class="brand-block" :class="{ 'is-loading': !consoleState }">
    <svg class="brand-mark" aria-hidden="true" viewBox="-150 -150 300 300" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bm-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#fef100"/><stop offset="50%" stop-color="#fff75c"/><stop offset="100%" stop-color="#6b6117"/>
        </linearGradient>
        <linearGradient id="bm-silver" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="#969696"/><stop offset="100%" stop-color="#c8c8c8"/>
        </linearGradient>
      </defs>
      <polygon fill="none" points="115.5,47.8 47.8,115.5 -47.8,115.5 -115.5,47.8 -115.5,-47.8 -47.8,-115.5 47.8,-115.5 115.5,-47.8" stroke="url(#bm-gold)" stroke-width="6" opacity="0.75"/>
      <circle r="113" fill="none" stroke="#ededed" stroke-width="4" opacity="0.5"/>
      <circle cx="-16" cy="16" r="89" fill="none" stroke="url(#bm-silver)" stroke-width="3.5" opacity="0.45"/>
      <circle cx="13" cy="-10" r="63" fill="none" stroke="#c8c8c8" stroke-width="3.5" opacity="0.5"/>
      <circle r="36" fill="none" stroke="url(#bm-gold)" stroke-width="4" opacity="0.6"/>
      <circle r="6" fill="#fef100" opacity="0.6"/>
    </svg>
    <div class="brand-text">
      <h1>LicoMesh</h1>
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
