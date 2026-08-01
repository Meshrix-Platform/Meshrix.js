<script setup lang="ts">
import { computed } from "vue";
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";
import StatusPill from "../../StatusPill.vue";
import {
  elapsedText,
  statusLabel,
  type ProductionHealthGate,
} from "../../../lib/production-health";

const props = defineProps<{
  gates: ProductionHealthGate[];
}>();

const failedGates = computed(() => props.gates.filter((gate: any) => gate.status !== "pass"));
</script>

<template>
  <article class="surface-card">
    <div class="section-header">
      <div>
        <h3>门禁明细</h3>
      </div>
      <div class="section-tags">
        <span>{{ gates.length }} 项</span>
        <span>未通过 {{ failedGates.length }}</span>
      </div>
    </div>
    <div v-if="gates.length" class="job-table compact-job-table production-gate-table">
      <div class="job-table-header">
        <span>门禁</span>
        <span>状态</span>
        <span>负责人</span>
        <span>命令</span>
        <span>证据和下一步</span>
      </div>
      <div v-for="gate in gates" :key="gate.id" class="job-row">
        <span>
          <strong>{{ gate.title }}</strong>
	          <small>{{ gate.id }}</small>
	          <small>{{ gate.blockerLevel || "未分级" }}</small>
        </span>
        <span>
          <StatusPill :tone="gate.tone" :label="statusLabel(gate.status)" />
        </span>
        <span>
          <strong>{{ gate.owner || "未声明" }}</strong>
	          <small>{{ gate.coverage.join("，") || "无覆盖声明" }}</small>
        </span>
        <span>
          <strong>{{ gate.commandSummary.total }} 条</strong>
	          <small>失败 {{ gate.commandSummary.failed }}</small>
	          <small>超时 {{ gate.commandSummary.timedOut }}</small>
	          <small>{{ elapsedText(gate) }}</small>
        </span>
        <span>
          <strong>{{ gate.evidencePath || "无证据路径" }}</strong>
          <small>{{ gate.status === "pass" ? "已闭环" : gate.nextStep }}</small>
        </span>
      </div>
    </div>
    <ConsoleEmptyState
      v-else
      title="暂无生产准入报告"
      description="执行生产准入 verifier 后会在这里显示最新门禁。"
    />
  </article>
</template>

<style scoped>
.production-gate-table {
  --table-columns: minmax(210px, 1.2fr) minmax(90px, 0.5fr) minmax(160px, 0.8fr) minmax(160px, 0.8fr) minmax(280px, 1.4fr);
}

.production-gate-table .job-table-header,
.production-gate-table .job-row {
  grid-template-columns: var(--table-columns);
}

@media (max-width: 1120px) {
  .production-gate-table {
    overflow-x: auto;
  }

  .production-gate-table .job-table-header,
  .production-gate-table .job-row {
    min-width: 980px;
  }
}
</style>
