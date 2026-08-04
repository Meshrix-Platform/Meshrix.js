<script setup lang="ts">
import {
  dismissConsoleToast,
  pushConsoleToast,
  useConsoleToasts,
  type ConsoleToast,
  type ConsoleToastTone,
} from "../composables/console-toast-controller";
import { consoleMessages, currentConsoleLocale } from "../i18n/console";

const { toasts } = useConsoleToasts();

const TONE_LABELS: Record<string, string> = {
  info: "提示",
  success: "成功",
  danger: "错误",
};

function toastRole(tone: ConsoleToastTone) {
  return tone === "danger" ? "alert" : "status";
}

// Invokes the toast action and dismisses the toast on success; a throwing
// action keeps its toast open and surfaces the failure as a danger toast
// instead of throwing through the renderer.
function runToastAction(toast: ConsoleToast) {
  if (!toast.action) {
    return;
  }
  try {
    toast.action.run();
  } catch (nextError: unknown) {
    pushConsoleToast({
      tone: "danger",
      title: consoleMessages[currentConsoleLocale.value].toast.actionFailed,
      message: nextError instanceof Error ? nextError.message : String(nextError ?? ""),
    });
    return;
  }
  dismissConsoleToast(toast.id);
}
</script>

<template>
  <Teleport to="body">
    <TransitionGroup name="console-toast" tag="div" class="console-toast-viewport">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="console-toast"
        :class="`tone-${toast.tone}`"
        :role="toastRole(toast.tone)"
      >
        <span class="console-toast-dot" aria-hidden="true" />
        <span class="console-toast-body">
          <strong v-if="toast.title" class="console-toast-title">{{ toast.title }}</strong>
          <span class="console-toast-message">{{ toast.message }}</span>
        </span>
        <button
          v-if="toast.action"
          class="console-toast-action"
          type="button"
          @click="runToastAction(toast)"
        >
          {{ toast.action.label }}
        </button>
        <button
          class="console-toast-close"
          type="button"
          :aria-label="`关闭${TONE_LABELS[toast.tone]}通知`"
          @click="dismissConsoleToast(toast.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.console-toast-viewport {
  position: fixed;
  top: calc(var(--topbar-height) + var(--space-3));
  right: var(--space-4);
  z-index: var(--z-toast);
  display: grid;
  gap: var(--space-2);
  width: min(360px, calc(100vw - 2 * var(--space-4)));
  pointer-events: none;
}

.console-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  padding: var(--space-3) var(--space-3-5);
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--info);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}

.console-toast.tone-success { border-left-color: var(--success); }
.console-toast.tone-danger { border-left-color: var(--danger); }

.console-toast-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: var(--space-1-5);
  border-radius: var(--radius-full);
  background: var(--info);
}

.console-toast.tone-success .console-toast-dot { background: var(--success); }
.console-toast.tone-danger .console-toast-dot { background: var(--danger); }

.console-toast-body {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: var(--space-0-5);
}

.console-toast-title {
  color: var(--text-primary);
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  line-height: var(--leading-snug);
}

.console-toast-message {
  color: var(--text-secondary);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  white-space: pre-line;
  word-break: break-word;
}

.console-toast-action {
  flex: none;
  align-self: center;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--brand);
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  line-height: var(--leading-snug);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-std),
    color var(--dur-fast) var(--ease-std);
}

.console-toast-action:hover {
  background: var(--bg-subtle);
}

.console-toast-action:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

.console-toast-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: calc(-1 * var(--space-0-5)) calc(-1 * var(--space-1)) 0 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-2xl);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-std),
    color var(--dur-fast) var(--ease-std);
}

.console-toast-close:hover {
  background: var(--bg-subtle);
  color: var(--text-primary);
}

.console-toast-close:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

.console-toast-enter-active,
.console-toast-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.console-toast-enter-from {
  opacity: 0;
  transform: translateX(16px);
}

.console-toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}

.console-toast-leave-active {
  position: absolute;
  right: 0;
  width: 100%;
}

.console-toast-move {
  transition: transform var(--dur-base) var(--ease-std);
}

@media (prefers-reduced-motion: reduce) {
  .console-toast-enter-active,
  .console-toast-leave-active,
  .console-toast-move {
    transition: none;
  }
}
</style>
