<script setup lang="ts">
import { computed, resolveComponent } from "vue";
import { formatCompactDate } from "@meshrix/ui-console/console-format-utils";
import type { OperationPermissionAuditItem } from "../../../lib/operation-permission-client";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";
import { consoleMessages, currentConsoleLocale } from "../../../i18n/console";

withDefaults(
  defineProps<{
    items?: OperationPermissionAuditItem[];
  }>(),
  {
    items: () => [],
  },
);

const journeyMessages = computed(() => consoleMessages[currentConsoleLocale.value].journey);
// Resolved through the app registry instead of a module import: consumers that
// stub vue-router (tests) keep rendering without the links.
const RouterLink: any = resolveComponent("RouterLink");
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>最近调用</h3>
      </div>
      <span v-if="items.length" class="first-call-indicator" data-testid="first-call-indicator">
        {{ journeyMessages.firstCallRecorded }}
      </span>
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
    <ConsoleEmptyState v-if="items.length === 0" title="暂无工具调用记录">
      <template #action>
        <RouterLink to="/admin/api-key-distribution" class="first-call-cta" data-testid="first-call-cta">
          {{ journeyMessages.firstCallCta }}
        </RouterLink>
      </template>
    </ConsoleEmptyState>
  </article>
</template>

<style scoped>
/* REQ-018 first-call affordance — existing tokens only. */
.first-call-indicator {
  color: var(--success);
  border: 1px solid var(--success-border);
  background: var(--success-surface);
  border-radius: var(--radius-full);
  padding: 0.1rem 0.5rem;
  font-size: var(--text-xs);
}
.first-call-cta {
  color: var(--brand);
  font-weight: var(--font-semibold);
  text-decoration: underline;
}
</style>
