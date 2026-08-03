<script setup lang="ts">
import type { TagManagementProjection } from "../../../lib/tag-management-client";
import { tagManagementText } from "../../../i18n/tag-management";

withDefaults(defineProps<{
  selectedProjection?: TagManagementProjection | null;
  projections?: TagManagementProjection[];
  selectedProjectionPayload?: string;
}>(), {
  selectedProjection: null,
  projections: () => [],
  selectedProjectionPayload: "",
});
</script>

<template>
  <section class="surface-card tag-projection-card">
    <div class="section-header">
      <div>
        <h3>{{ tagManagementText("投影详情", "Projection Details") }}</h3>
        <p>{{ selectedProjection?.entityType || tagManagementText("无投影", "No Projection") }}</p>
      </div>
      <span>{{ projections.length }}</span>
    </div>
    <dl v-if="selectedProjection" class="tag-detail-meta compact">
      <div>
        <dt>{{ tagManagementText("对象类型", "Entity Type") }}</dt>
        <dd>{{ selectedProjection.entityType }}</dd>
      </div>
      <div>
        <dt>{{ tagManagementText("对象标识", "Entity ID") }}</dt>
        <dd>{{ selectedProjection.entityId }}</dd>
      </div>
      <div>
        <dt>{{ tagManagementText("更新时间", "Updated At") }}</dt>
        <dd>{{ selectedProjection.updatedAt }}</dd>
      </div>
    </dl>
    <pre>{{ selectedProjectionPayload }}</pre>
  </section>
</template>

<style scoped>
.tag-projection-card {
  min-width: 0;
}

.tag-detail-meta {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin: var(--space-4) 0 0;
}

.tag-detail-meta.compact {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: var(--space-3);
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

.tag-projection-card pre {
  max-height: 360px;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
}

@media (max-width: 900px) {
  .tag-detail-meta,
  .tag-detail-meta.compact {
    grid-template-columns: 1fr;
  }
}
</style>
