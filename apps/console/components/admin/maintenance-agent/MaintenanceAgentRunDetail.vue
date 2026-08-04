<script setup lang="ts">
import { jsonPreview } from "@meshrix/ui-console/console-format-utils";
import { useMaintenanceAgentViewContext } from "../../../composables/maintenanceAgentViewContext";

const {
  maintenanceAgentResultJson,
  maintenanceAgentRiskLabel,
  maintenanceAgentStatusLabel,
  selectedMaintenanceAgentRun,
} = useMaintenanceAgentViewContext();
</script>

<template>
  <article v-if="selectedMaintenanceAgentRun" class="surface-card">
    <div class="section-header">
      <div>
        <h3>{{ selectedMaintenanceAgentRun.summary }}</h3>
      </div>
      <div class="section-tags">
        <span>{{ selectedMaintenanceAgentRun.planHash.slice(0, 12) }}</span>
        <span>{{ selectedMaintenanceAgentRun.source }}</span>
      </div>
    </div>
    <div class="maintenance-agent-step-list">
      <section
        v-for="step in selectedMaintenanceAgentRun.steps"
        :key="step.stepId"
        class="module-panel"
      >
        <div class="module-panel-heading">
          <strong>{{ step.toolId }}</strong>
          <span>{{ maintenanceAgentStatusLabel(step.status) }} / {{ maintenanceAgentRiskLabel(step.risk) }}</span>
        </div>
        <p class="module-note">{{ step.reason }}</p>
        <pre v-if="step.output">{{ jsonPreview(step.output) }}</pre>
        <p v-if="step.error" class="module-note danger-text">{{ step.error }}</p>
      </section>
    </div>
    <section v-if="maintenanceAgentResultJson" class="markdown-preview">
      <h4>最近输出</h4>
      <pre>{{ maintenanceAgentResultJson }}</pre>
    </section>
  </article>
</template>
