<script setup lang="ts">
import { computed } from "vue";
import "./HistorySessionPanel.css";
import ConsoleEmptyState from "./ConsoleEmptyState.vue";
import type { HistorySessionPanelItem } from "../types/app";

const props = defineProps<{
  items: Array<HistorySessionPanelItem & { label?: string; sublabel?: string }>;
  title?: string;
  subtitle?: string;
  maxHeight?: string;
  open?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "action", id: string): void;
  (e: "delete", id: string): void;
}>();

const resolvedTitle = computed(() => props.title || "历史记录");
const resolvedMaxHeight = computed(() => props.maxHeight || "235px");

function itemTitle(item: HistorySessionPanelItem & { label?: string }) {
  return item.title || item.label || item.id;
}

function itemMeta(item: HistorySessionPanelItem & { sublabel?: string }) {
  return item.meta || item.sublabel || "";
}

function selectItem(item: HistorySessionPanelItem) {
  if (item.disabled) {
    return;
  }
  emit("select", item.id);
}

function runItemAction(item: HistorySessionPanelItem) {
  if (item.disabled || item.actionDisabled) {
    return;
  }
  emit("action", item.id);
}
</script>

<template>
  <details class="history-session-panel" :open="open">
    <summary>
      {{ resolvedTitle }}
      <small>{{ subtitle || (items.length ? String(items.length) : "") }}</small>
    </summary>

    <ul class="history-session-list" :style="{ maxHeight: resolvedMaxHeight }">
      <li
        v-for="item in items"
        :key="item.id"
        class="history-session-item"
        :data-active="item.active"
        :data-disabled="item.disabled"
        @click="selectItem(item)"
      >
        <div class="history-session-main">
          <span class="history-session-label">{{ itemTitle(item) }}</span>
          <span v-if="itemMeta(item)" class="history-session-sublabel">{{ itemMeta(item) }}</span>
          <span v-if="item.preview" class="history-session-preview">{{ item.preview }}</span>
        </div>
        <button
          v-if="item.actionLabel"
          class="history-session-action"
          type="button"
          :disabled="item.disabled || item.actionDisabled"
          :aria-label="item.actionAriaLabel || item.actionLabel"
          @click.stop="runItemAction(item)"
        >{{ item.actionLabel }}</button>
        <button
          v-if="$attrs['onDelete'] !== undefined"
          class="history-session-delete"
          type="button"
          :disabled="item.disabled"
          :aria-label="item.deleteLabel || `删除 ${itemTitle(item)}`"
          :title="item.deleteLabel || `删除 ${itemTitle(item)}`"
          @click.stop="emit('delete', item.id)"
        >{{ item.deleteText || "删除" }}</button>
      </li>
      <ConsoleEmptyState v-if="!items.length" as="li" compact title="暂无历史记录" />
    </ul>
  </details>
</template>
