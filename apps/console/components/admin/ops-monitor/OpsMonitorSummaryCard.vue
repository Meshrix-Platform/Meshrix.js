<script setup lang="ts">
import { useOpsMonitorViewContext } from "../../../composables/opsMonitorViewContext";

const {
  backgroundProcesses,
  backgroundRunningCount,
  backgroundSupervisorLabel,
  monitorAlertSummary,
} = useOpsMonitorViewContext();
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>运维监控</h3>
      </div>
      <div class="section-tags">
        <span>{{ backgroundSupervisorLabel }}</span>
        <span>进程 {{ backgroundRunningCount }} / {{ backgroundProcesses.length }}</span>
        <span>报警 {{ monitorAlertSummary.activeCount }}</span>
      </div>
    </div>
  </article>
</template>
