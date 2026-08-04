<script setup lang="ts">
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import StatusPill from "@meshrix/ui-console/status-pill";
import { useMaintenanceAgentViewContext } from "../../../composables/maintenanceAgentViewContext";

import { currentConsoleLocale, localizeConsoleText } from "../../../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const {
  approveMaintenanceAgentRun,
  isBusy,
  canApproveMaintenanceAgent,
  canRunMaintenanceAgent,
  cancelMaintenanceAgentRun,
  displayedMaintenanceAgentRuns,
  formatCompactDate,
  maintenanceAgentRiskLabel,
  maintenanceAgentStatusLabel,
  maintenanceAgentStatusTone,
  selectedMaintenanceAgentRun,
} = useMaintenanceAgentViewContext();
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>运行记录</h3>
      </div>
    </div>
    <div class="job-table compact-job-table maintenance-run-table">
      <div class="job-table-header">
        <span>运行</span>
        <span>状态</span>
        <span>操作</span>
      </div>
      <div
        v-for="run in displayedMaintenanceAgentRuns"
        :key="run.runId"
        class="job-row"
      >
        <button
          class="table-action text-action"
          type="button"
          @click="selectedMaintenanceAgentRun = run"
        >
          {{ run.intent }} / {{ formatCompactDate(run.updatedAt) }}
        </button>
        <StatusPill
          :tone="maintenanceAgentStatusTone(run.status)"
          :label="localizeStatusPillLabel(`${maintenanceAgentStatusLabel(run.status)} / ${maintenanceAgentRiskLabel(run.risk)}`)"
        />
        <span class="table-actions-inline">
          <button
            v-if="run.status === 'awaiting_approval'"
            class="table-action"
            type="button"
            :disabled="!canApproveMaintenanceAgent || isBusy(`maintenance-agent:approve:${run.runId}`)"
            :aria-busy="isBusy(`maintenance-agent:approve:${run.runId}`)"
            @click="approveMaintenanceAgentRun(run)"
          >
            批准
          </button>
          <button
            v-if="!['completed', 'completed_with_errors', 'failed', 'cancelled', 'rejected'].includes(run.status)"
            class="table-action danger-action"
            type="button"
            :disabled="!canRunMaintenanceAgent || isBusy(`maintenance-agent:cancel:${run.runId}`)"
            :aria-busy="isBusy(`maintenance-agent:cancel:${run.runId}`)"
            @click="cancelMaintenanceAgentRun(run)"
          >
            取消
          </button>
        </span>
      </div>
    </div>
    <ConsoleEmptyState v-if="displayedMaintenanceAgentRuns.length === 0" title="暂无维护运行" />
  </article>
</template>
