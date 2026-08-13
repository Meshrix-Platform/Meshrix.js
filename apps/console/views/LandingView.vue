<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import MeshrixJsMark from "../components/MeshrixJsMark.vue";
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
      <!-- Meshrix.js mark -->
      <div class="landing-mark">
        <MeshrixJsMark />
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
