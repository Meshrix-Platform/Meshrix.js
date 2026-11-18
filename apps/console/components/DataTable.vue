<script setup lang="ts" generic="T">
import { useSlots } from 'vue';

const props = defineProps<{
  data: T[];
  rowKey?: string | ((row: T) => string);
  emptyText?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: 'scroll', evt: Event): void;
  (e: 'header-dragend', newWidth: number, oldWidth: number, column: any, evt: Event): void;
}>();

function handleScroll(evt: Event) {
  emit('scroll', evt);
}

function handleHeaderDragend(newWidth: number, oldWidth: number, column: any, evt: Event) {
  emit('header-dragend', newWidth, oldWidth, column, evt);
}
</script>

<template>
  <el-table
    :data="data"
    :row-key="rowKey"
    :empty-text="emptyText"
    v-loading="loading"
    size="default"
    scrollbar-always-on
    class="meshrix-data-table"
    @scroll="handleScroll"
    @header-dragend="handleHeaderDragend"
  >
    <slot />
  </el-table>
</template>

<style>
.meshrix-data-table.el-table {
  --meshrix-table-row-bg: var(--bg-surface);
  --meshrix-table-row-hover-bg: var(--console-frame);
  --el-table-bg-color: var(--bg-surface);
  --el-table-tr-bg-color: var(--meshrix-table-row-bg);
  --el-table-border-color: var(--console-rule);
  --el-table-header-bg-color: var(--console-frame);
  --el-table-row-hover-bg-color: var(--meshrix-table-row-hover-bg);
  --el-table-text-color: var(--text-primary);
  --el-table-header-text-color: var(--console-ink-secondary);
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.meshrix-data-table.el-table .el-table__inner-wrapper,
.meshrix-data-table.el-table .el-table__body-wrapper,
.meshrix-data-table.el-table .el-scrollbar,
.meshrix-data-table.el-table .el-scrollbar__view,
.meshrix-data-table.el-table .el-table__body {
  background: var(--bg-surface);
}

.meshrix-data-table.el-table th.el-table__cell {
  background: var(--bg-surface) !important;
  color: var(--console-ink-secondary);
}

.meshrix-data-table.el-table td.el-table__cell {
  background: var(--meshrix-table-row-bg) !important;
  color: var(--text-primary);
}

.meshrix-data-table.el-table .el-table__body tr:hover > td.el-table__cell,
.meshrix-data-table.el-table .el-table__body tr.hover-row > td.el-table__cell,
.meshrix-data-table.el-table--enable-row-hover .el-table__body tr:hover > td.el-table__cell {
  background: var(--meshrix-table-row-hover-bg) !important;
}

.meshrix-data-table.el-table .el-table__empty-block {
  background: var(--bg-surface);
}

.meshrix-data-table.el-table .el-table__empty-text {
  color: var(--console-ink-secondary);
}

.meshrix-data-table .el-table__cell {
  padding: var(--space-3) 0;
  vertical-align: top;
  font-size: var(--text-lg);
  line-height: var(--leading-normal);
}

.meshrix-data-table.el-table td.el-table__cell,
.meshrix-data-table.el-table th.el-table__cell.is-leaf {
  border-bottom: 1px solid var(--console-rule) !important;
}
</style>
