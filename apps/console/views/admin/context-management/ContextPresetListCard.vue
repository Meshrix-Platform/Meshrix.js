<script setup lang="ts">
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";

export interface ContextPresetProfileRow {
  profileId: string;
  label: string;
  contextWindowTokens: number | null;
  compressionMode: string;
  strategy: string;
  referenceBudget: number | null;
  historyBudget: number | null;
  recentTurnBudget: number | null;
  operatorGuidanceRatio: number | null;
  protectedEvidenceFields: string[];
  modelCompressionAlias: string;
  modelCompressionConfigured: boolean;
  modelCompressionEnabled: boolean;
}

withDefaults(defineProps<{
  profiles?: ContextPresetProfileRow[];
  saving?: boolean;
}>(), {
  profiles: () => [],
  saving: false,
});

const emit = defineEmits<{
  add: [];
  edit: [profile: ContextPresetProfileRow];
  delete: [profile: ContextPresetProfileRow];
}>();
</script>

<template>
  <div class="section-header">
    <div>
      <h3>上下文编译器</h3>
    </div>
    <div class="section-actions">
      <button
        class="tool-button"
        type="button"
        @click="emit('add')"
      >
        新增预设
      </button>
    </div>
  </div>

  <div class="context-profile-list">
    <article
      v-for="profile in profiles"
      :key="profile.profileId"
      class="context-profile-item"
    >
      <header class="context-profile-item-header">
        <div class="profile-heading">
          <h4 class="profile-title">{{ profile.label || profile.profileId }}</h4>
          <div v-if="profile.compressionMode || profile.strategy" class="profile-modes">
            <span v-if="profile.compressionMode" class="profile-mode">
              压缩 {{ profile.compressionMode }}
            </span>
            <span v-if="profile.strategy" class="profile-mode">
              策略 {{ profile.strategy }}
            </span>
          </div>
        </div>
        <div class="profile-actions">
          <button
            class="table-action"
            type="button"
            @click="emit('edit', profile)"
          >
            编辑
          </button>
          <button
            class="table-action danger-action"
            type="button"
            :disabled="saving"
            @click="emit('delete', profile)"
          >
            删除
          </button>
        </div>
      </header>
      <div class="profile-budgets">
        <div class="budget-item">
          <span class="budget-label">窗口总量</span>
          <span class="budget-value">{{ profile.contextWindowTokens?.toLocaleString() || "—" }}</span>
        </div>
        <div class="budget-item">
          <span class="budget-label">参考分配</span>
          <span class="budget-value">{{ profile.referenceBudget?.toLocaleString() || "—" }}</span>
        </div>
        <div class="budget-item">
          <span class="budget-label">历史分配</span>
          <span class="budget-value">{{ profile.historyBudget?.toLocaleString() || "—" }}</span>
        </div>
        <div class="budget-item">
          <span class="budget-label">人工介入</span>
          <span class="budget-value">
            {{ profile.operatorGuidanceRatio === null ? "—" : `${Math.round(profile.operatorGuidanceRatio * 100)}%` }}
          </span>
        </div>
      </div>
      <footer class="profile-meta">
        <span class="meta-badge" v-if="profile.protectedEvidenceFields && profile.protectedEvidenceFields.length">
          保护: {{ profile.protectedEvidenceFields.slice(0, 4).join(", ") }}
        </span>
        <span v-if="profile.modelCompressionConfigured" class="meta-badge">
          模型压缩: {{ profile.modelCompressionEnabled ? (profile.modelCompressionAlias || "开启") : "关闭" }}
        </span>
      </footer>
    </article>
    <ConsoleEmptyState
      v-if="!profiles.length"
      title="暂无上下文配置"
      description="新增一个预设即可开始配置上下文编译器。"
    >
      <template #action>
        <button class="tool-button" type="button" @click="emit('add')">
          新增预设
        </button>
      </template>
    </ConsoleEmptyState>
  </div>
</template>

<style scoped>
.context-profile-list {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  margin: 1.5rem 0;
}

.context-profile-item {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.5rem;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  transition: border-color 0.2s ease;
}

.context-profile-item:hover {
  border-color: var(--el-border-color);
}

.context-profile-item-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 0.75rem;
}

.profile-heading {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}

.profile-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--el-text-color-primary);
  letter-spacing: 0;
}

.profile-mode {
  font-size: 0.875rem;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.profile-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}

.profile-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: flex-end;
}

.profile-budgets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
}

.budget-item {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.budget-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--el-text-color-secondary);
}

.budget-value {
  font-size: 1.125rem;
  font-weight: 500;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.profile-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 0.5rem;
}

.meta-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.375rem 0.625rem;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--el-text-color-regular);
}



@media (max-width: 720px) {
  .context-profile-item-header {
    flex-direction: column;
    align-items: stretch;
  }

  .profile-actions {
    justify-content: flex-start;
  }
}
</style>
