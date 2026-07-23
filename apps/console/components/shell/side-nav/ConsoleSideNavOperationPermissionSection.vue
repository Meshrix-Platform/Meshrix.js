<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavOperationPermissionSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  msg,
  openAdmin,
} = useConsoleSideNavContext();
const showOperationPermissionSection = computed(() =>
  canAccessAdminView("toolList") ||
  canAccessAdminView("toolGovernance") ||
  canAccessAdminView("toolStats")
);
</script>

<template>
  <section
    v-if="showOperationPermissionSection"
    class="side-nav-section"
    :aria-label="msg.nav.agentTools"
  >
    <p class="side-nav-section-title">{{ msg.nav.agentTools }}</p>
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
