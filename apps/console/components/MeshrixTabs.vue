<script setup lang="ts">
/**
 * MeshrixTabs — Unified Tab Component
 *
 * A proper tab bar with "connected" active tab design. The active tab visually
 * connects to the content panel below by interrupting the tab bar's bottom border.
 *
 * Usage:
 *   <MeshrixTabs v-model="activeTab" :tabs="tabs" />
 *
 * Props:
 *   - modelValue: active tab key
 *   - tabs: array of { key, label, closable?, disabled?, draft? }
 *   - variant: "line" (standard) | "card" (elevated, for session tabs)
 *   - size: "default" | "small" | "compact"
 *   - scrollable: boolean (horizontal scroll for overflow)
 *   - ariaLabel: string
 *   - panelIds: optional map tab key -> role="tabpanel" element id; tabs then
 *     carry aria-controls, and consumers label their panels with
 *     aria-labelledby="meshrix-tab-<key>". Keys must be unique across all
 *     MeshrixTabs instances on the page (tab ids are deterministic).
 *
 * Events:
 *   - update:modelValue
 *   - change(key)
 *   - close(key) — emitted when a closable tab's × is clicked
 */
import { nextTick, ref } from "vue";

export type MeshrixTab = {
  key: string;
  label: string;
  closable?: boolean;
  disabled?: boolean;
  draft?: boolean;
  meta?: string;
};

const props = withDefaults(
  defineProps<{
    modelValue: string;
    tabs: MeshrixTab[];
    variant?: "line" | "card";
    size?: "default" | "small" | "compact";
    scrollable?: boolean;
    ariaLabel?: string;
    panelIds?: Record<string, string>;
  }>(),
  {
    variant: "line",
    size: "default",
    scrollable: false,
    ariaLabel: "Tabs",
    panelIds: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [key: string];
  change: [key: string];
  close: [key: string];
}>();

const tablistRef = ref<HTMLElement | null>(null);

function tabId(key: string): string {
  return `meshrix-tab-${key}`;
}

function selectTab(tab: MeshrixTab) {
  if (tab.disabled) return;
  emit("update:modelValue", tab.key);
  emit("change", tab.key);
}

function closeTab(event: Event, tab: MeshrixTab) {
  event.stopPropagation();
  emit("close", tab.key);
}

// Arrow-key navigation over the roving tabindex: selection follows focus
// (automatic activation), wrapping at both ends and skipping disabled tabs.
async function onTabKeydown(event: KeyboardEvent) {
  const enabledTabs: MeshrixTab[] = props.tabs.filter((tab: MeshrixTab) => !tab.disabled);
  if (!enabledTabs.length) {
    return;
  }
  const currentIndex: number = enabledTabs.findIndex((tab: MeshrixTab) => tab.key === props.modelValue);
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") {
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabledTabs.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = currentIndex < 0 ? enabledTabs.length - 1 : (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = enabledTabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const nextTab: MeshrixTab = enabledTabs[nextIndex];
  selectTab(nextTab);
  // Roving tabindex follows modelValue; move focus once the DOM settles.
  await nextTick();
  tablistRef.value
    ?.querySelector<HTMLElement>(`[id="${tabId(nextTab.key)}"]`)
    ?.focus({ preventScroll: true });
}
</script>

<template>
  <div
    ref="tablistRef"
    class="meshrix-tabs"
    :class="[
      `meshrix-tabs--${variant}`,
      `meshrix-tabs--${size}`,
      { 'meshrix-tabs--scrollable': scrollable },
    ]"
    role="tablist"
    :aria-label="ariaLabel"
  >
    <button
      v-for="tab in tabs"
      :key="tab.key"
      :id="tabId(tab.key)"
      class="meshrix-tab"
      :class="{
        'meshrix-tab--active': modelValue === tab.key,
        'meshrix-tab--disabled': tab.disabled,
        'meshrix-tab--draft': tab.draft,
        'meshrix-tab--closable': tab.closable,
      }"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      :aria-controls="panelIds?.[tab.key]"
      :tabindex="modelValue === tab.key ? 0 : -1"
      :disabled="tab.disabled"
      @click="selectTab(tab)"
      @keydown="onTabKeydown"
    >
      <span class="meshrix-tab__label">{{ tab.label }}</span>
      <span v-if="tab.meta" class="meshrix-tab__meta">{{ tab.meta }}</span>
      <span
        v-if="tab.closable"
        class="meshrix-tab__close"
        role="button"
        aria-label="Close tab"
        @click="closeTab($event, tab)"
      >&times;</span>
    </button>
  </div>
</template>
