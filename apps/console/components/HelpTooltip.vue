<script setup lang="ts">
import { QuestionFilled } from "@element-plus/icons-vue";
import { computed, nextTick, onBeforeUnmount, ref, useSlots } from "vue";

type HelpTooltipItem = readonly [string, string] | {
  description?: string;
  label?: string;
  title?: string;
};

const props = withDefaults(defineProps<{
  align?: "start" | "end";
  ariaLabel?: string;
  items?: HelpTooltipItem[];
  maxWidth?: number;
  text?: string;
}>(), {
  align: "start",
  ariaLabel: "说明",
  items: () => [],
  maxWidth: 360,
  text: "",
});

const tooltipId = `help-tooltip-${Math.random().toString(36).slice(2)}`;
const slots = useSlots();
const triggerRef = ref<HTMLElement | null>(null);
const visible = ref(false);
const placement = ref<"above" | "below">("below");
const x = ref(0);
const y = ref(0);

function isTupleItem(item: HelpTooltipItem): item is readonly [string, string] {
  return Array.isArray(item);
}

const normalizedItems = computed(() => props.items.map((item: any) => {
  if (isTupleItem(item)) return { title: item[0], description: item[1] };
  return { title: item.title || item.label || "", description: item.description || "" };
}).filter((item: any) => item.title || item.description));

const hasContent = computed(() =>
  normalizedItems.value.length > 0 ||
  props.text.trim().length > 0 ||
  Boolean(slots.default)
);
const tooltipStyle = computed(() => ({
  "--help-tooltip-width": `${props.maxWidth}px`,
  left: `${x.value}px`,
  top: `${y.value}px`,
}));

function updatePosition() {
  const target = triggerRef.value;
  const browser = target?.ownerDocument.defaultView;
  if (!target || !browser) return;
  const rect = target.getBoundingClientRect();
  const width = Math.min(props.maxWidth, browser.innerWidth - 24);
  const below = rect.top < 120 || rect.bottom + 180 < browser.innerHeight;
  const preferredLeft = props.align === "end" ? rect.right - width : rect.left;
  placement.value = below ? "below" : "above";
  x.value = Math.max(12, Math.min(preferredLeft, browser.innerWidth - width - 12));
  y.value = below ? rect.bottom + 8 : rect.top - 8;
}

function addPositionListeners() {
  window.addEventListener("resize", updatePosition);
  window.addEventListener("scroll", updatePosition, true);
}

function removePositionListeners() {
  window.removeEventListener("resize", updatePosition);
  window.removeEventListener("scroll", updatePosition, true);
}

function showTooltip() {
  if (!hasContent.value) return;
  visible.value = true;
  void nextTick(updatePosition);
  removePositionListeners();
  addPositionListeners();
}

function hideTooltip() {
  visible.value = false;
  removePositionListeners();
}

onBeforeUnmount(removePositionListeners);
</script>

<template>
  <button
    ref="triggerRef"
    class="help-tooltip-trigger"
    type="button"
    :aria-describedby="visible ? tooltipId : undefined"
    :aria-label="ariaLabel"
    @blur="hideTooltip"
    @focus="showTooltip"
    @mouseenter="showTooltip"
    @mouseleave="hideTooltip"
    @pointerenter="showTooltip"
    @pointerleave="hideTooltip"
  >
    <QuestionFilled aria-hidden="true" />
  </button>
  <Teleport to="body">
    <div
      v-if="visible"
      :id="tooltipId"
      class="help-tooltip-popover"
      :class="`is-${placement}`"
      :style="tooltipStyle"
      role="tooltip"
    >
      <span v-if="text" class="help-tooltip-text">{{ text }}</span>
      <span v-for="item in normalizedItems" :key="`${item.title}:${item.description}`" class="help-tooltip-item">
        <strong v-if="item.title">{{ item.title }}</strong>
        <span v-if="item.description">{{ item.description }}</span>
      </span>
      <slot v-if="!text && normalizedItems.length === 0" />
    </div>
  </Teleport>
</template>

<style scoped>
.help-tooltip-trigger {
  width: 16px;
  height: 16px;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-muted);
  cursor: help;
}

.help-tooltip-trigger svg {
  width: 14px;
  height: 14px;
}

.help-tooltip-trigger:hover,
.help-tooltip-trigger:focus-visible {
  color: var(--brand);
}

.help-tooltip-trigger:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.help-tooltip-popover {
  position: fixed;
  z-index: var(--z-top);
  width: min(var(--help-tooltip-width), calc(100vw - 24px));
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-secondary);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-md);
  font-weight: var(--font-normal);
  line-height: 1.45;
  overflow-wrap: anywhere;
  pointer-events: none;
}

.help-tooltip-popover.is-above {
  transform: translateY(-100%);
}

.help-tooltip-item {
  display: grid;
  gap: var(--space-0-5);
}

.help-tooltip-item strong {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
}

.help-tooltip-text {
  color: var(--text-secondary);
}
</style>
