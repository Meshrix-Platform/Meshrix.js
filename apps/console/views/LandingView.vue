<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();
function goToConsole() {
  void router.push("/login");
}
</script>

<template>
  <div class="landing">
    <div class="landing-center">
      <!-- Crystal Icon -->
      <div class="landing-crystal">
        <svg viewBox="-150 -150 300 300" aria-label="LicoMesh">
          <defs>
            <linearGradient id="lp-gold" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#fef100" />
              <stop offset="50%" stop-color="#fff75c" />
              <stop offset="100%" stop-color="#6b6117" />
            </linearGradient>
            <linearGradient id="lp-ice" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#5ed7f2" />
              <stop offset="50%" stop-color="#5ed7f2" />
              <stop offset="100%" stop-color="#155c70" />
            </linearGradient>
            <linearGradient id="lp-facet" x1="0" y1="0" x2="0.5" y2="1">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.06" />
              <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
            </linearGradient>
          </defs>
          <polygon points="0,-130 112.6,-65 112.6,65 0,130 -112.6,65 -112.6,-65" fill="none" stroke="url(#lp-gold)" stroke-width="0.6" opacity="0.3" />
          <polygon points="0,-120 103.9,-60 103.9,60 0,120 -103.9,60 -103.9,-60" fill="none" stroke="url(#lp-ice)" stroke-width="0.4" opacity="0.2" transform="rotate(30)" />
          <line x1="0" y1="-95" x2="0" y2="95" stroke="url(#lp-ice)" stroke-width="0.5" opacity="0.2" />
          <line x1="-82.3" y1="-47.5" x2="82.3" y2="47.5" stroke="url(#lp-ice)" stroke-width="0.5" opacity="0.2" />
          <line x1="-82.3" y1="47.5" x2="82.3" y2="-47.5" stroke="url(#lp-ice)" stroke-width="0.5" opacity="0.2" />
          <polygon points="0,-60 52,-30 52,30 0,60 -52,30 -52,-30" fill="url(#lp-facet)" stroke="url(#lp-gold)" stroke-width="1.2" opacity="0.5" />
          <circle cx="0" cy="-60" r="2" fill="#5ed7f2" opacity="0.45" />
          <circle cx="52" cy="-30" r="2" fill="#fef100" opacity="0.45" />
          <circle cx="52" cy="30" r="2" fill="#5ed7f2" opacity="0.4" />
          <circle cx="0" cy="60" r="2" fill="#fef100" opacity="0.45" />
          <circle cx="-52" cy="30" r="2" fill="#5ed7f2" opacity="0.4" />
          <circle cx="-52" cy="-30" r="2" fill="#fef100" opacity="0.45" />
          <circle r="4" fill="url(#lp-gold)" opacity="0.6" />
          <circle r="2" fill="#ffffff" opacity="0.5" />
        </svg>
      </div>

      <!-- Title -->
      <h1 class="landing-title">LICOMESH</h1>
      <p class="landing-tagline">Traceable Shared Workspace for AI Agents</p>

      <!-- Prismatic divider -->
      <div class="landing-prism-line" aria-hidden="true"></div>

      <!-- CTA -->
      <button class="landing-btn landing-btn--hero" @click="goToConsole">Open Console</button>
    </div>

    <!-- Footer -->
    <footer class="landing-footer">
      <span class="landing-version">v0.0.1</span>
      <span class="landing-divider">|</span>
      <span>&copy; 2026 LicoMesh Contributors</span>
      <span class="landing-sep">&middot;</span>
      <span>GPL Licensed</span>
    </footer>
  </div>
</template>
