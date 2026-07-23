<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavVersionSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  msg,
  openAdmin,
} = useConsoleSideNavContext();
const showVersionSection = computed(() =>
  canAccessAdminView("versionRelease") ||
  canAccessAdminView("productionHealth") ||
  canAccessAdminView("versionAssembly")
);
</script>

<template>
  <section v-if="showVersionSection" class="side-nav-section" :aria-label="msg.nav.version">
    <p class="side-nav-section-title">{{ msg.nav.version }}</p>
    <ConsoleSideNavLink
      v-if="canAccessAdminView('versionRelease')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'versionRelease'"
      :label="msg.nav.versionRelease"
      href="#/admin/version-release"
      subtle
      @activate="openAdmin('versionRelease')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('productionHealth')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'productionHealth'"
      :label="msg.nav.productionHealth"
      href="#/admin/production-health"
      subtle
      @activate="openAdmin('productionHealth')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('versionAssembly')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'versionAssembly'"
      :label="msg.nav.versionAssembly"
      href="#/admin/version-assembly"
      subtle
      @activate="openAdmin('versionAssembly')"
    />
  </section>
</template>
