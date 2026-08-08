<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import {
  currentConsoleLocale,
  resolveEffectiveConsoleLocale,
} from "../i18n/console";

const router = useRouter();
function goToConsole() {
  void router.push("/login");
}

const isZh = computed(() => resolveEffectiveConsoleLocale(currentConsoleLocale.value) !== "en");
const tagline = computed(() =>
  isZh.value ? "面向 AI 智能体的可追溯共享工作空间" : "Traceable Shared Workspace for AI Agents",
);
const ctaLabel = computed(() => (isZh.value ? "进入控制台" : "Open Console"));
</script>

<template>
  <div class="landing">
    <div class="landing-center">
      <!-- Crystal Icon -->
      <div class="landing-crystal">
        <svg viewBox="-150 -150 300 300" aria-label="Meshrix.js">
          <defs>
            <linearGradient id="lp-gold" x1="0" y1="0" x2="1" y2="1">
              <stop class="crystal-gold-0" offset="0%" />
              <stop class="crystal-gold-1" offset="50%" />
              <stop class="crystal-gold-2" offset="100%" />
            </linearGradient>
            <linearGradient id="lp-ice" x1="0" y1="0" x2="1" y2="1">
              <stop class="crystal-ice-0" offset="0%" />
              <stop class="crystal-ice-0" offset="50%" />
              <stop class="crystal-ice-2" offset="100%" />
            </linearGradient>
            <linearGradient id="lp-facet" x1="0" y1="0" x2="0.5" y2="1">
              <stop class="crystal-facet-0" offset="0%" stop-opacity="0.06" />
              <stop class="crystal-facet-0" offset="100%" stop-opacity="0" />
            </linearGradient>
          </defs>
          <polygon points="0,-130 112.6,-65 112.6,65 0,130 -112.6,65 -112.6,-65" fill="none" stroke="url(#lp-gold)" stroke-width="0.6" opacity="0.3" />
          <polygon points="0,-120 103.9,-60 103.9,60 0,120 -103.9,60 -103.9,-60" fill="none" stroke="url(#lp-ice)" stroke-width="0.4" opacity="0.2" transform="rotate(30)" />
          <line x1="0" y1="-95" x2="0" y2="95" stroke="url(#lp-ice)" stroke-width="0.5" opacity="0.2" />
          <line x1="-82.3" y1="-47.5" x2="82.3" y2="47.5" stroke="url(#lp-ice)" stroke-width="0.5" opacity="0.2" />
          <line x1="-82.3" y1="47.5" x2="82.3" y2="-47.5" stroke="url(#lp-ice)" stroke-width="0.5" opacity="0.2" />
          <polygon points="0,-60 52,-30 52,30 0,60 -52,30 -52,-30" fill="url(#lp-facet)" stroke="url(#lp-gold)" stroke-width="1.2" opacity="0.5" />
          <circle class="crystal-dot-info" cx="0" cy="-60" r="2" opacity="0.45" />
          <circle class="crystal-dot-brand" cx="52" cy="-30" r="2" opacity="0.45" />
          <circle class="crystal-dot-info" cx="52" cy="30" r="2" opacity="0.4" />
          <circle class="crystal-dot-brand" cx="0" cy="60" r="2" opacity="0.45" />
          <circle class="crystal-dot-info" cx="-52" cy="30" r="2" opacity="0.4" />
          <circle class="crystal-dot-brand" cx="-52" cy="-30" r="2" opacity="0.45" />
          <circle r="4" fill="url(#lp-gold)" opacity="0.6" />
          <circle class="crystal-dot-white" r="2" opacity="0.5" />
        </svg>
      </div>

      <!-- Title -->
      <h1 class="landing-title">MESHRIX</h1>
      <p class="landing-tagline" :class="{ 'landing-tagline--zh': isZh }">{{ tagline }}</p>

      <!-- Prismatic divider -->
      <div class="landing-prism-line" aria-hidden="true"></div>

      <!-- CTA -->
      <button class="landing-btn landing-btn--hero" @click="goToConsole">{{ ctaLabel }}</button>
    </div>

    <!-- Footer -->
    <footer class="landing-footer">
      <span class="landing-version">v0.0.1</span>
      <span class="landing-divider">|</span>
      <span>&copy; 2026 Meshrix.js Contributors</span>
      <span class="landing-sep">&middot;</span>
      <span>GPL Licensed</span>
    </footer>
  </div>
</template>

<style scoped>
.landing-crystal .crystal-gold-0 { stop-color: var(--brand); }
.landing-crystal .crystal-gold-1 { stop-color: var(--brand-strong); }
.landing-crystal .crystal-gold-2 { stop-color: var(--brand-muted); }
.landing-crystal .crystal-ice-0 { stop-color: var(--info); }
.landing-crystal .crystal-ice-2 { stop-color: var(--info-border); }
.landing-crystal .crystal-facet-0 { stop-color: var(--text-primary); }
.landing-crystal .crystal-dot-info { fill: var(--info); }
.landing-crystal .crystal-dot-brand { fill: var(--brand); }
.landing-crystal .crystal-dot-white { fill: var(--text-primary); }
</style>
