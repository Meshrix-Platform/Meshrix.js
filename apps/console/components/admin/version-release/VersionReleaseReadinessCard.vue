<script setup lang="ts">
import { computed } from "vue";
import ConsoleDescriptionList from "../../ConsoleDescriptionList.vue";
import StatusPill from "@meshrix/ui-console/status-pill";
import {
  formatDateTime,
  statusLabel,
  statusTone,
} from "../../../lib/production-health";
import type { ProductionHealthResponse } from "../../../lib/version-release";

import { currentConsoleLocale, localizeConsoleText } from "../../../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const props = defineProps<{
  health: ProductionHealthResponse | null;
  healthError: string;
}>();

const latestReport = computed(() => props.health?.latestReport || null);
const latestStatus = computed(() => latestReport.value?.overallStatus || props.health?.status || "missing");
const dirtyFileCount = computed(() => latestReport.value?.git?.dirtyFileCount ?? 0);
const productionClaimAllowed = computed(() => Boolean(latestReport.value?.productionClaimAllowed));
const releaseClaim = computed(() =>
  latestReport.value?.releaseClaim || (productionClaimAllowed.value ? "production-ready" : "blocked-by-production-readiness-gate"),
);
const claimTone = computed(() => {
  if (!latestReport.value) return "warning";
  if (latestReport.value.readError) return "danger";
  return productionClaimAllowed.value ? "success" : "danger";
});
const claimLabel = computed(() => {
  if (!latestReport.value) return "无报告";
  return productionClaimAllowed.value ? "允许生产声明" : "禁止生产声明";
});
const reportGeneratedAt = computed(() =>
  formatDateTime(latestReport.value?.generatedAt || props.health?.generatedAt || ""),
);
const commitShort = computed(() => {
  const commit = latestReport.value?.git?.commit || "";
  return commit ? commit.slice(0, 12) : "unknown";
});
const readinessMetaItems = computed(() => [
  { label: "Release claim", value: releaseClaim.value, mono: true },
  { label: "报告", value: `${latestReport.value?.runId || "missing"} · ${reportGeneratedAt.value}` },
  { label: "分支", value: latestReport.value?.git?.branch || "unknown", mono: true },
  { label: "提交", value: commitShort.value, mono: true },
  { label: "报告路径", value: latestReport.value?.reportPath || props.health?.reportRoot || "build/reports/production-readiness", mono: true },
  { label: "模式", value: latestReport.value?.mode || "unknown", mono: true },
]);
</script>

<template>
  <article class="surface-card version-release-readiness-card">
    <div class="section-header">
      <div>
        <h3>发布声明门禁</h3>
        <p>绑定最新生产准入报告、工作区清洁度和可声明的发布口径。</p>
      </div>
      <StatusPill :tone="claimTone" :label="localizeStatusPillLabel(claimLabel)" />
    </div>

    <div v-if="healthError" class="status-strip danger">
      <strong>读取失败</strong>
      <span>{{ healthError }}</span>
    </div>
    <div v-else-if="latestReport?.readError" class="status-strip danger">
      <strong>报告损坏</strong>
      <span>{{ latestReport.readError }}</span>
    </div>
    <div v-else-if="!latestReport" class="status-strip warning">
      <strong>缺少报告</strong>
      <span>production claim 维持阻断状态。</span>
    </div>
    <div v-else-if="!productionClaimAllowed" class="status-strip danger">
      <strong>声明阻断</strong>
      <span>{{ dirtyFileCount > 0 ? "当前报告来自脏工作区。" : "生产准入未允许正式发布声明。" }}</span>
    </div>
    <div v-else class="status-strip success">
      <strong>声明允许</strong>
      <span>最新生产准入报告允许 production claim。</span>
    </div>

    <div class="detail-metrics version-release-readiness-metrics">
      <div :data-tone="statusTone(latestStatus)">
        <span>报告状态</span>
        <strong>{{ statusLabel(latestStatus) }}</strong>
      </div>
      <div :data-tone="(health?.summary.blockedP0 ?? 0) > 0 ? 'danger' : undefined">
        <span>P0 阻塞</span>
        <strong>{{ health?.summary.blockedP0 ?? 0 }}</strong>
      </div>
      <div :data-tone="dirtyFileCount > 0 ? 'warning' : undefined">
        <span>脏文件</span>
        <strong>{{ dirtyFileCount }}</strong>
      </div>
      <div :data-tone="productionClaimAllowed ? 'success' : 'danger'">
        <span>声明</span>
        <strong>{{ productionClaimAllowed ? "允许" : "阻断" }}</strong>
      </div>
    </div>

    <ConsoleDescriptionList :items="readinessMetaItems" />
  </article>
</template>

<style scoped>
.version-release-readiness-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.version-release-readiness-card > .section-header {
  margin-bottom: 0;
}

.version-release-readiness-card .status-strip.success {
  border-color: var(--success);
  background: var(--success-surface);
  color: var(--success);
}

.version-release-readiness-card .status-strip.success strong {
  color: var(--success);
}

.version-release-readiness-metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

@media (max-width: 1120px) {
  .version-release-readiness-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .version-release-readiness-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
