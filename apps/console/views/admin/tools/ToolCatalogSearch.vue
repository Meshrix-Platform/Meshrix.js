<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Close, Search } from "@element-plus/icons-vue";
import {
  scopeLabel,
  toolsetLabel,
} from "../../../composables/console-tool-display-utils";
import type {
  OperationPermissionScope,
  OperationPermissionTool,
  OperationPermissionToolset,
} from "../../../lib/operation-permission-client";

const props = withDefaults(
  defineProps<{
    tools?: OperationPermissionTool[];
    toolsets?: OperationPermissionToolset[];
    toolScopes?: OperationPermissionScope[];
    selectedToolsetId?: string;
    selectedToolId?: string;
  }>(),
  {
    tools: () => [],
    toolsets: () => [],
    toolScopes: () => [],
    selectedToolsetId: "",
    selectedToolId: "",
  },
);

const emit = defineEmits<{
  "select-tool": [toolId: string];
  "select-toolset": [toolsetId: string];
}>();

const toolSearchQuery = ref("");
const toolSearchOpen = ref(false);
const normalizedToolSearchQuery = computed(() => toolSearchQuery.value.trim().toLowerCase());

function renderScopeLabel(scopeId: string) {
  return scopeLabel(scopeId, props.toolScopes);
}

function renderToolsetLabel(toolsetId: string) {
  return toolsetLabel(toolsetId, props.toolsets);
}

function toolSearchText(tool: OperationPermissionTool) {
  const tags = Array.isArray(tool.tags) ? tool.tags : [];
  const toolsets = Array.isArray(tool.toolsets) ? tool.toolsets : [];
  const requiredScopes = Array.isArray(tool.requiredScopes) ? tool.requiredScopes : [];
  return [
    tool.label,
    tool.id,
    tool.description,
    tool.source,
    tool.operationId,
    tool.handlerId,
    tags.join(" "),
    toolsets.join(" "),
    toolsets.map(renderToolsetLabel).join(" "),
    requiredScopes.join(" "),
    requiredScopes.map(renderScopeLabel).join(" "),
  ].join(" ").toLowerCase();
}

function toolSearchScore(tool: OperationPermissionTool, query: string) {
  const id = tool.id.toLowerCase();
  const label = tool.label.toLowerCase();
  if (id === query) {
    return 100;
  }
  if (label === query) {
    return 90;
  }
  if (id.startsWith(query)) {
    return 80;
  }
  if (label.startsWith(query)) {
    return 70;
  }
  if (id.includes(query)) {
    return 60;
  }
  if (label.includes(query)) {
    return 50;
  }
  return 10;
}

const toolSearchResults = computed(() => {
  const query = normalizedToolSearchQuery.value;
  if (!query) {
    return [];
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  return props.tools
    .map((tool) => ({
      tool,
      searchText: toolSearchText(tool),
      score: toolSearchScore(tool, query),
    }))
    .filter((item) => tokens.every((token) => item.searchText.includes(token)))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.tool.label.localeCompare(right.tool.label);
    })
    .slice(0, 10)
    .map((item) => item.tool);
});

const showToolSearchResults = computed(
  () => toolSearchOpen.value && normalizedToolSearchQuery.value.length > 0,
);

function toolSearchToolsetLabel(tool: OperationPermissionTool) {
  const currentToolset = tool.toolsets.find((toolsetId) => toolsetId === props.selectedToolsetId);
  return renderToolsetLabel(currentToolset || tool.toolsets[0] || "");
}

function scrollSelectedToolIntoView(toolId: string) {
  window.requestAnimationFrame(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>(".tool-list-table [data-tool-id]"))
      .find((element) => element.dataset.toolId === toolId);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

async function jumpToToolSearchResult(tool: OperationPermissionTool) {
  const nextToolsetId = tool.toolsets.includes(props.selectedToolsetId)
    ? props.selectedToolsetId
    : tool.toolsets[0] || "";
  if (nextToolsetId) {
    emit("select-toolset", nextToolsetId);
  }
  emit("select-tool", tool.id);
  toolSearchOpen.value = false;
  await nextTick();
  scrollSelectedToolIntoView(tool.id);
}

async function jumpToFirstToolSearchResult() {
  const firstResult = toolSearchResults.value[0];
  if (firstResult) {
    await jumpToToolSearchResult(firstResult);
  }
}

function clearToolSearch() {
  toolSearchQuery.value = "";
  toolSearchOpen.value = false;
}

function closeToolSearchSoon() {
  window.setTimeout(() => {
    toolSearchOpen.value = false;
  }, 120);
}
</script>

<template>
  <div class="tool-catalog-search" role="search">
    <label class="tool-catalog-search-field">
      <Search aria-hidden="true" class="tool-catalog-search-icon" />
      <input
        v-model="toolSearchQuery"
        type="search"
        autocomplete="off"
        aria-label="搜索并跳转工具"
        placeholder="搜索工具名称或 ID"
        @focus="toolSearchOpen = true"
        @blur="closeToolSearchSoon"
        @input="toolSearchOpen = true"
        @keydown.enter.prevent="jumpToFirstToolSearchResult"
        @keydown.esc.prevent="toolSearchOpen = false"
      />
      <button
        v-if="toolSearchQuery"
        class="tool-catalog-search-clear"
        type="button"
        aria-label="清空工具搜索"
        @click="clearToolSearch"
      >
        <Close aria-hidden="true" />
      </button>
    </label>
    <div
      v-if="showToolSearchResults"
      class="tool-catalog-search-popover"
      role="listbox"
      aria-label="工具搜索结果"
    >
      <button
        v-for="tool in toolSearchResults"
        :key="tool.id"
        class="tool-catalog-search-option"
        type="button"
        role="option"
        :aria-selected="selectedToolId === tool.id"
        @pointerdown.prevent="jumpToToolSearchResult(tool)"
      >
        <span>
          <strong>{{ tool.label }}</strong>
          <small>{{ tool.id }}</small>
        </span>
        <em>{{ toolSearchToolsetLabel(tool) }}</em>
      </button>
      <div v-if="toolSearchResults.length === 0" class="tool-catalog-search-empty">
        未找到匹配工具
      </div>
    </div>
  </div>
</template>
