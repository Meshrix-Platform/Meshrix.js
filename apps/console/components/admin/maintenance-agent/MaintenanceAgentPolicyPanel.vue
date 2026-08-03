<script setup lang="ts">
import OptionBar from "@meshrix/ui-console/option-bar";
import FeatureToggle from "../../FeatureToggle.vue";
import { useMaintenanceAgentViewContext } from "../../../composables/maintenanceAgentViewContext";

const {
  addMaintenanceAgentSchedule,
  autoApproveRiskOptionBarOptions,
  isBusy,
  canAdminMaintenanceAgent,
  formatCompactDate,
  maintenanceAgentConfig,
  maintenanceAgentRunbook,
  maintenanceAgentRunbookOptionBarOptions,
  plannerModeOptionBarOptions,
  removeMaintenanceAgentSchedule,
  saveMaintenanceAgentConfig,
} = useMaintenanceAgentViewContext();
</script>

<template>
  <article v-if="maintenanceAgentConfig" class="surface-card">
    <div class="section-header">
      <div>
        <h3>调度策略</h3>
      </div>
    </div>
    <div class="source-actions maintenance-agent-policy-actions">
      <OptionBar
        v-model="maintenanceAgentRunbook"
        label="新增计划 Runbook"
        :options="maintenanceAgentRunbookOptionBarOptions"
      />
      <button
        class="tool-button tool-button-ghost"
        type="button"
        :disabled="!maintenanceAgentRunbook"
        @click="addMaintenanceAgentSchedule"
      >
        添加计划
      </button>
    </div>
    <div class="form-grid compact-form-grid">
      <FeatureToggle
        v-model="maintenanceAgentConfig.enabled"
        label="启用"
        :aria-label="maintenanceAgentConfig.enabled ? '停用维护智能体' : '启用维护智能体'"
      />
      <OptionBar
        v-model="maintenanceAgentConfig.plannerMode"
        label="Planner"
        :options="plannerModeOptionBarOptions"
      />
      <OptionBar
        v-model="maintenanceAgentConfig.autoApproveRisk"
        label="自动批准"
        :options="autoApproveRiskOptionBarOptions"
      />
      <label>
        <span>Tick 秒</span>
        <input v-model.number="maintenanceAgentConfig.scheduler.tickSeconds" type="number" min="1" max="3600" />
      </label>
    </div>
    <div class="job-table compact-job-table maintenance-schedule-table">
      <div v-if="maintenanceAgentConfig.schedules.length" class="job-table-header">
        <span>计划</span>
        <span>间隔</span>
        <span>状态</span>
      </div>
      <div
        v-for="schedule in maintenanceAgentConfig.schedules"
        :key="schedule.id"
        class="job-row"
      >
        <span>
          <strong>{{ schedule.label }}</strong>
          <small>{{ schedule.runbook }} / {{ formatCompactDate(schedule.nextRunAt) }}</small>
        </span>
        <input v-model.number="schedule.intervalMinutes" type="number" min="1" max="525600" />
        <span class="source-actions">
          <FeatureToggle
            v-model="schedule.enabled"
            :aria-label="schedule.enabled ? `停用计划 ${schedule.label}` : `启用计划 ${schedule.label}`"
          />
          <button
            class="table-action danger-link"
            type="button"
            @click="removeMaintenanceAgentSchedule(schedule.id)"
          >
            移除
          </button>
        </span>
      </div>
      <p v-if="!maintenanceAgentConfig.schedules.length" class="maintenance-schedule-empty">
        暂无计划。在上方选择 Runbook 后点击“添加计划”。
      </p>
    </div>
    <div class="source-actions maintenance-agent-policy-actions">
      <button
        class="primary-action"
        type="button"
        :disabled="!canAdminMaintenanceAgent || isBusy('maintenance-agent:config')"
        :aria-busy="isBusy('maintenance-agent:config')"
        @click="saveMaintenanceAgentConfig"
      >
        {{ isBusy("maintenance-agent:config") ? "保存中" : "保存策略" }}
      </button>
    </div>
  </article>
</template>

<style scoped>
.maintenance-schedule-empty {
  margin: 0;
  padding: var(--space-4);
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}
</style>
