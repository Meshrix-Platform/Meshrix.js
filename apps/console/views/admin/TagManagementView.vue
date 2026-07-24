<script setup lang="ts">
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import {
  tagManagementKindOptions,
  tagManagementStatusOptions,
  useTagManagementConsole,
} from "../../composables/console-tag-management-controller";
import TagAuditList from "./tag-management/TagAuditList.vue";
import TagEditorForm from "./tag-management/TagEditorForm.vue";
import TagProjectionCard from "./tag-management/TagProjectionCard.vue";
import TagTreePanel from "./tag-management/TagTreePanel.vue";

const {
  archiveSelectedTag,
  auditItems,
  editor,
  error,
  includeArchived,
  kindFilter,
  loading,
  parentTagOptions,
  projections,
  rebuildProjections,
  refreshTagManagement,
  restoreSelectedTag,
  saveEditor,
  saving,
  selectTag,
  selectedProjection,
  selectedProjectionPayload,
  selectedTag,
  selectedTagId,
  startNewTag,
  status,
  statusFilter,
  tagStats,
  treeRows,
} = useTagManagementConsole();
</script>

<template>
  <section class="tag-management-layout">
    <header class="tag-management-header">
      <div class="tag-management-filters">
        <label>
          <span>类型</span>
          <select v-model="kindFilter">
            <option v-for="option in tagManagementKindOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select v-model="statusFilter">
            <option v-for="option in tagManagementStatusOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <BinaryCheckbox v-model="includeArchived" label="包含归档" />
      </div>
      <div class="tag-management-actions">
        <button class="table-action" type="button" :disabled="loading" @click="refreshTagManagement(true)">
          {{ loading ? "刷新中" : "刷新" }}
        </button>
        <button class="table-action" type="button" :disabled="saving" @click="rebuildProjections">
          重建投影
        </button>
        <button class="tool-button" type="button" @click="startNewTag">新建 Tag</button>
      </div>
    </header>

    <section class="surface-card tag-management-summary">
      <div>
        <span>全部</span>
        <strong>{{ tagStats.total }}</strong>
      </div>
      <div>
        <span>启用</span>
        <strong>{{ tagStats.active }}</strong>
      </div>
      <div>
        <span>归档</span>
        <strong>{{ tagStats.archived }}</strong>
      </div>
      <div>
        <span>投影</span>
        <strong>{{ tagStats.projections }}</strong>
      </div>
      <div>
        <span>审计</span>
        <strong>{{ tagStats.audit }}</strong>
      </div>
    </section>

    <ConsoleInlineAlert v-if="error" tone="danger">{{ error }}</ConsoleInlineAlert>
    <ConsoleInlineAlert v-if="status" tone="success">{{ status }}</ConsoleInlineAlert>

    <section class="tag-management-grid">
      <TagTreePanel :tree-rows="treeRows" :selected-tag-id="selectedTagId" @select="selectTag" />

      <section class="tag-detail-stack">
        <TagEditorForm
          :selected-tag="selectedTag"
          :saving="saving"
          :editor="editor"
          :parent-tag-options="parentTagOptions"
          @restore="restoreSelectedTag"
          @archive="archiveSelectedTag"
          @save="saveEditor"
        />

        <TagProjectionCard
          :selected-projection="selectedProjection"
          :projections="projections"
          :selected-projection-payload="selectedProjectionPayload"
        />

        <TagAuditList :audit-items="auditItems" />
      </section>
    </section>
  </section>
</template>

<style scoped>
.tag-management-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.tag-management-header,
.tag-management-filters,
.tag-management-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.tag-management-header {
  justify-content: space-between;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.tag-management-filters {
  flex-wrap: wrap;
}

.tag-management-filters label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.tag-management-filters span {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tag-management-filters select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  min-height: 34px;
  padding: 0 var(--space-2);
}

.tag-management-check {
  flex-direction: row !important;
  align-items: center;
  min-height: 34px;
}

.tag-management-check input {
  width: auto;
}

.tag-management-summary {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-3);
}

.tag-management-summary > div {
  min-width: 0;
}

.tag-management-summary span {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tag-management-summary strong {
  display: block;
  margin-top: var(--space-1);
  color: var(--text-primary);
  font-size: var(--text-xl);
}

.tag-management-grid {
  display: grid;
  grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.tag-detail-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

@media (max-width: 900px) {
  .tag-management-header,
  .tag-management-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .tag-management-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .tag-management-grid {
    grid-template-columns: 1fr;
  }
}
</style>
