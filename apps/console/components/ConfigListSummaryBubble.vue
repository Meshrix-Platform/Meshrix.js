<script setup lang="ts">
import { Setting } from "@element-plus/icons-vue";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import ConsoleEmptyState from "./ConsoleEmptyState.vue";

type ConfigListSummaryBubbleEntry = {
  configured?: boolean;
  description?: string;
  key: string;
  label?: string;
  required?: boolean;
  source?: string;
  value?: string;
};

type ConfigListSummaryBubbleGroup = {
  kind?: string;
  title: string;
  entries?: ConfigListSummaryBubbleEntry[];
};

const props = withDefaults(defineProps<{
  ariaLabel?: string;
  buttonAriaLabel?: string;
  buttonClass?: string;
  buttonLabel?: string;
  emptyDescription?: string;
  emptyTitle?: string;
  groups?: ConfigListSummaryBubbleGroup[];
  subtitle?: string;
  title: string;
  width?: number;
}>(), {
  ariaLabel: "",
  buttonAriaLabel: "",
  buttonClass: "tool-button tool-button-ghost",
  buttonLabel: "配置",
  emptyDescription: "当前目标未返回配置字段。",
  emptyTitle: "暂无配置项",
  groups: () => [],
  subtitle: "",
  width: 560,
});

const popoverId = `config-list-summary-${Math.random().toString(36).slice(2)}`;
const triggerRef = ref<HTMLElement | null>(null);
const popoverRef = ref<HTMLElement | null>(null);
const visible = ref(false);
const placement = ref<"above" | "below">("below");
const x = ref(0);
const y = ref(0);

const normalizedGroups = computed(() =>
  (props.groups || [])
    .map((group: any) => ({
      ...group,
      entries: (group.entries || []).filter((entry: any) => entry.label || entry.key || entry.value),
    }))
    .filter((group: any) => group.title && group.entries.length),
);
const entryCount = computed(() => normalizedGroups.value.reduce((sum: any, group: any) => sum + group.entries.length, 0));
const headerSubtitle = computed(() => props.subtitle || `${entryCount.value} 项配置`);
const popoverStyle = computed(() => ({
  "--config-list-summary-width": `${props.width}px`,
  left: `${x.value}px`,
  top: `${y.value}px`,
}));
const accessibleLabel = computed(() => props.ariaLabel || `${props.title} 配置列表`);
const accessibleButtonLabel = computed(() => props.buttonAriaLabel || `${props.buttonLabel} ${props.title}`);
const displayButtonLabel = computed(() => props.buttonLabel);

function entryState(entry: ConfigListSummaryBubbleEntry) {
  if (entry.required && !entry.configured) return "必填未配置";
  return entry.configured === false ? "未配置" : "已配置";
}

function entryValue(entry: ConfigListSummaryBubbleEntry) {
  return String(entry.value || "").trim() || "未配置";
}

function updatePosition() {
  const target = triggerRef.value;
  const browser = target?.ownerDocument.defaultView;
  if (!target || !browser) return;
  const rect = target.getBoundingClientRect();
  const width = Math.min(props.width, browser.innerWidth - 24);
  const height = Math.min(popoverRef.value?.offsetHeight || 420, browser.innerHeight - 24);
  const preferredBelowTop = rect.bottom + 8;
  const preferredAboveTop = rect.top - height - 8;
  const below = preferredBelowTop + height <= browser.innerHeight - 12 || preferredAboveTop < 12;
  const preferredTop = below ? preferredBelowTop : preferredAboveTop;
  placement.value = below ? "below" : "above";
  x.value = Math.max(12, Math.min(rect.right - width, browser.innerWidth - width - 12));
  y.value = Math.max(12, Math.min(preferredTop, browser.innerHeight - height - 12));
}

function closeBubble() {
  visible.value = false;
  window.removeEventListener("resize", updatePosition);
  window.removeEventListener("scroll", updatePosition, true);
  document.removeEventListener("pointerdown", handlePointerDown);
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (triggerRef.value?.contains(target) || popoverRef.value?.contains(target)) return;
  closeBubble();
}

function openBubble() {
  visible.value = true;
  void nextTick(updatePosition);
  window.removeEventListener("resize", updatePosition);
  window.removeEventListener("scroll", updatePosition, true);
  document.removeEventListener("pointerdown", handlePointerDown);
  window.addEventListener("resize", updatePosition);
  window.addEventListener("scroll", updatePosition, true);
  document.addEventListener("pointerdown", handlePointerDown);
}

function toggleBubble() {
  if (visible.value) {
    closeBubble();
    return;
  }
  openBubble();
}

onBeforeUnmount(closeBubble);
</script>

<template>
  <button
    ref="triggerRef"
    :class="buttonClass"
    type="button"
    :aria-controls="visible ? popoverId : undefined"
    :aria-expanded="visible"
    :aria-label="accessibleButtonLabel"
    @click.stop="toggleBubble"
  >
    <slot name="button-icon">
      <Setting aria-hidden="true" />
    </slot>
    <span>{{ displayButtonLabel }}</span>
  </button>
  <Teleport to="body">
    <section
      v-if="visible"
      :id="popoverId"
      ref="popoverRef"
      class="config-list-summary-popover"
      :class="`is-${placement}`"
      :style="popoverStyle"
      role="dialog"
      :aria-label="accessibleLabel"
      @keydown.esc="closeBubble"
    >
      <header class="config-list-summary-header">
        <div>
          <strong>{{ title }}</strong>
          <span>{{ headerSubtitle }}</span>
        </div>
        <button class="config-list-summary-close" type="button" aria-label="关闭配置列表" @click="closeBubble">
          ×
        </button>
      </header>
      <div class="config-list-summary-body">
        <section
          v-for="group in normalizedGroups"
          :key="`${group.kind || ''}:${group.title}`"
          class="config-list-summary-group"
        >
          <h4>{{ group.title }}</h4>
          <dl>
            <div
              v-for="entry in group.entries"
              :key="`${group.title}:${entry.key}:${entry.label}`"
              class="config-list-summary-entry"
              :data-configured="entry.configured !== false"
            >
              <dt>
                <span>{{ entry.label || entry.key }}</span>
                <code>{{ entry.key }}</code>
              </dt>
              <dd>
                <strong>{{ entryValue(entry) }}</strong>
                <span>{{ entryState(entry) }}</span>
                <small v-if="entry.source || entry.description">
                  {{ [entry.source, entry.description].filter(Boolean).join("；") }}
                </small>
              </dd>
            </div>
          </dl>
        </section>
        <ConsoleEmptyState
          v-if="normalizedGroups.length === 0"
          compact
          :title="emptyTitle"
          :description="emptyDescription"
        />
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
button :deep(svg),
button svg {
  width: 14px;
  height: 14px;
}

.config-list-summary-popover {
  position: fixed;
  z-index: var(--z-top);
  width: min(var(--config-list-summary-width), calc(100vw - 24px));
  max-height: min(520px, calc(100vh - 24px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}

.config-list-summary-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
}

.config-list-summary-header > div {
  display: grid;
  gap: var(--space-0-5);
  min-width: 0;
}

.config-list-summary-header strong {
  color: var(--text-primary);
  font-size: var(--text-lg);
  line-height: 1.3;
}

.config-list-summary-header span {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.config-list-summary-close {
  width: 26px;
  height: 26px;
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--text-lg);
  line-height: 1;
}

.config-list-summary-body {
  display: grid;
  gap: var(--space-3);
  min-height: 0;
  padding: var(--space-3);
  overflow-y: auto;
}

.config-list-summary-group {
  display: grid;
  gap: var(--space-2);
}

.config-list-summary-group h4 {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--font-bold);
}

.config-list-summary-group dl {
  display: grid;
  gap: var(--space-1);
  margin: 0;
}

.config-list-summary-entry {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) minmax(0, 1.5fr);
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}

.config-list-summary-entry dt,
.config-list-summary-entry dd {
  display: grid;
  gap: var(--space-0-5);
  min-width: 0;
  margin: 0;
}

.config-list-summary-entry dt span {
  color: var(--text-primary);
  font-size: var(--text-md);
  font-weight: var(--font-semibold);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.config-list-summary-entry code {
  min-width: 0;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.config-list-summary-entry dd strong {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
  overflow-wrap: anywhere;
}

.config-list-summary-entry dd span {
  color: var(--success);
  font-size: var(--text-xs);
  font-weight: var(--font-bold);
}

.config-list-summary-entry[data-configured="false"] dd span {
  color: var(--text-muted);
}

.config-list-summary-entry small {
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .config-list-summary-entry {
    grid-template-columns: 1fr;
  }
}
</style>
