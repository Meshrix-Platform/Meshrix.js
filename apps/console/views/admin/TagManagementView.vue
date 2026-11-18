<script setup lang="ts">
import { computed } from "vue";
import OptionBar from "@meshrix/ui-console/option-bar";
import ConsoleInlineAlert from "../../components/ConsoleInlineAlert.vue";
import {
  tagManagementArchiveOptions,
  tagManagementKindOptions,
  tagManagementStatusOptions,
  useTagManagementConsole,
} from "../../composables/console-tag-management-controller";
import TagAuditList from "./tag-management/TagAuditList.vue";
import TagEditorForm from "./tag-management/TagEditorForm.vue";
import TagProjectionCard from "./tag-management/TagProjectionCard.vue";
import TagTreePanel from "./tag-management/TagTreePanel.vue";
import {
  tagManagementKindName,
  tagManagementText,
} from "../../i18n/tag-management";

const {
  archiveSelectedTag,
  auditItems,
  editor,
  error,
  includeArchived,
  kindFilter,
  parentTagOptions,
  projections,
  rebuildProjections,
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

const localizedKindOptions = computed(() => tagManagementKindOptions.map((option?: any) : any => ({
  ...option,
  label: option.value ? tagManagementKindName(option.value) : tagManagementText("全部类型", "All Types"),
})));
const localizedStatusOptions = computed(() => tagManagementStatusOptions.map((option?: any) : any => ({
  ...option,
  label: option.value === "active"
    ? tagManagementText("启用", "Active")
    : option.value === "archived"
      ? tagManagementText("归档", "Archived")
      : tagManagementText("全部状态", "All Statuses"),
})));
const localizedArchiveOptions = computed(() => tagManagementArchiveOptions.map((option?: any) : any => ({
  ...option,
  label: option.value
    ? tagManagementText("包含归档标签", "Include Archived Tags")
    : tagManagementText("仅显示当前标签", "Current Tags Only"),
})));
</script>

<template>
  <section class="tag-management-layout">
    <section class="surface-card tag-management-control-panel">
      <div class="section-header">
        <div>
          <h3>{{ tagManagementText("标签管理", "Tag Management") }}</h3>
          <p>{{ tagManagementText("维护标签与角色的定义、层级、投影与审计。", "Manage tag and role definitions, hierarchy, projections, and audit history.") }}</p>
        </div>
        <div class="section-tags">
          <span>{{ tagManagementText("全部", "Total") }} {{ tagStats.total }}</span>
          <span>{{ tagManagementText("启用", "Active") }} {{ tagStats.active }}</span>
          <span>{{ tagManagementText("归档", "Archived") }} {{ tagStats.archived }}</span>
          <span>{{ tagManagementText("投影", "Projections") }} {{ tagStats.projections }}</span>
          <span>{{ tagManagementText("审计", "Audit") }} {{ tagStats.audit }}</span>
        </div>
      </div>
      <div class="filter-control-grid tag-management-filters">
        <OptionBar v-model="kindFilter" :label="tagManagementText('类型', 'Type')" :options="localizedKindOptions" />
        <OptionBar v-model="statusFilter" :label="tagManagementText('状态', 'Status')" :options="localizedStatusOptions" />
        <OptionBar v-model="includeArchived" :label="tagManagementText('显示范围', 'Visibility')" :options="localizedArchiveOptions" />
      </div>
      <div class="source-actions tag-management-actions">
        <button class="table-action" type="button" :disabled="saving" @click="rebuildProjections">
          {{ tagManagementText("重建投影", "Rebuild Projections") }}
        </button>
        <button class="tool-button" type="button" @click="startNewTag">{{ tagManagementText("新建标签", "New Tag") }}</button>
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

.tag-management-actions {
  justify-content: flex-end;
  margin-top: var(--space-3);
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
  .tag-management-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .tag-management-grid {
    grid-template-columns: 1fr;
  }
}
</style>
