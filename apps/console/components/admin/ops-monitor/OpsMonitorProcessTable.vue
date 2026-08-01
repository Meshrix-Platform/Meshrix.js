<script setup lang="ts">
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import StatusPill from "../../StatusPill.vue";
import { useOpsMonitorViewContext } from "../../../composables/opsMonitorViewContext";

const {
  backgroundProcessLabel,
  backgroundProcessStatus,
  backgroundProcessTone,
  backgroundProcesses,
  backgroundRunningCount,
  formatCompactDate,
  processRelationText,
  processRelationBullets,
  processTypeLabel,
} = useOpsMonitorViewContext();
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>进程状态</h3>
      </div>
      <div class="section-tags">
        <span>{{ backgroundProcessStatus?.status || "未读取" }}</span>
        <span>运行 {{ backgroundRunningCount }}</span>
      </div>
    </div>
    <div v-if="backgroundProcesses.length" class="job-table compact-job-table background-process-table ops-process-table">
      <div class="job-table-header">
        <span>进程</span>
        <span>类型</span>
        <span>状态</span>
        <span>PID</span>
        <span>最后响应时间</span>
        <span>作用和关联</span>
      </div>
      <div
        v-for="processItem in backgroundProcesses"
        :key="processItem.role"
        class="job-row"
      >
        <span class="ops-process-identity">
          <strong>{{ processItem.label }}</strong>
          <small>{{ processItem.role }}</small>
        </span>
        <StatusPill tone="info" :label="processTypeLabel(processItem.processType)" />
        <StatusPill :tone="backgroundProcessTone(processItem.status)" :label="backgroundProcessLabel(processItem.status)" />
        <span>
          <strong>{{ processItem.pid || "-" }}</strong>
        </span>
        <span>
          <strong>{{ formatCompactDate(processItem.lastHeartbeatAt || "") }}</strong>
        </span>
        <span class="ops-process-relations">
          <strong>{{ processItem.responsibility || processItem.description }}</strong>
          <ul v-if="processRelationBullets(processItem).length > 0">
            <li
              v-for="item in processRelationBullets(processItem)"
              :key="`${processItem.role}:${item.label}`"
            >
              <span>{{ item.label }}：</span>
              <span>{{ item.text }}</span>
            </li>
          </ul>
          <small v-else>{{ processRelationText(processItem) }}</small>
        </span>
      </div>
    </div>
    <ConsoleEmptyState v-if="backgroundProcesses.length === 0" title="暂无进程状态" />
  </article>
</template>
