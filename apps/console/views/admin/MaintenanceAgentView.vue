<script setup lang="ts">
import MaintenanceAgentActionGrid from "../../components/admin/maintenance-agent/MaintenanceAgentActionGrid.vue";
import MaintenanceAgentPolicyPanel from "../../components/admin/maintenance-agent/MaintenanceAgentPolicyPanel.vue";
import MaintenanceAgentRunDetail from "../../components/admin/maintenance-agent/MaintenanceAgentRunDetail.vue";
import MaintenanceAgentRunList from "../../components/admin/maintenance-agent/MaintenanceAgentRunList.vue";
import MaintenanceAgentSummaryCard from "../../components/admin/maintenance-agent/MaintenanceAgentSummaryCard.vue";
import { useMaintenanceAgentViewConsole } from "../../composables/console-maintenance-agent-view-controller";
import { provideMaintenanceAgentView } from "../../composables/maintenanceAgentViewContext";

const maintenanceAgentView = useMaintenanceAgentViewConsole();
provideMaintenanceAgentView(maintenanceAgentView);
</script>

<template>
  <section class="maintenance-agent-layout">
    <MaintenanceAgentSummaryCard />
    <MaintenanceAgentPolicyPanel />
    <MaintenanceAgentActionGrid />
    <MaintenanceAgentRunList />
    <MaintenanceAgentRunDetail />
  </section>
</template>
