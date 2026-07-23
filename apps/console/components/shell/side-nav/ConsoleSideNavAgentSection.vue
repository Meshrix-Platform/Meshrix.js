<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavAgentSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  hasAnyFeature,
  hasFeature,
  msg,
  openAdmin,
} = useConsoleSideNavContext();
const showAgentSection = computed(() =>
  hasAnyFeature("agent-gateway") &&
  (
    canAccessAdminView("agentConfig") ||
    canAccessAdminView("agentAssignment") ||
    canAccessAdminView("contextManagement")
  )
);
</script>

<template>
  <section
    v-if="showAgentSection"
    class="side-nav-section"
    :aria-label="msg.nav.agents"
  >
    <p class="side-nav-section-title">{{ msg.nav.agents }}</p>
    <ConsoleSideNavLink
      v-if="hasFeature('agent-gateway') && canAccessAdminView('agentConfig')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'agentConfig'"
      :label="msg.nav.agentConfig"
      href="#/admin/agent-config"
      subtle
      @activate="openAdmin('agentConfig')"
    />
    <ConsoleSideNavLink
      v-if="hasFeature('agent-gateway') && canAccessAdminView('agentAssignment')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'agentAssignment'"
      :label="msg.nav.agentAssignment"
      href="#/admin/agent-assignment"
      subtle
      @activate="openAdmin('agentAssignment')"
    />
    <ConsoleSideNavLink
      v-if="hasFeature('agent-gateway') && canAccessAdminView('contextManagement')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'contextManagement'"
      :label="msg.nav.contextManagement"
      href="#/admin/context-management"
      subtle
      @activate="openAdmin('contextManagement')"
    />
  </section>
</template>
