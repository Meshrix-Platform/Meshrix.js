<script setup lang="ts">
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";
import type { TagManagementTreeRow } from "../../../composables/console-tag-management-controller";

withDefaults(defineProps<{
  treeRows?: TagManagementTreeRow[];
  selectedTagId?: string;
}>(), {
  treeRows: () => [],
  selectedTagId: "",
});

const emit = defineEmits<{
  select: [tagId: string];
}>();
</script>

<template>
  <aside class="surface-card tag-tree-panel">
    <div class="section-header">
      <div>
        <h3>Tag 树</h3>
        <p>{{ treeRows.length }} 个节点</p>
      </div>
    </div>
    <div class="tag-tree-list">
      <button
        v-for="row in treeRows"
        :key="row.tag.tagId"
        class="tag-tree-row"
        :class="{ active: row.tag.tagId === selectedTagId, archived: row.tag.status === 'archived' }"
        type="button"
        :style="{ paddingLeft: `${12 + row.depth * 18}px` }"
        @click="emit('select', row.tag.tagId)"
      >
        <span class="tag-tree-row-main">
          <strong>{{ row.tag.label }}</strong>
          <small>{{ row.tag.tagId }}</small>
        </span>
        <span class="tag-pill">{{ row.tag.kind }}</span>
      </button>
      <ConsoleEmptyState v-if="!treeRows.length" compact title="暂无 Tag" />
    </div>
  </aside>
</template>

<style scoped>
.tag-tree-panel {
  min-width: 0;
  position: sticky;
  top: var(--space-4);
  max-height: calc(100vh - 160px);
  overflow: hidden;
}

.tag-tree-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: calc(100vh - 240px);
  overflow: auto;
}

.tag-tree-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.tag-tree-row:hover,
.tag-tree-row.active {
  border-color: var(--border-subtle);
  background: var(--bg-subtle);
}

.tag-tree-row.archived {
  opacity: 0.62;
}

.tag-tree-row-main {
  min-width: 0;
}

.tag-tree-row-main strong,
.tag-tree-row-main small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-tree-row-main small {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tag-pill {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

@media (max-width: 900px) {
  .tag-tree-panel {
    position: static;
    max-height: none;
  }

  .tag-tree-list {
    max-height: 360px;
  }
}
</style>
