<script setup lang="ts">
withDefaults(defineProps<{
  previewBusy?: boolean;
  evaluationBusy?: boolean;
  exportDisabled?: boolean;
}>(), {
  previewBusy: false,
  evaluationBusy: false,
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
      :disabled="previewBusy"
      @click="emit('preview')"
    >
      {{ previewBusy ? "预览中" : "预览 ContextPack" }}
    </button>
    <button
      class="tool-button tool-button-ghost"
      type="button"
      :disabled="evaluationBusy"
      @click="emit('evaluate')"
    >
      {{ evaluationBusy ? "评估中" : "运行 Replay 评估" }}
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
  background: var(--bg-subtle);
  padding: 1.5rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

.preview-task-form label {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preview-task-form label span {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.preview-task-form input,
.preview-task-form textarea {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 0.875rem;
  font-family: inherit;
  transition: border-color 0.2s cubic-bezier(0.645, 0.045, 0.355, 1);
}

.preview-task-form input:focus,
.preview-task-form textarea:focus {
  outline: none;
  border-color: var(--brand);
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
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  padding: 1rem;
  border-radius: var(--radius-md);
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
  background: var(--brand);
  color: var(--text-on-brand);
  border: none;
}

.context-action-bar .primary-action:not(:disabled):hover {
  background: var(--brand-strong);
}

@media (max-width: 720px) {
  .context-action-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
