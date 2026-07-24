<script setup lang="ts">
import { useAuthorizationGovernanceCardContext } from "../../../composables/authorizationGovernanceCardContext";

const {
  authorizationGovernanceMetrics,
} = useAuthorizationGovernanceCardContext();
</script>

<template>
  <div class="detail-metrics gateway-metrics">
    <div v-for="metric in authorizationGovernanceMetrics" :key="metric.label">
      <span>{{ metric.label }}</span>
      <strong>{{ metric.value }}</strong>
    </div>
  </div>
</template>
