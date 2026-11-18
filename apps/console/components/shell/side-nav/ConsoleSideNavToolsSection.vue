<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavToolsSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  msg,
  openAdmin,
} = useConsoleSideNavContext();
const showToolsSection = computed(() =>
  canAccessAdminView("toolList") ||
  canAccessAdminView("toolGovernance") ||
  canAccessAdminView("toolStats")
);
</script>

<template>
  <section
    v-if="showToolsSection"
    class="side-nav-section"
    :aria-label="msg.nav.tools"
  >
    <p class="side-nav-section-title">{{ msg.nav.tools }}</p>
    <ConsoleSideNavLink
      v-if="canAccessAdminView('toolList')"
      :active="activeRouteView === 'admin' && (activeRouteAdminView === 'tools' || activeRouteAdminView === 'toolList')"
      :label="msg.nav.toolList"
      href="#/admin/tool-list"
      subtle
      @activate="openAdmin('toolList')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('toolGovernance')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'toolGovernance'"
      :label="msg.nav.toolGovernance"
      href="#/admin/tool-governance"
      subtle
      @activate="openAdmin('toolGovernance')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('toolStats')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'toolStats'"
      :label="msg.nav.toolStats"
      href="#/admin/tool-stats"
      subtle
      @activate="openAdmin('toolStats')"
    />
  </section>
</template>
