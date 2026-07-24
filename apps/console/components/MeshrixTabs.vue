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
 *
 * Events:
 *   - update:modelValue
 *   - change(key)
 *   - close(key) — emitted when a closable tab's × is clicked
 */
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
  }>(),
  {
    variant: "line",
    size: "default",
    scrollable: false,
    ariaLabel: "Tabs",
  },
);

const emit = defineEmits<{
  "update:modelValue": [key: string];
  change: [key: string];
  close: [key: string];
}>();

function selectTab(tab: MeshrixTab) {
  if (tab.disabled) return;
  emit("update:modelValue", tab.key);
  emit("change", tab.key);
}

function closeTab(event: Event, tab: MeshrixTab) {
  event.stopPropagation();
  emit("close", tab.key);
}
</script>

<template>
  <div
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
      :tabindex="modelValue === tab.key ? 0 : -1"
      :disabled="tab.disabled"
      @click="selectTab(tab)"
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
