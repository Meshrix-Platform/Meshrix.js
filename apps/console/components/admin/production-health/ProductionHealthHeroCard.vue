<script setup lang="ts">
import { computed } from "vue";
import ConsoleDescriptionList from "../../ConsoleDescriptionList.vue";
import type { ProductionHealthResponse } from "../../../lib/production-health";
import { formatDateTime } from "../../../lib/production-health";

const props = defineProps<{
  health: ProductionHealthResponse | null;
  loadError: string;
}>();

const reportGeneratedAt = computed(() =>
  formatDateTime(props.health?.latestReport?.generatedAt || props.health?.generatedAt || ""),
);
const latestCommit = computed(() => {
  const commit = props.health?.latestReport?.git?.commit || "";
  return commit ? commit.slice(0, 12) : "unknown";
});
const capabilityKernel = computed(() => props.health?.capabilityKernel || null);
const capabilityBindingGuard = computed(() => props.health?.capabilityBindingGuard || null);
const healthMetaItems = computed(() => [
  { label: "报告目录", value: props.health?.reportRoot || "build/reports/production-readiness", mono: true },
  { label: "分支", value: props.health?.latestReport?.git.branch || "unknown", mono: true },
  { label: "提交", value: latestCommit.value, mono: true },
  { label: "脏文件", value: String(props.health?.latestReport?.git.dirtyFileCount ?? 0) },
  {
    label: "权限内核",
    value: `${capabilityKernel.value?.provider || "unknown"} / ${capabilityKernel.value?.securityMode || "unknown"}`,
    mono: true,
  },
  {
    label: "权限状态",
    value: capabilityKernel.value?.degraded ? "degraded" : capabilityKernel.value?.status || "unknown",
    mono: true,
  },
  {
    label: "权限绑定",
    value: `${capabilityKernel.value?.bindingCount ?? 0} keys / ${capabilityKernel.value?.permissionBindingCount ?? 0} bindings`,
  },
  {
    label: "恢复能力",
    value: capabilityKernel.value?.recoverySupported ? "recovery package" : "unavailable",
    mono: true,
  },
  {
    label: "绑定守卫",
    value: `${capabilityBindingGuard.value?.provider || "unknown"} / ${capabilityBindingGuard.value?.securityMode || "unknown"}`,
    mono: true,
  },
  {
    label: "绑定状态",
    value: `${capabilityBindingGuard.value?.activeBindingCount ?? 0} active / ${capabilityBindingGuard.value?.bindingCount ?? 0} total`,
  },
]);
</script>

<template>
  <article class="surface-card production-health-hero">
    <div class="section-header">
      <div>
        <h3>交付门禁</h3>
        <p>汇总生产准入报告、质量门禁、运行时治理、权限安全、备份恢复和发版连续性状态。</p>
      </div>
      <div class="section-tags">
        <span>{{ health?.latestReport?.runId || "无报告" }}</span>
        <span>{{ reportGeneratedAt }}</span>
      </div>
    </div>

    <div v-if="loadError" class="status-strip danger">
      <strong>读取失败</strong>
      <span>{{ loadError }}</span>
    </div>

    <div class="detail-metrics production-health-metrics">
      <div>
        <span>通过门禁</span>
        <strong>{{ health?.summary.pass || 0 }}</strong>
      </div>
      <div>
        <span>失败门禁</span>
        <strong>{{ health?.summary.fail || 0 }}</strong>
      </div>
      <div>
        <span>超时门禁</span>
        <strong>{{ health?.summary.timeout || 0 }}</strong>
      </div>
      <div>
        <span>P0 阻塞</span>
        <strong>{{ health?.summary.blockedP0 || 0 }}</strong>
      </div>
    </div>

    <div v-if="capabilityKernel" :class="['status-strip', capabilityKernel.degraded ? 'warning' : capabilityKernel.ok ? 'success' : 'danger']">
      <strong>Capability Kernel</strong>
      <span>{{ capabilityKernel.securityMode || capabilityKernel.status }} · {{ capabilityKernel.message }}</span>
    </div>

    <div v-if="capabilityBindingGuard" :class="['status-strip', capabilityBindingGuard.degraded ? 'warning' : capabilityBindingGuard.ok ? 'success' : 'danger']">
      <strong>Binding Guard</strong>
      <span>{{ capabilityBindingGuard.securityMode || capabilityBindingGuard.status }} · {{ capabilityBindingGuard.message }}</span>
    </div>

    <ConsoleDescriptionList :items="healthMetaItems" :columns="4" />
  </article>
</template>

<style scoped>
.production-health-hero {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.production-health-metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

@media (max-width: 1120px) {
  .production-health-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .production-health-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
