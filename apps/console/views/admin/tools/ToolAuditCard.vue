<script setup lang="ts">
import { formatCompactDate } from "@meshrix/ui-console/console-format-utils";
import type { OperationPermissionAuditItem } from "../../../lib/operation-permission-client";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";

withDefaults(
  defineProps<{
    items?: OperationPermissionAuditItem[];
  }>(),
  {
    items: () => [],
  },
);
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>最近调用</h3>
      </div>
    </div>
    <div v-if="items.length" class="job-table compact-job-table tool-audit-table">
      <div class="job-table-header">
        <span>执行</span>
        <span>工具</span>
        <span>状态</span>
        <span>耗时</span>
        <span>时间</span>
      </div>
      <div
        v-for="item in items"
        :key="item.toolExecutionId"
        class="job-row"
      >
        <span>
          <strong>{{ item.toolExecutionId }}</strong>
          <small>{{ item.traceId || "无 trace" }}</small>
        </span>
        <span>{{ item.toolId }}</span>
        <span>{{ item.status }}{{ item.errorCode ? ` / ${item.errorCode}` : "" }}</span>
        <span>{{ item.durationMs }}ms</span>
        <span>{{ formatCompactDate(item.finishedAt || item.startedAt) }}</span>
      </div>
    </div>
    <ConsoleEmptyState v-if="items.length === 0" title="暂无工具调用记录" />
  </article>
</template>
