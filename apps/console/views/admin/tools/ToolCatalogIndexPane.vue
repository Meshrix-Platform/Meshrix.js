<script setup lang="ts">
import {
  scopeLabel,
  toolRiskLabel,
} from "../../../composables/console-tool-display-utils";
import type {
  OperationPermissionScope,
  OperationPermissionToolGroup,
} from "../../../lib/operation-permission-client";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";

const props = withDefaults(
  defineProps<{
    groups?: OperationPermissionToolGroup[];
    selectedToolsetId?: string;
    toolScopes?: OperationPermissionScope[];
  }>(),
  {
    groups: () => [],
    selectedToolsetId: "",
    toolScopes: () => [],
  },
);

const emit = defineEmits<{
  "select-toolset": [toolsetId: string];
}>();

function renderScopeLabel(scopeId: string) {
  return scopeLabel(scopeId, props.toolScopes);
}
</script>

<template>
  <aside class="tool-catalog-index-pane" aria-label="工具集索引">
    <div class="tool-catalog-pane-header">
      <h4>工具集</h4>
      <span>{{ groups.length }} 个</span>
    </div>
    <ConsoleEmptyState v-if="groups.length === 0" compact title="尚未加载工具目录" />
    <div v-else class="tool-catalog-index-list">
      <button
        v-for="group in groups"
        :key="group.id"
        class="tool-catalog-index-item"
        type="button"
        :aria-pressed="selectedToolsetId === group.id"
        :data-active="selectedToolsetId === group.id"
        @click="emit('select-toolset', group.id)"
      >
        <span class="tool-catalog-index-title">
          <strong>{{ group.label }}</strong>
          <small>{{ group.id }}</small>
        </span>
        <span class="tool-catalog-index-badges">
          <span>{{ group.defaultForAgents ? "默认" : group.grantable ? "可授予" : "受限" }}</span>
          <span>{{ group.toolCount }} 个</span>
          <span>{{ toolRiskLabel(group.maxRisk) }}</span>
        </span>
        <span class="tool-catalog-index-meta">
          {{ group.requiredScopes.map(renderScopeLabel).join("，") || "未声明权限" }}
        </span>
      </button>
    </div>
  </aside>
</template>
