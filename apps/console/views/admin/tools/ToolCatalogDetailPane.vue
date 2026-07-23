<script setup lang="ts">
import {
  scopeLabel,
  toolRiskLabel,
  toolStatusLabel,
  toolsetLabel,
} from "../../../composables/console-tool-display-utils";
import type {
  OperationPermissionScope,
  OperationPermissionTool,
  OperationPermissionToolGroup,
  OperationPermissionToolset,
} from "../../../lib/operation-permission-client";
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";

const props = withDefaults(
  defineProps<{
    toolset?: OperationPermissionToolGroup | null;
    tools?: OperationPermissionTool[];
    selectedToolId?: string;
    toolsets?: OperationPermissionToolset[];
    toolScopes?: OperationPermissionScope[];
    groupsCount?: number;
  }>(),
  {
    toolset: null,
    tools: () => [],
    selectedToolId: "",
    toolsets: () => [],
    toolScopes: () => [],
    groupsCount: 0,
  },
);

function renderScopeLabel(scopeId: string) {
  return scopeLabel(scopeId, props.toolScopes);
}

function renderToolsetLabel(toolsetId: string) {
  return toolsetLabel(toolsetId, props.toolsets);
}
</script>

<template>
  <section class="tool-catalog-detail-pane" aria-label="原子工具">
    <div class="section-header">
      <div>
        <h3>{{ toolset?.label || "原子工具" }}</h3>
      </div>
      <div class="section-tags">
        <span>{{ toolset ? toolset.id : "未选择工具集" }}</span>
        <span>{{ tools.length }} 个</span>
      </div>
    </div>

    <div
      v-if="toolset"
      class="job-table compact-job-table tool-list-table"
    >
      <div class="job-table-header">
        <span>工具</span>
        <span>来源</span>
        <span>工具集</span>
        <span>权限层级</span>
        <span>风险</span>
        <span>状态</span>
      </div>
      <div
        v-for="tool in tools"
        :key="tool.id"
        class="job-row"
        :data-active="selectedToolId === tool.id"
        :data-tool-id="tool.id"
      >
        <span data-label="工具">
          <strong>{{ tool.label }}</strong>
          <small>{{ tool.id }}</small>
        </span>
        <span data-label="来源">
          <strong>{{ tool.source || "未声明" }}</strong>
          <small>{{ tool.operationId || "无操作映射" }}</small>
        </span>
        <span data-label="工具集">{{ tool.toolsets.map(renderToolsetLabel).join("，") || "未声明" }}</span>
        <span data-label="权限层级">{{ tool.requiredScopes.map(renderScopeLabel).join("，") || "未声明" }}</span>
        <span data-label="风险">{{ toolRiskLabel(tool.risk) }}</span>
        <span data-label="状态">{{ toolStatusLabel(tool.status) }}</span>
      </div>
    </div>

    <ConsoleEmptyState v-else-if="groupsCount === 0" title="尚未加载工具目录" />
    <ConsoleEmptyState v-else title="选择左侧工具集后查看原子工具" />
  </section>
</template>
