import { computed, onMounted, ref, watch } from "vue";
import {
  archiveTagManagementTag,
  listTagManagementAudit,
  listTagManagementProjections,
  listTagManagementTags,
  rebuildTagManagementProjections,
  restoreTagManagementTag,
  upsertTagManagementTag,
  type TagManagementAuditItem,
  type TagManagementProjection,
  type TagManagementTag,
} from "../lib/tag-management-client";
import { usePageRefreshHandler } from "@lico/ui-console/page-refresh";
import { confirmConsoleAction } from "./console-browser-effects";

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

export type TagManagementTreeRow = {
  tag: TagManagementTag;
  depth: number;
};

export const tagManagementKindOptions = [
  { value: "", label: "全部类型" },
  { value: "role", label: "role" },
  { value: "group", label: "group" },
  { value: "organization", label: "organization" },
  { value: "character", label: "character" },
  { value: "custom", label: "custom" },
];

export const tagManagementStatusOptions = [
  { value: "", label: "全部状态" },
  { value: "active", label: "active" },
  { value: "archived", label: "archived" },
];

function emptyEditor(): TagEditor {
  return {
    tagId: "",
    kind: "custom",
    label: "",
    description: "",
    parentTagId: "",
    enabled: true,
    scopePrerequisitesText: "",
    metadataText: "{}",
  };
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseListText(value: string) {
  return value
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function editorFromTag(tag: TagManagementTag): TagEditor {
  return {
    tagId: tag.tagId,
    kind: tag.kind,
    label: tag.label,
    description: tag.description,
    parentTagId: tag.parentTagId,
    enabled: tag.enabled,
    scopePrerequisitesText: tag.scopePrerequisites.join("\n"),
    metadataText: formatJson(tag.metadata),
  };
}

function sortTags(tags: TagManagementTag[]) {
  return [...tags].sort((a, b) =>
    `${a.kind}:${a.label}:${a.tagId}`.localeCompare(`${b.kind}:${b.label}:${b.tagId}`),
  );
}

function buildTreeRows(tags: TagManagementTag[]): TagManagementTreeRow[] {
  const rows: TagManagementTreeRow[] = [];
  const tagIds = new Set(tags.map((tag) => tag.tagId));
  const childrenByParent = new Map<string, TagManagementTag[]>();
  for (const tag of tags) {
    const parentId = tag.parentTagId && tagIds.has(tag.parentTagId) ? tag.parentTagId : "";
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), tag]);
  }
  for (const [parentId, children] of childrenByParent.entries()) {
    childrenByParent.set(parentId, sortTags(children));
  }

  const visited = new Set<string>();
  function visit(tag: TagManagementTag, depth: number) {
    if (visited.has(tag.tagId)) return;
    visited.add(tag.tagId);
    rows.push({ tag, depth });
    for (const child of childrenByParent.get(tag.tagId) || []) {
      visit(child, depth + 1);
    }
  }

  for (const root of childrenByParent.get("") || []) {
    visit(root, 0);
  }
  for (const tag of sortTags(tags)) {
    visit(tag, 0);
  }
  return rows;
}

export function useTagManagementConsole() {
  const tags = ref<TagManagementTag[]>([]);
  const projections = ref<TagManagementProjection[]>([]);
  const auditItems = ref<TagManagementAuditItem[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref("");
  const status = ref("");
  const kindFilter = ref("");
  const statusFilter = ref("");
  const includeArchived = ref(true);
  const selectedTagId = ref("");
  const editor = ref<TagEditor>(emptyEditor());

  const selectedTag = computed(() => tags.value.find((tag) => tag.tagId === selectedTagId.value) || null);
  const projectionByTagId = computed(() => {
    const map = new Map<string, TagManagementProjection>();
    for (const projection of projections.value) {
      map.set(projection.tagId, projection);
    }
    return map;
  });
  const selectedProjection = computed(() =>
    selectedTag.value ? projectionByTagId.value.get(selectedTag.value.tagId) || null : null,
  );
  const treeRows = computed(() => buildTreeRows(tags.value));
  const tagStats = computed(() => {
    const archived = tags.value.filter((tag) => tag.status === "archived").length;
    return {
      total: tags.value.length,
      active: tags.value.length - archived,
      archived,
      projections: projections.value.length,
      audit: auditItems.value.length,
    };
  });
  const parentTagOptions = computed(() =>
    tags.value
      .filter((tag) => tag.tagId !== editor.value.tagId && tag.status !== "archived")
      .map((tag) => ({ value: tag.tagId, label: `${tag.label} (${tag.tagId})` })),
  );
  const selectedProjectionPayload = computed(() => formatJson(selectedProjection.value?.payload || {}));
  const selectedTagMetadata = computed(() => formatJson(selectedTag.value?.metadata || {}));

  function selectTag(tagId: string) {
    selectedTagId.value = tagId;
    const tag = tags.value.find((item) => item.tagId === tagId);
    if (tag) {
      editor.value = editorFromTag(tag);
    }
    status.value = "";
  }

  function startNewTag() {
    selectedTagId.value = "";
    editor.value = {
      ...emptyEditor(),
      tagId: "custom:",
    };
    status.value = "";
  }

  function syncSelectionAfterLoad(forceEditor = false) {
    const selected = tags.value.find((tag) => tag.tagId === selectedTagId.value);
    if (selected) {
      if (forceEditor) {
        editor.value = editorFromTag(selected);
      }
      return;
    }
    const first = treeRows.value[0]?.tag;
    if (first) {
      selectedTagId.value = first.tagId;
      editor.value = editorFromTag(first);
      return;
    }
    startNewTag();
  }

  async function refreshTagManagement(forceEditor = false) {
    loading.value = true;
    error.value = "";
    try {
      const [tagPayload, projectionPayload, auditPayload] = await Promise.all([
        listTagManagementTags({
          kind: kindFilter.value || undefined,
          status: statusFilter.value || undefined,
          includeArchived: includeArchived.value,
        }),
        listTagManagementProjections({ includeArchived: includeArchived.value }),
        listTagManagementAudit({ limit: 100 }),
      ]);
      tags.value = tagPayload.items || [];
      projections.value = projectionPayload.items || [];
      auditItems.value = auditPayload.items || [];
      syncSelectionAfterLoad(forceEditor);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Tag Management 加载失败。";
    } finally {
      loading.value = false;
    }
  }

  async function saveEditor() {
    saving.value = true;
    error.value = "";
    status.value = "";
    try {
      const metadata = JSON.parse(editor.value.metadataText || "{}") as Record<string, unknown>;
      const tagId = editor.value.tagId.trim();
      const payload = {
        tagId,
        kind: editor.value.kind,
        label: editor.value.label.trim() || tagId,
        description: editor.value.description.trim(),
        parentTagId: editor.value.parentTagId.trim(),
        enabled: editor.value.enabled,
        scopePrerequisites: parseListText(editor.value.scopePrerequisitesText),
        metadata,
      };
      const response = await upsertTagManagementTag(payload);
      selectedTagId.value = response.tag.tagId;
      status.value = "已保存";
      await refreshTagManagement(true);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Tag 保存失败。";
    } finally {
      saving.value = false;
    }
  }

  async function archiveSelectedTag() {
    if (!selectedTag.value || selectedTag.value.system) return;
    const confirmed = await confirmConsoleAction(`确认归档 ${selectedTag.value.tagId}？`, { tone: "danger" });
    if (!confirmed) return;
    saving.value = true;
    error.value = "";
    status.value = "";
    try {
      await archiveTagManagementTag(selectedTag.value.tagId, "console archive");
      status.value = "已归档";
      await refreshTagManagement(true);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Tag 归档失败。";
    } finally {
      saving.value = false;
    }
  }

  async function restoreSelectedTag() {
    if (!selectedTag.value) return;
    saving.value = true;
    error.value = "";
    status.value = "";
    try {
      await restoreTagManagementTag(selectedTag.value.tagId);
      status.value = "已恢复";
      await refreshTagManagement(true);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Tag 恢复失败。";
    } finally {
      saving.value = false;
    }
  }

  async function rebuildProjections() {
    saving.value = true;
    error.value = "";
    status.value = "";
    try {
      const result = await rebuildTagManagementProjections();
      status.value = `投影已重建：${Number(result.count || 0)}`;
      await refreshTagManagement(true);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "投影重建失败。";
    } finally {
      saving.value = false;
    }
  }

  watch([kindFilter, statusFilter, includeArchived], () => {
    void refreshTagManagement(false);
  });

  onMounted(() => {
    void refreshTagManagement(true);
  });

  usePageRefreshHandler(
    (detail) => detail.viewId === "admin" && detail.adminView === "tagManagement",
    () => refreshTagManagement(true),
  );

  return {
    archiveSelectedTag,
    auditItems,
    editor,
    error,
    formatJson,
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
    selectedTagMetadata,
    startNewTag,
    status,
    statusFilter,
    tagStats,
    tags,
    treeRows,
  };
}
