<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavSystemSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  hasFeature,
  msg,
  openAdmin,
} = useConsoleSideNavContext();
const showSystemSection = computed(() =>
  canAccessAdminView("storage") ||
  canAccessAdminView("modules") ||
  canAccessAdminView("strategyManagement") ||
  canAccessAdminView("tagManagement") ||
  canAccessAdminView("logs")
);
const showOperationsSection = computed(() =>
  canAccessAdminView("jobs") ||
  canAccessAdminView("opsMonitor") ||
  canAccessAdminView("maintenanceAgent")
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
    <ConsoleSideNavLink v-if="hasFeature('tag-management') && canAccessAdminView('tagManagement')" :active="activeRouteView === 'admin' && activeRouteAdminView === 'tagManagement'" :label="msg.nav.tagManagement" href="#/admin/tag-management" subtle @activate="openAdmin('tagManagement')" />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('logs')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'logs'"
      :label="msg.nav.logs"
      href="#/admin/logs"
      subtle
      @activate="openAdmin('logs')"
    />
  </section>
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
    <ConsoleSideNavLink
      v-if="hasFeature('maintenance-agent-runbooks') && canAccessAdminView('maintenanceAgent')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'maintenanceAgent'"
      :label="msg.nav.maintenanceAgent"
      href="#/admin/maintenance-agent"
      subtle
      @activate="openAdmin('maintenanceAgent')"
    />
  </section>
</template>
