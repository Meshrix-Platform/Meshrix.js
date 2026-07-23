<script setup lang="ts">
import { computed } from "vue";
import { toolRiskLabel } from "../../../composables/console-tool-display-utils";
import type {
  OperationPermissionCatalog,
  OperationPermissionMetrics,
} from "../../../lib/operation-permission-client";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";

type MetricDimensionRow = {
  label: string;
  value: number;
};

const props = withDefaults(
  defineProps<{
    catalogState?: OperationPermissionCatalog | null;
    activeToolCount?: number;
    toolCount?: number;
    metricsState?: OperationPermissionMetrics | null;
    statusRows?: MetricDimensionRow[];
    riskRows?: MetricDimensionRow[];
  }>(),
  {
    catalogState: null,
    activeToolCount: 0,
    toolCount: 0,
    metricsState: null,
    statusRows: () => [],
    riskRows: () => [],
  },
);

function percentLabel(value: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) {
    return "0%";
  }
  return `${Math.round((Number(value || 0) / total) * 100)}%`;
}

const toolUsageRows = computed(() => {
  const total = Number(props.metricsState?.callsTotal || 0);
  return [
    ...props.statusRows.map((row) => ({
      dimension: "状态",
      label: row.label,
      value: Number(row.value || 0),
      rate: percentLabel(Number(row.value || 0), total),
    })),
    ...props.riskRows.map((row) => ({
      dimension: "风险",
      label: toolRiskLabel(row.label),
      value: Number(row.value || 0),
      rate: percentLabel(Number(row.value || 0), total),
    })),
  ];
});
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>工具统计</h3>
      </div>
      <div class="section-tags">
        <span>目录指纹 {{ catalogState?.fingerprint?.slice(0, 12) || "未加载" }}</span>
        <span>工具 {{ activeToolCount }}/{{ toolCount }}</span>
      </div>
    </div>

    <div class="detail-metrics gateway-metrics">
      <div>
        <span>调用总量</span>
        <strong>{{ metricsState?.callsTotal || 0 }}</strong>
      </div>
      <div>
        <span>拒绝</span>
        <strong>{{ metricsState?.byStatus?.denied || 0 }}</strong>
      </div>
      <div>
        <span>限流</span>
        <strong>{{ metricsState?.rateLimitedTotal || 0 }}</strong>
      </div>
      <div>
        <span>平均耗时</span>
        <strong>{{ Math.round(metricsState?.averageDurationMs || 0) }}ms</strong>
      </div>
    </div>

    <div class="job-table compact-job-table tool-stats-table">
      <div class="job-table-header">
        <span>维度</span>
        <span>项目</span>
        <span>数量</span>
        <span>使用率</span>
      </div>
      <div
        v-for="row in toolUsageRows"
        :key="`${row.dimension}:${row.label}`"
        class="job-row"
      >
        <span>{{ row.dimension }}</span>
        <span>{{ row.label }}</span>
        <span>{{ row.value }}</span>
        <span>{{ row.rate }}</span>
      </div>
    </div>

    <ConsoleEmptyState v-if="toolUsageRows.length === 0" title="暂无工具统计" />
  </article>
</template>
