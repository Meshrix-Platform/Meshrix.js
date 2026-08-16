<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavOperationsSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  msg,
  openAdmin,
} = useConsoleSideNavContext();

const showOperationsSection = computed(() =>
  canAccessAdminView("jobs") ||
  canAccessAdminView("opsMonitor")
);
</script>

<template>
  <section v-if="showOperationsSection" class="side-nav-section" :aria-label="msg.nav.operations">
    <p class="side-nav-section-title">{{ msg.nav.operations }}</p>
    <ConsoleSideNavLink
      v-if="canAccessAdminView('jobs')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'jobs'"
      :label="msg.nav.jobs"
      href="#/admin/jobs"
      subtle
      @activate="openAdmin('jobs')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('opsMonitor')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'opsMonitor'"
      :label="msg.nav.opsMonitor"
      href="#/admin/ops-monitor"
      subtle
      @activate="openAdmin('opsMonitor')"
    />
  </section>
</template>
