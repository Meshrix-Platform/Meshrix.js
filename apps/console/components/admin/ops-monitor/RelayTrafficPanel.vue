<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import { useOpsMonitorViewContext } from "../../../composables/opsMonitorViewContext";

const {
  formatCompactDate = (value: unknown) => String(value || ""),
  refreshRelayTraffic = async () => undefined,
  relayTrafficState = ref(null),
} = useOpsMonitorViewContext();

const METRIC_NAME_PREFIX = "meshrix_relay_";

type RelayStatCardSpec = {
  name: string;
  label: string;
  format?: "count" | "bytes";
};

const keyMetricCards: RelayStatCardSpec[] = [
  { name: "meshrix_relay_sessions_admitted", label: "会话准入" },
  { name: "meshrix_relay_sessions_rejected", label: "会话拒绝" },
  { name: "meshrix_relay_sessions_revoked", label: "会话吊销" },
  { name: "meshrix_relay_mailbox_accepted", label: "邮箱接收" },
  { name: "meshrix_relay_mailbox_acked", label: "邮箱确认" },
  { name: "meshrix_relay_mailbox_expired", label: "邮箱过期" },
  { name: "meshrix_relay_frames_forwarded", label: "帧转发" },
  { name: "meshrix_relay_frames_dropped", label: "帧丢弃" },
  { name: "meshrix_relay_rate_limit_drops", label: "限流丢弃" },
  { name: "meshrix_relay_bytes_in", label: "入站字节", format: "bytes" },
  { name: "meshrix_relay_bytes_out", label: "出站字节", format: "bytes" },
];

const relayMetrics = computed(() => relayTrafficState?.value?.metrics || []);
const relayHistory = computed(() => relayTrafficState?.value?.history || []);
const relayConfigured = computed(() => relayTrafficState?.value?.configured === true);
const relayError = computed(() => String(relayTrafficState?.value?.error || ""));
const relayHttpStatus = computed(() => Number(relayTrafficState?.value?.status || 0));

const relayTrafficStatusLabel = computed(() => {
  if (!relayTrafficState?.value) {
    return "未读取";
  }
  if (!relayConfigured.value) {
    return "未配置";
  }
  return relayError.value ? "不可达" : "正常";
});

const liveMetricSums = computed(() => {
  const sums: Record<string, number> = {};
  for (const metric of relayMetrics.value) {
    sums[metric.name] = (metric.samples || []).reduce(
      (total: number, sample: any) => total + Number(sample?.value || 0),
      0,
    );
  }
  return sums;
});

const lastKnownSums = computed(() => {
  const latest = relayHistory.value[relayHistory.value.length - 1];
  return latest?.sums || {};
});

const displaySums = computed(() =>
  relayMetrics.value.length > 0 ? liveMetricSums.value : lastKnownSums.value,
);

const hasStatData = computed(() =>
  keyMetricCards.some((item) => Number(displaySums.value[item.name] || 0) !== 0)
  || relayMetrics.value.length > 0,
);

const counterRows = computed(() => {
  const rows: any[] = [];
  for (const metric of relayMetrics.value) {
    const shortName = String(metric.name || "").startsWith(METRIC_NAME_PREFIX)
      ? String(metric.name).slice(METRIC_NAME_PREFIX.length)
      : String(metric.name || "");
    for (const sample of metric.samples || []) {
      const labels = sample?.labels || {};
      rows.push({
        key: `${metric.name}|${labels.object || ""}|${labels.tenant || ""}|${labels.route || ""}|${labels.device || ""}|${labels.scope || ""}`,
        shortName,
        object: String(labels.object || ""),
        route: String(labels.route || ""),
        device: String(labels.device || ""),
        scope: String(labels.scope || ""),
        tenant: String(labels.tenant || ""),
        value: Number(sample?.value || 0),
      });
    }
  }
  return rows;
});

const statCards = computed(() =>
  keyMetricCards.map((item) => ({
    ...item,
    value: Number(displaySums.value[item.name] || 0),
    spark: sparklinePoints(item.name),
  })),
);

const showUnconfigured = computed(() =>
  Boolean(relayTrafficState?.value) && !relayConfigured.value,
);

const showEmpty = computed(() =>
  relayConfigured.value && !relayError.value && counterRows.value.length === 0 && !hasStatData.value,
);

function formatCounter(value: number): string {
  return Number(value || 0).toLocaleString();
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : 1);
  return `${text} ${units[unit]}`;
}

function formatStatValue(card: RelayStatCardSpec, value: number): string {
  return card.format === "bytes" ? formatBytes(value) : formatCounter(value);
}

/** Inline-SVG sparkline: polyline points for `viewBox="0 0 100 28"`. */
function sparklinePoints(metricName: string): string {
  const values = relayHistory.value.map((point: any) =>
    Number(point?.sums?.[metricName] ?? 0),
  );
  if (values.length < 2) {
    return "";
  }
  const max = Math.max(...values);
  const span = values.length - 1;
  return values
    .map((value: any, index: any) => {
      const x = (index / span) * 100;
      const y = max > 0 ? 26 - (value / max) * 24 : 26;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

onMounted(() => {
  if (!relayTrafficState?.value) {
    void refreshRelayTraffic({ silent: true });
  }
});
</script>

<template>
  <article class="surface-card relay-traffic-panel">
    <div class="section-header">
      <div>
        <h3>Relay 流量</h3>
      </div>
      <div class="section-tags">
        <span>{{ relayTrafficStatusLabel }}</span>
        <span v-if="relayConfigured && relayMetrics.length">指标 {{ relayMetrics.length }}</span>
        <span v-if="relayHistory.length">采样 {{ relayHistory.length }}</span>
        <span v-if="relayTrafficState?.fetchedAt">{{ formatCompactDate(relayTrafficState.fetchedAt) }}</span>
      </div>
    </div>
    <p v-if="relayConfigured && relayError" class="relay-traffic-hint relay-traffic-hint-error">
      Relay 指标接口暂不可达：{{ relayError }}<template v-if="relayHttpStatus">（HTTP {{ relayHttpStatus }}）</template>
    </p>
    <div v-if="relayConfigured && hasStatData" class="relay-traffic-stat-grid">
      <div
        v-for="card in statCards"
        :key="card.name"
        class="relay-traffic-stat"
      >
        <small>{{ card.label }}</small>
        <strong>{{ formatStatValue(card, card.value) }}</strong>
        <svg
          v-if="card.spark"
          class="relay-traffic-spark"
          viewBox="0 0 100 28"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline :points="card.spark" fill="none" />
        </svg>
      </div>
    </div>
    <div v-if="counterRows.length" class="job-table compact-job-table relay-traffic-table">
      <div class="job-table-header">
        <span>指标</span>
        <span>对象</span>
        <span>路由</span>
        <span>设备</span>
        <span>层级</span>
        <span>租户</span>
        <span>计数</span>
      </div>
      <div
        v-for="row in counterRows"
        :key="row.key"
        class="job-row"
      >
        <span class="relay-traffic-metric">{{ row.shortName }}</span>
        <span>{{ row.object || "-" }}</span>
        <span class="relay-traffic-label-value">{{ row.route || "-" }}</span>
        <span class="relay-traffic-label-value">{{ row.device || "-" }}</span>
        <span>{{ row.scope || "-" }}</span>
        <span class="relay-traffic-label-value">{{ row.tenant || "-" }}</span>
        <span>
          <strong>{{ formatCounter(row.value) }}</strong>
        </span>
      </div>
    </div>
    <ConsoleEmptyState
      v-if="showUnconfigured"
      title="Relay 流量未接入"
      description="未配置 MESHRIX_RELAY_METRICS_URL；在服务端设置私有 Relay /admin/metrics 地址后展示。"
    />
    <ConsoleEmptyState
      v-else-if="relayConfigured && relayError && counterRows.length === 0 && !hasStatData"
      title="Relay 指标暂不可达"
      :description="`${relayError}${relayHttpStatus ? `（HTTP ${relayHttpStatus}）` : ''}`"
      tone="danger"
    />
    <ConsoleEmptyState
      v-else-if="showEmpty"
      title="暂无 Relay 流量数据"
    />
  </article>
</template>

<style scoped>
.relay-traffic-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.relay-traffic-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.relay-traffic-hint-error {
  color: var(--danger);
}

.relay-traffic-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-3);
}

.relay-traffic-stat {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.relay-traffic-stat small {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.relay-traffic-stat strong {
  color: var(--text-primary);
  font-size: var(--text-lg);
  font-variant-numeric: tabular-nums;
}

.relay-traffic-spark {
  width: 100%;
  height: 28px;
}

.relay-traffic-spark polyline {
  stroke: var(--accent, currentColor);
  stroke-width: 1.5;
}

.relay-traffic-metric,
.relay-traffic-label-value {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
