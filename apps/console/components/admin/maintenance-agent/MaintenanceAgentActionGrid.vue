<script setup lang="ts">
import OptionBar from "@meshrix/ui-console/option-bar";
import { useMaintenanceAgentViewContext } from "../../../composables/maintenanceAgentViewContext";

const {
  isBusy,
  canRunMaintenanceAgent,
  maintenanceAgentRunbook,
  maintenanceAgentRunbookOptionBarOptions,
  maintenanceAgentRunbooks,
  runMaintenanceAgentGatewayReview,
  runMaintenanceAgentRunbook,
} = useMaintenanceAgentViewContext();
</script>

<template>
  <article class="surface-card maintenance-agent-grid">
    <section class="module-panel">
      <div class="module-panel-heading">
        <strong>Runbook</strong>
        <span>{{ maintenanceAgentRunbooks.length }}</span>
      </div>
      <OptionBar
        v-model="maintenanceAgentRunbook"
        class="module-field"
        label="选择"
        :options="maintenanceAgentRunbookOptionBarOptions"
      />
      <button
        class="tool-button"
        type="button"
        :disabled="!canRunMaintenanceAgent || !maintenanceAgentRunbook || isBusy('maintenance-agent:run')"
        :aria-busy="isBusy('maintenance-agent:run')"
        @click="runMaintenanceAgentRunbook"
      >
        {{ isBusy("maintenance-agent:run") ? "执行中" : "运行" }}
      </button>
      <div class="maintenance-agent-quick-actions">
        <button
          class="tool-button tool-button-ghost"
          type="button"
          :disabled="!canRunMaintenanceAgent || isBusy('maintenance-agent:run')"
          :aria-busy="isBusy('maintenance-agent:run')"
          @click="runMaintenanceAgentGatewayReview"
        >
          网关治理巡检
        </button>
        <small class="field-hint">
          网关治理任务已收敛到智能巡检，运行后进入记录、审批和审计链路。
        </small>
      </div>
    </section>
  </article>
</template>
