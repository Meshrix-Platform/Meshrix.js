<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavSystemSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  msg,
  openAdmin,
} = useConsoleSideNavContext();
const showSystemSection = computed(() =>
  canAccessAdminView("storage") ||
  canAccessAdminView("modules") ||
  canAccessAdminView("strategyManagement") ||
  canAccessAdminView("logs")
);
</script>

<template>
  <section v-if="showSystemSection" class="side-nav-section" :aria-label="msg.nav.system">
    <p class="side-nav-section-title">{{ msg.nav.system }}</p>
    <ConsoleSideNavLink
      v-if="canAccessAdminView('storage')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'storage'"
      :label="msg.nav.overview"
      href="#/admin/storage"
      subtle
      @activate="openAdmin('storage')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('modules')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'modules'"
      :label="msg.nav.modules"
      href="#/admin/modules"
      subtle
      @activate="openAdmin('modules')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('strategyManagement')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'strategyManagement'"
      :label="msg.nav.strategyManagement"
      href="#/admin/strategy-management"
      subtle
      @activate="openAdmin('strategyManagement')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('logs')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'logs'"
      :label="msg.nav.logs"
      href="#/admin/logs"
      subtle
      @activate="openAdmin('logs')"
    />
  </section>
</template>
