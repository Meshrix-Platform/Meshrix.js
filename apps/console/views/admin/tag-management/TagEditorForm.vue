<script setup lang="ts">
import { computed } from "vue";
import FeatureToggle from "../../../components/FeatureToggle.vue";
import type { TagManagementTag } from "../../../lib/tag-management-client";
import {
  isEnterpriseTemplateTag,
  tagManagementKindName,
  tagManagementTagName,
  tagManagementText,
} from "../../../i18n/tag-management";

type TagEditor = {
  tagId: string;
  kind: string;
  label: string;
  description: string;
  parentTagId: string;
  enabled: boolean;
  scopePrerequisitesText: string;
  metadataText: string;
};

const props = withDefaults(defineProps<{
  selectedTag?: TagManagementTag | null;
  saving?: boolean;
  editor?: TagEditor;
  parentTagOptions?: { value: string; label: string }[];
}>(), {
  selectedTag: null,
  saving: false,
  editor: () => ({
    tagId: "",
    kind: "custom",
    label: "",
    description: "",
    parentTagId: "",
    enabled: true,
    scopePrerequisitesText: "",
    metadataText: "{}",
  }),
  parentTagOptions: () => [],
});

const emit = defineEmits<{
  save: [];
  archive: [];
  restore: [];
}>();

const templateManaged = computed(() => Boolean(
  props.selectedTag && (
    props.selectedTag.metadata?.organizationTemplate || isEnterpriseTemplateTag(props.selectedTag.tagId)
  ),
));
const displayedLabel = computed(() => props.selectedTag
  ? tagManagementTagName(props.selectedTag.tagId, props.selectedTag.label)
  : props.editor.label);
</script>

<template>
  <section class="surface-card tag-editor-card">
    <div class="section-header">
      <div>
        <h3>{{ selectedTag ? tagManagementTagName(selectedTag.tagId, selectedTag.label) : tagManagementText("新建标签", "New Tag") }}</h3>
        <p>{{ selectedTag?.tagId || "custom:*" }}</p>
      </div>
      <div class="tag-management-actions">
        <button
          v-if="selectedTag && selectedTag.status === 'archived'"
          class="table-action"
          type="button"
          :disabled="saving"
          @click="emit('restore')"
        >
          {{ tagManagementText("恢复", "Restore") }}
        </button>
        <button
          v-else-if="selectedTag"
          class="table-action danger-link"
          type="button"
          :disabled="saving || selectedTag.system"
          @click="emit('archive')"
        >
          {{ tagManagementText("归档", "Archive") }}
        </button>
        <button class="tool-button" type="button" :disabled="saving" @click="emit('save')">
          {{ saving ? tagManagementText("保存中", "Saving") : tagManagementText("保存", "Save") }}
        </button>
      </div>
    </div>

    <div class="tag-editor-grid">
      <label>
        <span>{{ tagManagementText("标签标识", "Tag ID") }}</span>
        <input v-model="editor.tagId" type="text" placeholder="custom:example" />
      </label>
      <label>
        <span>{{ tagManagementText("类型", "Type") }}</span>
        <select v-model="editor.kind">
          <option value="role">{{ tagManagementKindName("role") }}</option>
          <option value="group">{{ tagManagementKindName("group") }}</option>
          <option value="organization">{{ tagManagementKindName("organization") }}</option>
          <option value="character">{{ tagManagementKindName("character") }}</option>
          <option value="custom">{{ tagManagementKindName("custom") }}</option>
        </select>
      </label>
      <label>
        <span>{{ tagManagementText("名称", "Name") }}</span>
        <input v-if="templateManaged" :value="displayedLabel" type="text" readonly />
        <input v-else v-model="editor.label" type="text" />
        <small v-if="templateManaged" class="tag-editor-field-note">
          {{ tagManagementText("名称由集团模板管理，并随界面语言显示。", "This name is managed by the Group template and follows the interface language.") }}
        </small>
      </label>
      <label>
        <span>{{ tagManagementText("上级标签", "Parent Tag") }}</span>
        <select v-model="editor.parentTagId">
          <option value="">{{ tagManagementText("无上级", "No Parent") }}</option>
          <option v-for="option in parentTagOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="tag-editor-wide">
        <span>{{ tagManagementText("说明", "Description") }}</span>
        <input v-model="editor.description" type="text" />
      </label>
      <FeatureToggle
        v-model="editor.enabled"
        :label="tagManagementText('启用', 'Enabled')"
        :aria-label="editor.enabled ? tagManagementText('停用标签', 'Disable Tag') : tagManagementText('启用标签', 'Enable Tag')"
      />
      <label class="tag-editor-wide">
        <span>{{ tagManagementText("权限前置条件", "Scope Prerequisites") }}</span>
        <textarea v-model="editor.scopePrerequisitesText" rows="3" spellcheck="false" />
      </label>
      <label class="tag-editor-wide">
        <span>{{ tagManagementText("附加信息", "Metadata") }}</span>
        <textarea v-model="editor.metadataText" rows="8" spellcheck="false" />
      </label>
    </div>

    <dl v-if="selectedTag" class="tag-detail-meta">
      <div>
        <dt>{{ tagManagementText("来源", "Source") }}</dt>
        <dd><span class="tag-state">{{ templateManaged ? tagManagementText("集团模板", "Group Template") : selectedTag.system ? tagManagementText("系统", "System") : tagManagementText("自定义", "Custom") }}</span></dd>
      </div>
      <div>
        <dt>{{ tagManagementText("状态", "Status") }}</dt>
        <dd><span class="tag-state" :class="{ archived: selectedTag.status === 'archived' }">{{ selectedTag.status === "archived" ? tagManagementText("归档", "Archived") : tagManagementText("启用", "Active") }}</span></dd>
      </div>
      <div>
        <dt>{{ tagManagementText("创建时间", "Created At") }}</dt>
        <dd>{{ selectedTag.createdAt }}</dd>
      </div>
      <div>
        <dt>{{ tagManagementText("更新时间", "Updated At") }}</dt>
        <dd>{{ selectedTag.updatedAt }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.tag-editor-card {
  min-width: 0;
}

.tag-management-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.tag-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.tag-editor-grid label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.tag-editor-grid span {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tag-editor-field-note {
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.5;
}

.tag-editor-grid select,
.tag-editor-grid input,
.tag-editor-grid textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
}

.tag-editor-grid select,
.tag-editor-grid input {
  min-height: 34px;
  padding: 0 var(--space-2);
}

.tag-editor-grid textarea {
  resize: vertical;
  padding: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
}

.tag-editor-wide {
  grid-column: 1 / -1;
}

.tag-detail-meta {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin: var(--space-4) 0 0;
}

.tag-detail-meta div {
  min-width: 0;
}

.tag-detail-meta dt {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tag-detail-meta dd {
  margin: var(--space-1) 0 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-state {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  background: var(--bg-subtle);
  color: var(--text-muted);
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
}

.tag-state.archived {
  background: #f1f5f9;
  color: #64748b;
}

@media (max-width: 900px) {
  .tag-management-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .tag-editor-grid,
  .tag-detail-meta {
    grid-template-columns: 1fr;
  }
}
</style>
