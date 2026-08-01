<script setup lang="ts">
withDefaults(defineProps<{
  busyKey?: string;
  exportDisabled?: boolean;
}>(), {
  busyKey: "",
  exportDisabled: false,
});

const emit = defineEmits<{
  preview: [];
  evaluate: [];
  export: [];
}>();

const task = defineModel<string>("task", { required: true });
const requiredEvidence = defineModel<string>("requiredEvidence", { required: true });
</script>

<template>
  <div class="preview-task-form">
    <label>
      <span>预览任务</span>
      <textarea v-model="task" rows="3" spellcheck="false" placeholder="输入你想在此上下文中进行的操作或预览提示..."></textarea>
    </label>
    <label>
      <span>必须保留的 evidenceId</span>
      <input v-model="requiredEvidence" placeholder="多个用逗号分隔，例如 evidence::abc123" autocomplete="off" />
    </label>
  </div>
  <div class="context-action-bar">
    <button
      class="tool-button primary-action"
      type="button"
      :disabled="busyKey === 'context:preview'"
      @click="emit('preview')"
    >
      {{ busyKey === "context:preview" ? "预览中" : "预览 ContextPack" }}
    </button>
    <button
      class="tool-button tool-button-ghost"
      type="button"
      :disabled="busyKey === 'context:evaluation'"
      @click="emit('evaluate')"
    >
      {{ busyKey === "context:evaluation" ? "评估中" : "运行 Replay 评估" }}
    </button>
    <button
      class="tool-button tool-button-ghost"
      type="button"
      :disabled="exportDisabled"
      @click="emit('export')"
    >
      导出记录
    </button>
  </div>
</template>

<style scoped>
.preview-task-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  margin-top: 1.5rem;
  background: var(--el-bg-color-overlay);
  padding: 1.5rem;
  border-radius: 8px;
  border: 1px solid var(--el-border-color-light);
}

.preview-task-form label {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preview-task-form label span {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.preview-task-form input,
.preview-task-form textarea {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
  font-size: 0.875rem;
  font-family: inherit;
  transition: border-color 0.2s cubic-bezier(0.645, 0.045, 0.355, 1);
}

.preview-task-form input:focus,
.preview-task-form textarea:focus {
  outline: none;
  border-color: var(--el-color-primary);
}

.preview-task-form textarea {
  resize: vertical;
  min-height: 80px;
}

/* Unified Action Bar */
.context-action-bar {
  display: flex;
  gap: 1rem;
  align-items: center;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  padding: 1rem;
  border-radius: 8px;
  margin-top: 1.5rem;
  margin-bottom: 1.5rem;
}

.context-action-bar .tool-button {
  flex: 1;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.context-action-bar .primary-action {
  background: var(--el-color-primary);
  color: var(--el-color-white);
  border: none;
}

.context-action-bar .primary-action:not(:disabled):hover {
  background: var(--el-color-primary-light-3);
}

@media (max-width: 720px) {
  .context-action-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
