<script setup lang="ts">
import OpsMonitorAlertsPanel from "../../components/admin/ops-monitor/OpsMonitorAlertsPanel.vue";
import OpsMonitorProcessTable from "../../components/admin/ops-monitor/OpsMonitorProcessTable.vue";
import OpsMonitorSummaryCard from "../../components/admin/ops-monitor/OpsMonitorSummaryCard.vue";
import { useOpsMonitorViewConsole } from "../../composables/console-ops-monitor-view-controller";
import { provideOpsMonitorView } from "../../composables/opsMonitorViewContext";

const opsMonitorView = useOpsMonitorViewConsole();
provideOpsMonitorView(opsMonitorView);
</script>

<template>
  <section class="maintenance-agent-layout ops-monitor-layout">
    <OpsMonitorSummaryCard />
    <OpsMonitorProcessTable />
    <OpsMonitorAlertsPanel />
  </section>
</template>
