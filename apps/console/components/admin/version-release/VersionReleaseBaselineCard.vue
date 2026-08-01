<script setup lang="ts">
import { computed } from "vue";
import ConsoleDescriptionList from "../../ConsoleDescriptionList.vue";
import StatusPill from "../../StatusPill.vue";
import { statusTone } from "../../../lib/production-health";
import type { ReadinessBaselineStatus } from "../../../lib/version-release";

const props = defineProps<{
  baseline: ReadinessBaselineStatus | null;
  baselineError: string;
}>();

const baselinePortLabels = computed(() => (props.baseline?.ports || []).map((port: any) => ({
  id: port.port,
  label: port.port,
  value: port.verificationMode || port.implementation,
})));
const baselineProtocolItems = computed(() => [
  { label: "协议版本", value: props.baseline?.protocolVersion || "v0.0.1:platform:baseline-1", mono: true },
  { label: "验证模式", value: props.baseline?.verificationMode || "等待加载", mono: true },
]);
const baselineMetaItems = computed(() => [
  { label: "就绪结论", value: props.baseline?.readiness?.status || "not-assessed", mono: true },
  { label: "结论权威", value: props.baseline?.readiness?.authority || "platform-acceptance-reducer", mono: true },
  { label: "外部状态", value: props.baseline?.boundaries.externalState || "contract-mode adapters", mono: true },
]);
</script>

<template>
  <article class="surface-card version-release-baseline-card">
    <div class="section-header">
      <div>
        <h3>运行基线</h3>
        <p>展示单机运行基线、五类 MCP 出口和本地通用切面状态。</p>
      </div>
    </div>
    <div class="version-release-baseline-summary">
      <div class="version-release-baseline-status">
        <span>基线状态</span>
        <StatusPill :tone="statusTone(baseline?.status === 'operational' ? 'pass' : 'missing')" :label="baseline?.status || '未读取'" />
      </div>
      <ConsoleDescriptionList :items="baselineProtocolItems" :columns="2" />
    </div>
    <div v-if="baselineError" class="status-strip danger">
      <strong>读取失败</strong>
      <span>{{ baselineError }}</span>
    </div>
    <div class="detail-metrics version-release-metrics">
      <div>
        <span>MCP 出口</span>
        <strong>{{ baseline?.mcpOutlets.length || 0 }}</strong>
      </div>
      <div>
        <span>通用切面</span>
        <strong>{{ baseline?.ports.length || 0 }}</strong>
      </div>
      <div>
        <span>状态语义</span>
        <strong>{{ baseline?.storageStates.length || 0 }}</strong>
      </div>
      <div>
        <span>Secret 模式</span>
        <strong>{{ baseline?.ports.find((port) => port.port === 'SecretStorePort')?.verificationMode || "unknown" }}</strong>
      </div>
    </div>
    <div class="version-release-token-list">
      <span v-for="outlet in baseline?.mcpOutlets || []" :key="outlet">{{ outlet }}</span>
    </div>
    <div class="version-release-token-list">
      <span v-for="port in baselinePortLabels" :key="port.id">{{ port.label }} · {{ port.value }}</span>
    </div>
    <ConsoleDescriptionList :items="baselineMetaItems" :columns="2" />
  </article>
</template>

<style scoped>
.version-release-baseline-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.version-release-baseline-card > .section-header {
  margin-bottom: 0;
}

.version-release-baseline-summary {
  display: grid;
  grid-template-columns: minmax(180px, 0.45fr) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: stretch;
}

.version-release-baseline-status {
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}

.version-release-baseline-status {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3);
}

.version-release-baseline-status > span {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.version-release-metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.version-release-token-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.version-release-token-list span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
}

@media (max-width: 1120px) {
  .version-release-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .version-release-baseline-summary {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 680px) {
  .version-release-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
