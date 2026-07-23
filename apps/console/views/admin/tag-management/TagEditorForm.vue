<script setup lang="ts">
import BinaryCheckbox from "@lico/ui-console/binary-checkbox";
import type { TagManagementTag } from "../../../lib/tag-management-client";

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

withDefaults(defineProps<{
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
</script>

<template>
  <section class="surface-card tag-editor-card">
    <div class="section-header">
      <div>
        <h3>{{ selectedTag ? selectedTag.label : "新建 Tag" }}</h3>
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
          恢复
        </button>
        <button
          v-else-if="selectedTag"
          class="table-action danger-link"
          type="button"
          :disabled="saving || selectedTag.system"
          @click="emit('archive')"
        >
          归档
        </button>
        <button class="tool-button" type="button" :disabled="saving" @click="emit('save')">
          {{ saving ? "保存中" : "保存" }}
        </button>
      </div>
    </div>

    <div class="tag-editor-grid">
      <label>
        <span>tagId</span>
        <input v-model="editor.tagId" type="text" placeholder="custom:example" />
      </label>
      <label>
        <span>kind</span>
        <select v-model="editor.kind">
          <option value="role">role</option>
          <option value="group">group</option>
          <option value="organization">organization</option>
          <option value="character">character</option>
          <option value="custom">custom</option>
        </select>
      </label>
      <label>
        <span>label</span>
        <input v-model="editor.label" type="text" />
      </label>
      <label>
        <span>parentTagId</span>
        <select v-model="editor.parentTagId">
          <option value="">无父级</option>
          <option v-for="option in parentTagOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="tag-editor-wide">
        <span>description</span>
        <input v-model="editor.description" type="text" />
      </label>
      <BinaryCheckbox v-model="editor.enabled" label="enabled" />
      <label class="tag-editor-wide">
        <span>scopePrerequisites</span>
        <textarea v-model="editor.scopePrerequisitesText" rows="3" spellcheck="false" />
      </label>
      <label class="tag-editor-wide">
        <span>metadata</span>
        <textarea v-model="editor.metadataText" rows="8" spellcheck="false" />
      </label>
    </div>

    <dl v-if="selectedTag" class="tag-detail-meta">
      <div>
        <dt>system</dt>
        <dd><span class="tag-state">{{ selectedTag.system ? "system" : "custom" }}</span></dd>
      </div>
      <div>
        <dt>status</dt>
        <dd><span class="tag-state" :class="{ archived: selectedTag.status === 'archived' }">{{ selectedTag.status }}</span></dd>
      </div>
      <div>
        <dt>createdAt</dt>
        <dd>{{ selectedTag.createdAt }}</dd>
      </div>
      <div>
        <dt>updatedAt</dt>
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
