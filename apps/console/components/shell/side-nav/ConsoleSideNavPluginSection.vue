<script setup lang="ts">
import { computed } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import { isAdminPluginConsoleEntry } from "../../../router/plugin-console-routes";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavPluginSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  consoleState,
  openAdmin,
} = useConsoleSideNavContext();

const entries = computed(() =>
  (consoleState.value?.features?.plugins?.consoleEntries || [])
    .filter((entry: any) => isAdminPluginConsoleEntry(entry) && canAccessAdminView(entry.viewKey))
    .sort((left: any, right: any) => (left.label || left.id).localeCompare(right.label || right.id)),
);

function pluginEntryHref(entry: { routePath?: string }) {
  return entry.routePath ? `#${entry.routePath}` : "";
}
</script>

<template>
  <section v-if="entries.length" class="side-nav-section" aria-label="Plugins">
    <p class="side-nav-section-title">Plugins</p>
    <ConsoleSideNavLink
      v-for="entry in entries"
      :key="entry.id"
      :active="activeRouteView === 'admin' && activeRouteAdminView === entry.viewKey"
      :label="entry.label || entry.id"
      :href="pluginEntryHref(entry)"
      subtle
      @activate="openAdmin(entry.viewKey)"
    />
  </section>
</template>
