<script setup lang="ts">
import { useMaintenanceAgentViewContext } from "../../../composables/maintenanceAgentViewContext";

const {
  formatCompactDate,
  latestMaintenanceAgentRun,
  maintenanceAgentConfig,
  maintenanceAgentRiskLabel,
  maintenanceAgentRunbooks,
  maintenanceAgentStatusLabel,
  maintenanceAgentSummary,
  nextMaintenanceAgentRunAt,
  pendingMaintenanceApprovalCount,
} = useMaintenanceAgentViewContext();
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>智能巡检</h3>
      </div>
      <div class="section-tags">
        <span>{{ maintenanceAgentConfig?.enabled ? "已启用" : "未启用" }}</span>
        <span>待审批 {{ pendingMaintenanceApprovalCount }}</span>
        <span>下次 {{ formatCompactDate(nextMaintenanceAgentRunAt) }}</span>
      </div>
    </div>
    <div class="detail-metrics gateway-metrics">
      <div>
        <span>最近运行</span>
        <strong>{{ latestMaintenanceAgentRun ? maintenanceAgentStatusLabel(latestMaintenanceAgentRun.status) : "无" }}</strong>
      </div>
      <div>
        <span>风险</span>
        <strong>{{ latestMaintenanceAgentRun ? maintenanceAgentRiskLabel(latestMaintenanceAgentRun.risk) : "无" }}</strong>
      </div>
      <div>
        <span>Runbook</span>
        <strong>{{ maintenanceAgentRunbooks.length }}</strong>
      </div>
      <div>
        <span>工具</span>
        <strong>{{ maintenanceAgentSummary?.tools.length || 0 }}</strong>
      </div>
    </div>
  </article>
</template>
