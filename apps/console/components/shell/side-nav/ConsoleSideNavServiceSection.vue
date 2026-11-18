<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import { isAdminPluginConsoleEntry } from "../../../router/plugin-console-routes";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavServiceSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  consoleState,
  msg,
  openAdmin,
} = useConsoleSideNavContext();

const pluginEntries = computed(() =>
  (consoleState.value?.features?.plugins?.consoleEntries || [])
    .filter((entry: any) => isAdminPluginConsoleEntry(entry) && canAccessAdminView(entry.viewKey))
    .sort((left: any, right: any) => (left.label || left.id).localeCompare(right.label || right.id)),
);
const showServiceSection = computed(() =>
  canAccessAdminView("upstreamServices") ||
  canAccessAdminView("upstreamServicePublish") ||
  pluginEntries.value.length > 0
);

function pluginEntryHref(entry: { routePath?: string }) {
  return entry.routePath ? `#${entry.routePath}` : "";
}
</script>

<template>
  <section v-if="showServiceSection" class="side-nav-section" :aria-label="msg.nav.service">
    <p class="side-nav-section-title">{{ msg.nav.service }}</p>
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
    <ConsoleSideNavLink
      v-for="entry in pluginEntries"
      :key="entry.id"
      :active="activeRouteView === 'admin' && activeRouteAdminView === entry.viewKey"
      :label="entry.label || entry.id"
      :href="pluginEntryHref(entry)"
      subtle
      @activate="openAdmin(entry.viewKey)"
    />
  </section>
</template>
