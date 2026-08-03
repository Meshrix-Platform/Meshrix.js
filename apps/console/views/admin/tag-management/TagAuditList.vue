<script setup lang="ts">
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";
import type { TagManagementAuditItem } from "../../../lib/tag-management-client";
import { tagManagementText } from "../../../i18n/tag-management";

withDefaults(defineProps<{
  auditItems?: TagManagementAuditItem[];
}>(), {
  auditItems: () => [],
});
</script>

<template>
  <section class="surface-card tag-audit-card">
    <div class="section-header">
      <div>
        <h3>{{ tagManagementText("审计记录", "Audit History") }}</h3>
        <p>{{ auditItems.length }} {{ tagManagementText("条事件", "events") }}</p>
      </div>
    </div>
    <div class="tag-audit-list">
      <div v-if="auditItems.length" class="tag-audit-row header">
        <span>{{ tagManagementText("事件", "Event") }}</span>
        <strong>{{ tagManagementText("对象", "Target") }}</strong>
        <small>{{ tagManagementText("时间", "Time") }}</small>
      </div>
      <div v-for="item in auditItems" :key="item.eventId" class="tag-audit-row">
        <span>{{ item.eventType }}</span>
        <strong>{{ item.tagId || item.entityId || item.eventId }}</strong>
        <small>{{ item.createdAt }}</small>
      </div>
      <ConsoleEmptyState v-if="!auditItems.length" compact :title="tagManagementText('暂无审计事件', 'No Audit Events')" />
    </div>
  </section>
</template>

<style scoped>
.tag-audit-card {
  min-width: 0;
}

.tag-audit-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tag-audit-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) 190px;
  gap: var(--space-3);
  align-items: center;
  min-height: 34px;
  border-bottom: 1px solid var(--border-subtle);
}

.tag-audit-row.header {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.tag-audit-row strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-audit-row small {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

@media (max-width: 900px) {
  .tag-audit-row {
    grid-template-columns: 1fr;
  }
}
</style>
