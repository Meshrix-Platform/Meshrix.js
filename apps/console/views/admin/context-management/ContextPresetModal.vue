<script setup lang="ts">
import type { ContextProfileForm } from "../../../composables/console-context-compiler-controller";

withDefaults(defineProps<{
  form: ContextProfileForm;
  formError?: string;
  saving?: boolean;
  title?: string;
}>(), {
  formError: "",
  saving: false,
  title: "",
});

const emit = defineEmits<{
  close: [];
  save: [];
}>();
</script>

<template>
  <div class="lico-modal-overlay" @click.self="emit('close')">
    <form class="lico-modal" @submit.prevent="emit('save')">
      <header class="lico-modal-header">
        <h3>{{ title }}</h3>
      </header>
      <div class="lico-modal-body form-grid">
        <label class="full-row">
          <span>配置标识 (Profile ID)</span>
          <input v-model="form.profileId" placeholder="例如: context-256k" />
        </label>
        <label class="full-row">
          <span>配置名称 (Label)</span>
          <input v-model="form.label" placeholder="例如: 256K Context" />
        </label>
        <label>
          <span>窗口总量</span>
          <input type="number" min="4096" step="1024" v-model.number="form.contextWindowTokens" />
        </label>
        <label>
          <span>参考分配</span>
          <input type="number" min="0" step="1024" v-model.number="form.referenceBudget" />
        </label>
        <label>
          <span>历史分配</span>
          <input type="number" min="0" step="1024" v-model.number="form.historyBudget" />
        </label>
        <label>
          <span>最近轮次</span>
          <input type="number" min="0" step="1024" v-model.number="form.recentTurnBudget" />
        </label>
        <label>
          <span>人工介入权重 (0-1)</span>
          <input type="number" min="0" max="1" step="0.01" v-model.number="form.operatorGuidanceRatio" />
        </label>
        <p v-if="formError" class="preset-form-error full-row">{{ formError }}</p>
      </div>
      <footer class="lico-modal-footer">
        <button class="tool-button tool-button-ghost" type="button" :disabled="saving" @click="emit('close')">取消</button>
        <button class="tool-button" type="submit" :disabled="saving || !form.profileId.trim()">
          {{ saving ? "保存中" : "保存配置" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
/* Modal Styles */
.lico-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
  animation: fade-in 0.2s ease-out;
}

.lico-modal {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  width: 440px;
  max-width: 90vw;
  box-shadow: 0 10px 30px rgba(0,0,0,0.2);
  animation: slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  flex-direction: column;
}

.lico-modal-header {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.lico-modal-header h3 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--el-text-color-primary);
  letter-spacing: 0;
}

.lico-modal-body {
  padding: 1.5rem;
  overflow-y: auto;
  max-height: 70vh;
}

.lico-modal-body label {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.lico-modal-body label span {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.lico-modal-body input {
  width: 100%;
  height: 40px;
  padding: 0 0.75rem;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-primary);
  font-size: 0.875rem;
  transition: border-color 0.2s cubic-bezier(0.645, 0.045, 0.355, 1);
}

.lico-modal-body input:focus {
  outline: none;
  border-color: var(--el-color-primary);
}

.lico-modal-body input::placeholder {
  color: var(--el-text-color-placeholder);
}

.preset-form-error {
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--danger-border);
  border-radius: 6px;
  background: var(--danger-surface);
  color: var(--danger);
  font-size: 0.875rem;
}

.lico-modal-footer {
  padding: 1.25rem 1.5rem;
  border-top: 1px solid var(--el-border-color-lighter);
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  background: var(--el-bg-color-page);
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(16px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 720px) {
  .lico-modal-footer {
    justify-content: flex-start;
  }
}
</style>
