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
          <stop class="brand-gold-0" offset="0%"/><stop class="brand-gold-1" offset="50%"/><stop class="brand-gold-2" offset="100%"/>
        </linearGradient>
        <linearGradient id="bm-silver" x1="0" y1="1" x2="1" y2="0">
          <stop class="brand-silver-0" offset="0%"/><stop class="brand-silver-1" offset="100%"/>
        </linearGradient>
      </defs>
      <polygon fill="none" points="115.5,47.8 47.8,115.5 -47.8,115.5 -115.5,47.8 -115.5,-47.8 -47.8,-115.5 47.8,-115.5 115.5,-47.8" stroke="url(#bm-gold)" stroke-width="6" opacity="0.75"/>
      <circle class="brand-ring-primary" r="113" fill="none" stroke-width="4" opacity="0.5"/>
      <circle cx="-16" cy="16" r="89" fill="none" stroke="url(#bm-silver)" stroke-width="3.5" opacity="0.45"/>
      <circle class="brand-ring-secondary" cx="13" cy="-10" r="63" fill="none" stroke-width="3.5" opacity="0.5"/>
      <circle r="36" fill="none" stroke="url(#bm-gold)" stroke-width="4" opacity="0.6"/>
      <circle class="brand-dot" r="6" opacity="0.6"/>
    </svg>
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

<style scoped>
.brand-mark .brand-gold-0 { stop-color: var(--brand); }
.brand-mark .brand-gold-1 { stop-color: var(--brand-strong); }
.brand-mark .brand-gold-2 { stop-color: var(--brand-muted); }
.brand-mark .brand-silver-0 { stop-color: var(--text-muted); }
.brand-mark .brand-silver-1 { stop-color: var(--text-secondary); }
.brand-mark .brand-ring-primary { stroke: var(--text-primary); }
.brand-mark .brand-ring-secondary { stroke: var(--text-secondary); }
.brand-mark .brand-dot { fill: var(--brand); }
</style>
