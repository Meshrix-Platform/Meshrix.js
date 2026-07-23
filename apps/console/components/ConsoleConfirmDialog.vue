<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  registerConsoleConfirmHost,
  settleConsoleConfirm,
  unregisterConsoleConfirmHost,
  useConsoleConfirmState,
} from "../composables/console-confirm-controller";

const { currentConfirm } = useConsoleConfirmState();

const dialogRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const confirmButtonRef = ref<HTMLButtonElement | null>(null);
const cancelButtonRef = ref<HTMLButtonElement | null>(null);
const requireTextInput = ref("");
const settlingConfirmId = ref<number | null>(null);
let previouslyFocusedElement: HTMLElement | null = null;

const open = computed(() => Boolean(currentConfirm.value));
const tone = computed(() => (currentConfirm.value?.tone === "danger" ? "danger" : "neutral"));
const title = computed(() => currentConfirm.value?.title?.trim() || "操作确认");
const messageId = "console-confirm-message";
const confirmLabel = computed(() => currentConfirm.value?.confirmLabel?.trim() || "确认");
const cancelLabel = computed(() => currentConfirm.value?.cancelLabel?.trim() || "取消");
const requireText = computed(() => currentConfirm.value?.requireText?.trim() || "");
const requireTextMatched = computed(
  () => !requireText.value || requireTextInput.value.trim() === requireText.value,
);

function confirmDialog() {
  if (!requireTextMatched.value) {
    return;
  }
  const confirmId = currentConfirm.value?.id;
  if (typeof confirmId === "number" && settlingConfirmId.value === null) {
    settlingConfirmId.value = confirmId;
    settleConsoleConfirm(true, confirmId);
  }
}

function cancelDialog() {
  const confirmId = currentConfirm.value?.id;
  if (typeof confirmId === "number" && settlingConfirmId.value === null) {
    settlingConfirmId.value = confirmId;
    settleConsoleConfirm(false, confirmId);
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!open.value) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelDialog();
    return;
  }
  if (event.key !== "Tab" || !dialogRef.value) {
    return;
  }

  const focusable = Array.from(dialogRef.value.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) {
    event.preventDefault();
    dialogRef.value.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialogRef.value.contains(active))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (active === last || !dialogRef.value.contains(active))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

onMounted(() => {
  registerConsoleConfirmHost();
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  unregisterConsoleConfirmHost();
  document.removeEventListener("keydown", handleDocumentKeydown);
  previouslyFocusedElement?.focus({ preventScroll: true });
  previouslyFocusedElement = null;
});

watch(currentConfirm, async (next, previous) => {
  requireTextInput.value = "";
  settlingConfirmId.value = null;
  if (!next) {
    if (previous) {
      await nextTick();
      previouslyFocusedElement?.focus({ preventScroll: true });
      previouslyFocusedElement = null;
    }
    return;
  }
  if (!previous && document.activeElement instanceof HTMLElement) {
    previouslyFocusedElement = document.activeElement;
  }
  await nextTick();
  if (requireText.value) {
    inputRef.value?.focus({ preventScroll: true });
    return;
  }
  const focusTarget = tone.value === "danger" ? cancelButtonRef.value : confirmButtonRef.value;
  (focusTarget || dialogRef.value)?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <Transition name="console-confirm">
      <div
        v-if="open"
        class="console-confirm-backdrop"
        @click.self="cancelDialog"
      >
        <article
          ref="dialogRef"
          class="console-confirm-dialog"
          :class="`tone-${tone}`"
          role="alertdialog"
          aria-modal="true"
          :aria-label="title"
          :aria-describedby="messageId"
          tabindex="-1"
        >
          <h3 class="console-confirm-title">{{ title }}</h3>
          <p :id="messageId" class="console-confirm-message">{{ currentConfirm?.message }}</p>

          <label v-if="requireText" class="console-confirm-require">
            <span>请输入「{{ requireText }}」以确认该操作</span>
            <input
              ref="inputRef"
              v-model="requireTextInput"
              type="text"
              :placeholder="requireText"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="confirmDialog"
            />
          </label>

          <footer class="console-confirm-actions">
            <button
              ref="cancelButtonRef"
              class="tool-button-ghost"
              type="button"
              @click="cancelDialog"
            >
              {{ cancelLabel }}
            </button>
            <button
              ref="confirmButtonRef"
              class="tool-button console-confirm-button"
              :class="{ 'is-danger': tone === 'danger' }"
              type="button"
              :disabled="!requireTextMatched"
              @click="confirmDialog"
            >
              {{ confirmLabel }}
            </button>
          </footer>
        </article>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.console-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: var(--space-6);
  background: var(--backdrop);
}

.console-confirm-dialog {
  width: min(440px, calc(100vw - 48px));
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-xl);
}

.console-confirm-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--text-3xl);
  font-weight: var(--font-semibold);
  line-height: var(--leading-tight);
}

.console-confirm-dialog.tone-danger .console-confirm-title {
  color: var(--danger);
}

.console-confirm-message {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  white-space: pre-line;
  word-break: break-word;
  max-height: 40vh;
  overflow-y: auto;
}

.console-confirm-require {
  display: grid;
  gap: var(--space-1-5);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.console-confirm-require input {
  height: 34px;
  padding: 0 var(--space-2-5);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-base);
}

.console-confirm-require input:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
  border-color: var(--brand-border);
}

.console-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.console-confirm-button.is-danger {
  background: var(--danger-surface);
  color: var(--danger);
  border: 1px solid var(--danger-border);
}

.console-confirm-button.is-danger:hover {
  background: var(--danger-border);
  color: var(--text-primary);
  box-shadow: none;
}

.console-confirm-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.console-confirm-enter-active,
.console-confirm-leave-active {
  transition: opacity var(--dur-base) var(--ease-std);
}

.console-confirm-enter-active .console-confirm-dialog,
.console-confirm-leave-active .console-confirm-dialog {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.console-confirm-enter-from,
.console-confirm-leave-to {
  opacity: 0;
}

.console-confirm-enter-from .console-confirm-dialog,
.console-confirm-leave-to .console-confirm-dialog {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@media (max-width: 520px) {
  .console-confirm-backdrop {
    padding: var(--space-3);
  }

  .console-confirm-dialog {
    width: 100%;
    padding: var(--space-4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .console-confirm-enter-active,
  .console-confirm-leave-active,
  .console-confirm-enter-active .console-confirm-dialog,
  .console-confirm-leave-active .console-confirm-dialog {
    transition: none;
  }
}
</style>
