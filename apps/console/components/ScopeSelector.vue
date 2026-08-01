<script setup lang="ts">
import { computed } from 'vue';
import type { OperationPermissionScope } from '../lib/types';

const props = defineProps<{
  modelValue: string[];
  scopes: OperationPermissionScope[];
  disabled?: boolean;
  compact?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void;
}>();

const groups = computed(() => {
  const result: Record<string, OperationPermissionScope[]> = {};
  for (const scope of props.scopes) {
    const category = scope.id.split(':')[0] || '其它';
    if (!result[category]) {
      result[category] = [];
    }
    result[category].push(scope);
  }
  // Sort keys alphabetically
  return Object.keys(result)
    .sort()
    .reduce((obj: any, key: any) => {
      obj[key] = result[key];
      return obj;
    }, {} as Record<string, OperationPermissionScope[]>);
});

const categoryLabels: Record<string, string> = {
  agent: '智能体 (Agent)',
  context: '上下文 (Context)',
  gateway: '服务网关 (Gateway)',
  storage: '存储 (Storage)',
  tool: '工具 (Tool)',
  workspace: '工作空间 (Workspace)',
  system: '系统 (System)',
  jobs: '任务 (Jobs)',
};

const getCategoryLabel = (key: string) => categoryLabels[key] || key.charAt(0).toUpperCase() + key.slice(1);

const isCategoryAllSelected = (categoryScopes: OperationPermissionScope[]) => {
  return categoryScopes.every((scope: any) => props.modelValue.includes(scope.id));
};

const toggleCategory = (categoryScopes: OperationPermissionScope[]) => {
  if (props.disabled) return;
  const allSelected = isCategoryAllSelected(categoryScopes);
  const ids = categoryScopes.map((s: any) => s.id);

  let newValue = [...props.modelValue];
  if (allSelected) {
    // Remove all
    newValue = newValue.filter((id: any) => !ids.includes(id));
  } else {
    // Add all missing
    for (const id of ids) {
      if (!newValue.includes(id)) {
        newValue.push(id);
      }
    }
  }
  emit('update:modelValue', newValue);
};

const toggleScope = (scopeId: string) => {
  if (props.disabled) return;
  let newValue = [...props.modelValue];
  if (newValue.includes(scopeId)) {
    newValue = newValue.filter((id: any) => id !== scopeId);
  } else {
    newValue.push(scopeId);
  }
  emit('update:modelValue', newValue);
};
</script>

<template>
  <div class="scope-selector">
    <section
      v-for="(categoryScopes, category) in groups"
      :key="category"
      class="scope-group"
    >
      <div class="scope-group-header">
        <span class="scope-group-title">{{ getCategoryLabel(String(category)) }}</span>
        <button
          class="scope-group-toggle"
          type="button"
          :disabled="disabled"
          @click="toggleCategory(categoryScopes)"
        >
          {{ isCategoryAllSelected(categoryScopes) ? '取消全选' : '一键全选' }}
        </button>
      </div>

      <div class="scope-grid" :class="{ 'compact-scope-grid': compact }">
        <button
          v-for="scope in categoryScopes"
          :key="scope.id"
          class="scope-chip"
          :class="{ active: modelValue.includes(scope.id) }"
          type="button"
          :disabled="disabled"
          @click="toggleScope(scope.id)"
        >
          <strong>{{ scope.label }}</strong>
          <span v-if="!compact">{{ scope.description }}</span>
          <span v-else>{{ scope.id }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.scope-selector {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.scope-group {
  display: grid;
  gap: var(--space-2-5);
}

.scope-group + .scope-group {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-soft);
}

.scope-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.scope-group-title {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--text-primary);
}

.scope-group-toggle {
  min-height: 26px;
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-std),
    border-color var(--dur-fast) var(--ease-std),
    color var(--dur-fast) var(--ease-std);
}

.scope-group-toggle:hover {
  background: var(--bg-subtle);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.scope-group-toggle:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
</style>
