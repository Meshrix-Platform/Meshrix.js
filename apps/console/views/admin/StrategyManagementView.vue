<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import {
  isStrategyPreviewCapability,
  loadStrategyDescription,
  parseStrategyPreviewInput,
  previewStrategyCapability,
  type StrategyDescription,
  type StrategyPolicyDecision,
  type StrategyPreviewState,
} from "../../lib/strategy-management";
import ConsoleEmptyState from "../../components/ConsoleEmptyState.vue";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";

const description = ref<StrategyDescription | null>(null);
const descriptionLoading = ref(false);
const descriptionError = ref("");
const selectedCapability = ref("");
const previewInput = ref("");
const previewState = ref<StrategyPreviewState>("empty");
const previewDecision = ref<StrategyPolicyDecision | null>(null);
const previewError = ref("");

const previewCapabilities = computed(() =>
  (description.value?.capabilities || []).filter(isStrategyPreviewCapability),
);
const decisionFacts = computed(() => {
  const decision = previewDecision.value;
  if (!decision) return [];
  return [
    ["结果", decision.effect],
    ["原因代码", decision.reasonCode],
    ["策略类型", decision.policyType],
    ["需要批准", typeof decision.requiresApproval === "boolean" ? (decision.requiresApproval ? "是" : "否") : ""],
    ["决策标识", decision.decisionId],
    ["评估时间", decision.createdAt],
  ].filter((item: any): item is [string, string] => Boolean(item[1]));
});

async function refreshDescription() {
  descriptionLoading.value = true;
  descriptionError.value = "";
  previewState.value = "empty";
  previewDecision.value = null;
  previewError.value = "";
  try {
    description.value = await loadStrategyDescription();
    if (!previewCapabilities.value.includes(selectedCapability.value)) selectedCapability.value = "";
  } catch (nextError: unknown) {
    description.value = null;
    selectedCapability.value = "";
    descriptionError.value =
      nextError instanceof Error && nextError.message
        ? nextError.message
        : "策略能力加载失败。";
  } finally {
    descriptionLoading.value = false;
  }
}

async function runPreview() {
  previewError.value = "";
  previewDecision.value = null;
  let input: Record<string, unknown>;
  try {
    input = parseStrategyPreviewInput(previewInput.value);
  } catch (error) {
    previewState.value = "error";
    previewError.value = error instanceof Error ? error.message : "预览输入无效。";
    return;
  }
  previewState.value = "loading";
  const result = await previewStrategyCapability(selectedCapability.value, input);
  previewState.value = result.state;
  previewDecision.value = result.decision;
  previewError.value = result.error;
}

onMounted(() => {
  void refreshDescription();
});

usePageRefreshHandler(
  (detail: any) => detail.viewId === "admin" && detail.adminView === "strategyManagement",
  refreshDescription,
);
</script>

<template>
  <section class="strategy-management-layout" :data-preview-state="previewState">
    <section class="surface-card strategy-capability-card">
      <div class="section-header">
        <div>
          <h3>可执行策略能力</h3>
          <p>{{ description?.protocolVersion || "尚无服务端能力描述" }}</p>
        </div>
      </div>
      <ConsoleInlineAlert v-if="descriptionError" tone="danger">
        {{ descriptionError }}
        <template #action>
          <button
            class="table-action"
            type="button"
            :disabled="descriptionLoading"
            :aria-busy="descriptionLoading"
            @click="refreshDescription"
          >
            {{ descriptionLoading ? "重试中" : "重试" }}
          </button>
        </template>
      </ConsoleInlineAlert>
      <ConsoleEmptyState
        v-else-if="!descriptionLoading && !description?.capabilities.length"
        compact
        title="服务端当前未提供策略能力。"
      />
      <ul v-else class="strategy-capability-list">
        <li v-for="capability in description?.capabilities || []" :key="capability">{{ capability }}</li>
      </ul>
    </section>

    <section class="surface-card strategy-preview-card">
      <div class="section-header">
        <div>
          <h3>策略预览</h3>
          <p>预览仅解释当前策略，不授予后续执行权限。</p>
        </div>
      </div>
      <label class="strategy-field">
        <span>能力</span>
        <select v-model="selectedCapability" :disabled="descriptionLoading || !previewCapabilities.length">
          <option value="">请选择服务端能力</option>
          <option v-for="capability in previewCapabilities" :key="capability" :value="capability">
            {{ capability }}
          </option>
        </select>
      </label>
      <label class="strategy-field">
        <span>输入（JSON 对象）</span>
        <textarea
          v-model="previewInput"
          rows="8"
          spellcheck="false"
          placeholder="输入本次预览所需的显式字段"
        />
      </label>
      <div class="strategy-preview-actions">
        <button
          class="primary"
          type="button"
          :disabled="previewState === 'loading' || !selectedCapability"
          @click="runPreview"
        >
          {{ previewState === "loading" ? "预览中" : "执行预览" }}
        </button>
      </div>

      <ConsoleEmptyState v-if="previewState === 'empty'" compact title="尚未执行预览。" />
      <ConsoleInlineAlert v-else-if="previewState === 'error'" tone="danger">{{ previewError }}</ConsoleInlineAlert>
      <div v-else-if="previewState === 'accepted' || previewState === 'denied'" class="strategy-preview-result">
        <strong>{{ previewState === "accepted" ? "已接受" : "已拒绝" }}</strong>
        <dl>
          <div v-for="fact in decisionFacts" :key="fact[0]">
            <dt>{{ fact[0] }}</dt>
            <dd>{{ fact[1] }}</dd>
          </div>
          <div v-if="previewDecision?.evaluatedLayers?.length">
            <dt>公开评估层</dt>
            <dd>{{ previewDecision.evaluatedLayers.join(", ") }}</dd>
          </div>
        </dl>
      </div>
    </section>
  </section>
</template>

<style scoped>
.strategy-management-layout {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  gap: var(--space-4);
  align-items: start;
}

.strategy-capability-card,
.strategy-preview-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.strategy-capability-card > .section-header,
.strategy-preview-card > .section-header {
  margin-bottom: 0;
}

.strategy-capability-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: 0;
  margin: 0;
  list-style: none;
}

.strategy-capability-list li {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.strategy-field {
  display: grid;
  gap: var(--space-2);
}

.strategy-field > span {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
}

.strategy-field select,
.strategy-field textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font: inherit;
}

.strategy-field select {
  min-height: 38px;
  padding: 0 var(--space-3);
}

.strategy-field textarea {
  padding: var(--space-3);
  font-family: var(--font-mono);
  resize: vertical;
}

.strategy-preview-actions {
  display: flex;
  justify-content: flex-end;
}

.strategy-preview-result {
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}

.strategy-preview-result > strong {
  color: var(--text-primary);
}

.strategy-preview-result dl {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
}

.strategy-preview-result dl > div {
  display: grid;
  grid-template-columns: minmax(96px, 0.25fr) minmax(0, 1fr);
  gap: var(--space-3);
}

.strategy-preview-result dt {
  color: var(--text-muted);
}

.strategy-preview-result dd {
  margin: 0;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  .strategy-management-layout {
    grid-template-columns: 1fr;
  }
}
</style>
