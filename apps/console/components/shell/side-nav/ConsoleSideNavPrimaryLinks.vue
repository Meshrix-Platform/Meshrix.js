<script setup lang="ts">
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavPrimaryLinks" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  canAccessView,
  msg,
  openAdmin,
  openSideNavDirectory,
  showSideNavDirectory,
  switchView,
} = useConsoleSideNavContext();
</script>

<template>
  <ConsoleSideNavLink
    v-if="canAccessView('dashboard')"
    :active="activeRouteView === 'dashboard'"
    :label="msg.nav.dashboard"
    href="#/"
    @activate="switchView('dashboard')"
  >
    <template #icon>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="side-link-icon"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
    </template>
  </ConsoleSideNavLink>
  <ConsoleSideNavLink
    v-if="canAccessView('approval')"
    :active="activeRouteView === 'approval'"
    :label="msg.nav.approvalFlow"
    href="#/approval"
    @activate="openSideNavDirectory('approval'); switchView('approval')"
  >
    <template #icon>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="side-link-icon"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    </template>
    <template v-if="activeRouteView === 'approval' && !showSideNavDirectory" #trail>
      <span class="side-link-directory-reveal" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </span>
    </template>
  </ConsoleSideNavLink>
  <ConsoleSideNavLink
    v-if="canAccessAdminView('operationPermission')"
    :active="activeRouteView === 'admin' && activeRouteAdminView === 'operationPermission'"
    :label="msg.nav.operationPermission"
    href="#/admin/operation-permission"
    @activate="openAdmin('operationPermission')"
  >
    <template #icon>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="side-link-icon"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>
    </template>
  </ConsoleSideNavLink>
  <ConsoleSideNavLink
    v-if="canAccessView('workspaces')"
    :active="activeRouteView === 'workspaces'"
    :label="msg.nav.workspaces"
    href="#/workspaces"
    @activate="openSideNavDirectory('workspaces'); switchView('workspaces')"
  >
    <template #icon>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="side-link-icon"><rect x="9" y="2" width="6" height="6" rx="1.5"/><rect x="3" y="16" width="6" height="6" rx="1.5"/><rect x="15" y="16" width="6" height="6" rx="1.5"/><path d="M12 8v4"/><path d="M6 16v-4h12v4"/></svg>
    </template>
    <template v-if="activeRouteView === 'workspaces' && !showSideNavDirectory" #trail>
      <span class="side-link-directory-reveal" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
      </span>
    </template>
  </ConsoleSideNavLink>
</template>
