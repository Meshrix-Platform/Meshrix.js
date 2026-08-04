<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import StatusPill from "@meshrix/ui-console/status-pill";

import { currentConsoleLocale, localizeConsoleText } from "../i18n/console";

const localizeStatusPillLabel = (value: any) : any =>
  localizeConsoleText(String(value ?? ""), currentConsoleLocale.value);

const props = withDefaults(defineProps<{
  ariaLabel?: string;
  closeLabel?: string;
  open: boolean;
  showVerify?: boolean;
  statusLabel?: string;
  statusTone?: string;
  subtitle?: string;
  title: string;
  verifying?: boolean;
  verifyingLabel?: string;
  verifyLabel?: string;
  width?: string;
}>(), {
  ariaLabel: "",
  closeLabel: "关闭配置",
  showVerify: true,
  statusLabel: "",
  statusTone: "neutral",
  subtitle: "",
  verifying: false,
  verifyingLabel: "校验中",
  verifyLabel: "校验配置",
  width: "1040px",
});

const emit = defineEmits<{
  close: [];
  verify: [];
}>();

const panelRef = ref<HTMLElement | null>(null);
const panelStyle = computed(() => ({
  "--config-floating-panel-width": props.width,
}));

const accessibleLabel = computed(() => props.ariaLabel || props.title);

function handleDocumentKeydown(event: KeyboardEvent) {
  if (props.open && event.key === "Escape") {
    emit("close");
  }
}

function removeDocumentListeners() {
  document.removeEventListener("keydown", handleDocumentKeydown);
}

watch(() => props.open, (open: any) => {
  removeDocumentListeners();
  if (!open) return;
  document.addEventListener("keydown", handleDocumentKeydown);
  void nextTick(() => {
    panelRef.value?.focus({ preventScroll: true });
  });
}, { immediate: true });

onBeforeUnmount(removeDocumentListeners);
</script>

<template>
  <Teleport to="body">
    <Transition name="config-panel">
      <div
        v-if="open"
        class="config-floating-panel-backdrop"
        @click.self="emit('close')"
      >
        <article
          ref="panelRef"
          class="config-floating-panel"
          role="dialog"
          aria-modal="true"
          :aria-label="accessibleLabel"
          tabindex="-1"
          :style="panelStyle"
        >
          <header class="config-floating-panel-header">
            <div class="config-floating-panel-title">
              <h3>{{ title }}</h3>
              <p v-if="subtitle">{{ subtitle }}</p>
            </div>
            <div class="config-floating-panel-toolbar">
              <StatusPill
                v-if="statusLabel"
                :tone="statusTone"
                :label="localizeStatusPillLabel(statusLabel)"
              />
              <button
                v-if="showVerify"
                class="tool-button tool-button-ghost"
                type="button"
                :disabled="verifying"
                @click="emit('verify')"
              >
                {{ verifying ? verifyingLabel : verifyLabel }}
              </button>
              <slot name="toolbar" />
              <button
                class="dialog-close-button config-floating-panel-close"
                type="button"
                :aria-label="closeLabel"
                title="关闭"
                @click="emit('close')"
              >
                ×
              </button>
            </div>
          </header>

          <div class="config-floating-panel-scroll">
            <slot />
          </div>
        </article>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.config-floating-panel-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: var(--space-6);
  background: rgb(17 24 39 / 46%);
}

.config-floating-panel {
  width: min(var(--config-floating-panel-width), calc(100vw - 48px));
  max-height: min(860px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-xl);
}

.config-floating-panel-header {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  align-items: flex-start;
  padding: var(--space-4);
  padding-right: 64px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.config-floating-panel-title {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.config-floating-panel-title h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-2xl);
  line-height: 1.25;
}

.config-floating-panel-title p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-base);
  line-height: 1.5;
}

.config-floating-panel-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.config-floating-panel-close {
  top: var(--space-3);
  right: var(--space-3);
  border-radius: var(--radius-md);
}

.config-floating-panel-scroll {
  min-height: 0;
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
  overflow-y: auto;
  background: var(--bg-surface);
}

.config-panel-enter-active,
.config-panel-leave-active {
  transition: opacity var(--dur-base) var(--ease-std);
}

.config-panel-enter-active .config-floating-panel,
.config-panel-leave-active .config-floating-panel {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.config-panel-enter-from,
.config-panel-leave-to {
  opacity: 0;
}

.config-panel-enter-from .config-floating-panel,
.config-panel-leave-to .config-floating-panel {
  opacity: 0;
  transform: translateY(10px) scale(0.99);
}

@media (prefers-reduced-motion: reduce) {
  .config-panel-enter-active,
  .config-panel-leave-active,
  .config-panel-enter-active .config-floating-panel,
  .config-panel-leave-active .config-floating-panel {
    transition: none;
  }
}

@media (max-width: 1080px) {
  .config-floating-panel {
    width: min(920px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
  }

  .config-floating-panel-header {
    grid-template-columns: 1fr;
  }

  .config-floating-panel-toolbar {
    justify-content: flex-start;
    padding-right: 44px;
  }
}

@media (max-width: 760px) {
  .config-floating-panel-backdrop {
    padding: 0;
  }

  .config-floating-panel {
    width: 100vw;
    max-height: 100vh;
    border-radius: 0;
  }

  .config-floating-panel-header,
  .config-floating-panel-scroll {
    padding: var(--space-3);
  }
}
</style>
