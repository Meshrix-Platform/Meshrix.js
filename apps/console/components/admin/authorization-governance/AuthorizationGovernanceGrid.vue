<script setup lang="ts">
import { computed } from "vue";
import { useAuthorizationGovernanceCardContext } from "../../../composables/authorizationGovernanceCardContext";
import AuthorizationGovernancePanel from "./AuthorizationGovernancePanel.vue";
import {
  createAuthorizationGovernancePanels,
  type AuthorizationGovernanceSummary,
} from "./authorization-governance-panel-rows";

const {
  authorizationGovernance,
  itemText,
  policyCount,
  shortList,
} = useAuthorizationGovernanceCardContext();

const panels = computed(() =>
  createAuthorizationGovernancePanels(
    authorizationGovernance.value as AuthorizationGovernanceSummary,
    { itemText, policyCount, shortList },
  ),
);
</script>

<template>
  <div class="authorization-governance-grid">
    <AuthorizationGovernancePanel
      v-for="panel in panels"
      :key="panel.title"
      :panel="panel"
    />
  </div>
</template>
