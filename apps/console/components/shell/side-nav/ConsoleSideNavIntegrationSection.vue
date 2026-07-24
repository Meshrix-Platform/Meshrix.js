<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavIntegrationSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  msg,
  openAdmin,
} = useConsoleSideNavContext();

const showIntegrationSection = computed(() =>
  canAccessAdminView("upstreamServices")
);
</script>

<template>
  <section v-if="showIntegrationSection" class="side-nav-section" :aria-label="msg.nav.integrations">
    <p class="side-nav-section-title">{{ msg.nav.integrations }}</p>
    <ConsoleSideNavLink
      v-if="canAccessAdminView('upstreamServices')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'upstreamServices'"
      :label="msg.nav.upstreamServices"
      href="#/admin/upstream-services"
      subtle
      @activate="openAdmin('upstreamServices')"
    />
    <ConsoleSideNavLink
      v-if="canAccessAdminView('upstreamServicePublish')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'upstreamServicePublish'"
      :label="msg.nav.upstreamServicePublish"
      href="#/admin/publish-upstream-service"
      subtle
      @activate="openAdmin('upstreamServicePublish')"
    />
  </section>
</template>
