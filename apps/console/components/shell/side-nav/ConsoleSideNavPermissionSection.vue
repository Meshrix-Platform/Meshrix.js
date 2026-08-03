<script setup lang="ts">
import { computed, watch } from "vue";
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";
import { setApiKeyDistributionAvailability, useApiKeyDistributionAvailability } from "../../../composables/console-api-key-distribution-availability";
import ConsoleSideNavLink from "./ConsoleSideNavLink.vue";

defineOptions({ name: "ConsoleSideNavPermissionSection" });

const {
  activeRouteAdminView,
  activeRouteView,
  canAccessAdminView,
  hasFeature,
  msg,
  openAdmin,
} = useConsoleSideNavContext();

const { eligible: apiKeyDistributionEligible, load: loadApiKeyDistributionAvailability } = useApiKeyDistributionAvailability();
const canRequestApiKeyDistribution = computed(() =>
  hasFeature("operation-permission-core") &&
  hasFeature("security-permissions") &&
  canAccessAdminView("apiKeyDistribution")
);

const showPermissionSection = computed(() =>
  canAccessAdminView("tagManagement") ||
  canAccessAdminView("organizationGovernance") ||
  (apiKeyDistributionEligible.value && canAccessAdminView("apiKeyDistribution"))
);

watch(canRequestApiKeyDistribution, (allowed) => {
  if (allowed) void loadApiKeyDistributionAvailability();
  else setApiKeyDistributionAvailability(false);
}, { immediate: true });
</script>

<template>
  <section v-if="showPermissionSection" class="side-nav-section" :aria-label="msg.nav.permission">
    <p class="side-nav-section-title">{{ msg.nav.permission }}</p>
    <ConsoleSideNavLink
      v-if="hasFeature('tag-management') && canAccessAdminView('tagManagement')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'tagManagement'"
      :label="msg.nav.tagManagement"
      href="#/admin/tag-management"
      subtle
      @activate="openAdmin('tagManagement')"
    />
    <ConsoleSideNavLink
      v-if="hasFeature('security-permissions') && canAccessAdminView('organizationGovernance')"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'organizationGovernance'"
      :label="msg.nav.organizationGovernance"
      href="#/admin/organization-governance"
      subtle
      @activate="openAdmin('organizationGovernance')"
    />
    <ConsoleSideNavLink
      v-if="apiKeyDistributionEligible && canRequestApiKeyDistribution"
      :active="activeRouteView === 'admin' && activeRouteAdminView === 'apiKeyDistribution'"
      :label="msg.nav.apiKeyDistribution"
      href="#/admin/api-key-distribution"
      subtle
      @activate="openAdmin('apiKeyDistribution')"
    />
  </section>
</template>
