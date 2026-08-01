<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useOperationPermissionViewContext } from "../../../composables/operationPermissionViewContext";
import ConsoleEmptyState from "../../ConsoleEmptyState.vue";

const {
  busyKey,
  setGrantToolRule,
  toolGrants,
  operationPermissionTools,
} = useOperationPermissionViewContext();

type GrantToolRule = "allow" | "deny";
type GrantToolRuleRow = {
  grantId: string;
  grantLabel: string;
  toolId: string;
  toolLabel: string;
  toolDescription: string;
  rule: GrantToolRule;
};

const selectedGrantId = ref("");
const selectedToolId = ref("");
const selectedRule = ref<GrantToolRule>("deny");

const selectedGrant = computed(() =>
  toolGrants.value.find((grant: any) => grant.id === selectedGrantId.value) || toolGrants.value[0],
);

const exceptionRows = computed(() => {
  const rows: GrantToolRuleRow[] = [];

  for (const grant of toolGrants.value) {
    for (const toolId of grant.toolAllow || []) {
      const tool = operationPermissionTools.value.find((item: any) => item.id === toolId);
      rows.push({
        grantId: grant.id,
        grantLabel: grant.label || grant.id,
        toolId,
        toolLabel: tool?.label || toolId,
        toolDescription: tool?.description || toolId,
        rule: "allow",
      });
    }
    for (const toolId of grant.toolDeny || []) {
      const tool = operationPermissionTools.value.find((item: any) => item.id === toolId);
      rows.push({
        grantId: grant.id,
        grantLabel: grant.label || grant.id,
        toolId,
        toolLabel: tool?.label || toolId,
        toolDescription: tool?.description || toolId,
        rule: "deny",
      });
    }
  }

  return rows.sort((a: any, b: any) => a.grantLabel.localeCompare(b.grantLabel) || a.toolLabel.localeCompare(b.toolLabel));
});

const availableToolsForSelectedGrant = computed(() => {
  const grant = selectedGrant.value;
  if (!grant) {
    return [];
  }
  const configured = new Set([...(grant.toolAllow || []), ...(grant.toolDeny || [])]);
  return operationPermissionTools.value.filter((tool: any) => !configured.has(tool.id));
});

watch(
  toolGrants,
  (grants: any) => {
    if (grants.length === 0) {
      selectedGrantId.value = "";
      return;
    }
    if (!grants.some((grant: any) => grant.id === selectedGrantId.value)) {
      selectedGrantId.value = grants[0]?.id || "";
    }
  },
  { immediate: true },
);

watch(
  availableToolsForSelectedGrant,
  (tools: any) => {
    if (!tools.some((tool: any) => tool.id === selectedToolId.value)) {
      selectedToolId.value = tools[0]?.id || "";
    }
  },
  { immediate: true },
);

function addGrantToolRule() {
  if (!selectedGrant.value || !selectedToolId.value) {
    return;
  }
  setGrantToolRule(selectedGrant.value, selectedToolId.value, selectedRule.value);
}

function findGrant(grantId: string) {
  return toolGrants.value.find((grant: any) => grant.id === grantId);
}

function ruleLabel(rule: GrantToolRule) {
  return rule === "allow" ? "允许" : "未启用";
}

function setRowRule(row: GrantToolRuleRow, rule: "inherit" | "allow" | "deny") {
  const grant = findGrant(row.grantId);
  if (!grant) {
    return;
  }
  setGrantToolRule(grant, row.toolId, rule);
}
</script>

<template>
  <article class="surface-card permission-list-card grant-exception-card">
    <div class="section-header">
      <div>
        <h3>令牌工具例外</h3>
        <p>只为需要覆盖工具集规则的工具添加例外；没有例外时，令牌完全继承所选工具集。</p>
      </div>
      <div class="section-tags">
        <span>例外 {{ exceptionRows.length }}</span>
      </div>
    </div>

    <div v-if="toolGrants.length > 0 && operationPermissionTools.length > 0" class="permission-exception-toolbar">
      <label class="module-field">
        <span>令牌</span>
        <select v-model="selectedGrantId">
          <option
            v-for="grant in toolGrants"
            :key="grant.id"
            :value="grant.id"
          >
            {{ grant.label || grant.id }}
          </option>
        </select>
      </label>
      <label class="module-field">
        <span>工具</span>
        <select v-model="selectedToolId" :disabled="availableToolsForSelectedGrant.length === 0">
          <option
            v-for="tool in availableToolsForSelectedGrant"
            :key="tool.id"
            :value="tool.id"
          >
            {{ tool.label }}
          </option>
        </select>
      </label>
      <label class="module-field compact-select-field">
        <span>规则</span>
        <select v-model="selectedRule">
          <option value="deny">未启用</option>
          <option value="allow">允许</option>
        </select>
      </label>
      <button
        class="tool-button"
        type="button"
        :disabled="!selectedGrant || !selectedToolId"
        @click="addGrantToolRule"
      >
        添加例外
      </button>
    </div>

    <div v-if="exceptionRows.length > 0" class="job-table compact-job-table grant-tool-rule-table">
      <div class="job-table-header">
        <span>授权</span>
        <span>工具</span>
        <span>当前规则</span>
        <span>操作</span>
      </div>
      <div
        v-for="row in exceptionRows"
        :key="`${row.grantId}:${row.toolId}`"
        class="job-row"
      >
        <span>
          <strong>{{ row.grantLabel }}</strong>
          <small>{{ row.grantId }}</small>
        </span>
        <span>
          <strong>{{ row.toolLabel }}</strong>
          <small>{{ row.toolDescription }}</small>
        </span>
        <span>{{ ruleLabel(row.rule) }}</span>
        <span class="permission-actions">
          <button
            class="table-action"
            type="button"
            :disabled="busyKey === `grant:${row.grantId}`"
            @click="setRowRule(row, 'inherit')"
          >
            继承
          </button>
          <button
            class="table-action"
            type="button"
            :disabled="busyKey === `grant:${row.grantId}`"
            @click="setRowRule(row, 'allow')"
          >
            允许
          </button>
          <button
            class="table-action danger-action"
            type="button"
            :disabled="busyKey === `grant:${row.grantId}`"
            @click="setRowRule(row, 'deny')"
          >
            未启用
          </button>
        </span>
      </div>
    </div>
    <ConsoleEmptyState v-else-if="toolGrants.length === 0" compact title="暂无授权" />
    <ConsoleEmptyState
      v-else
      compact
      title="暂无工具例外"
      description="未覆盖的工具不会逐条列出，它们会继承各自令牌的工具集规则。"
    />
  </article>
</template>
