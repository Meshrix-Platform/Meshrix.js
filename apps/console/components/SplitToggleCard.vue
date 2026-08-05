<script setup lang="ts">
withDefaults(defineProps<{
  as?: string;
  expanded: boolean;
  expandedLabel: string;
  collapsedLabel: string;
}>(), {
  as: "section",
});

const emit = defineEmits<{
  (event: "toggle"): void;
}>();

function isInteractiveTarget(event: MouseEvent | KeyboardEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const currentTarget = event.currentTarget instanceof Element ? event.currentTarget : null;
  if (!target || !currentTarget) return false;
  const interactive = target.closest(
    "a, button, input, select, textarea, label, summary, [role='button'], [data-split-toggle-ignore]",
  );
  return Boolean(interactive && interactive !== currentTarget);
}

function toggleFromSummary(event: MouseEvent | KeyboardEvent) {
  if (isInteractiveTarget(event)) return;
  emit("toggle");
}
</script>

<template>
  <component
    :is="as"
    class="split-toggle-card"
    :data-open="expanded ? 'true' : 'false'"
  >
    <div class="split-toggle-card__main">
      <div
        class="split-toggle-card__summary"
        role="button"
        tabindex="0"
        :aria-label="expanded ? expandedLabel : collapsedLabel"
        :aria-expanded="expanded"
        :title="expanded ? expandedLabel : collapsedLabel"
        @click="toggleFromSummary"
        @keydown.enter.prevent="toggleFromSummary"
        @keydown.space.prevent="toggleFromSummary"
      >
        <slot name="summary"></slot>
      </div>
      <div v-if="expanded" class="split-toggle-card__body">
        <slot></slot>
      </div>
    </div>
    <button
      class="split-toggle-card__toggle"
      type="button"
      :aria-label="expanded ? expandedLabel : collapsedLabel"
      :title="expanded ? expandedLabel : collapsedLabel"
      :aria-expanded="expanded"
      @click="$emit('toggle')"
    >
      <svg
        v-if="expanded"
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="18 15 12 9 6 15"></polyline>
      </svg>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
  </component>
</template>

<style>
.split-toggle-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--split-toggle-card-toggle-width, 56px);
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--split-toggle-card-border-color, var(--border-subtle));
  border-radius: var(--split-toggle-card-radius, var(--radius-lg));
  background: var(--split-toggle-card-bg, var(--bg-surface));
  transition: border-color var(--dur-fast) var(--ease-std), background var(--dur-fast) var(--ease-std);
}

.split-toggle-card[data-open="true"] {
  border-color: var(--split-toggle-card-open-border-color, var(--split-toggle-card-border-color, var(--brand-muted)));
  background: var(--split-toggle-card-open-bg, var(--split-toggle-card-bg, var(--bg-surface)));
}

.split-toggle-card__main {
  display: grid;
  gap: var(--split-toggle-card-main-gap, var(--space-2));
  min-width: 0;
  padding: var(--split-toggle-card-padding, var(--space-3));
}

.split-toggle-card__summary {
  display: grid;
  min-width: 0;
  cursor: pointer;
  border-radius: var(--split-toggle-card-summary-radius, var(--radius-sm));
}

.split-toggle-card__summary:focus-visible {
  outline: 2px solid var(--split-toggle-card-focus-color, var(--brand-muted));
  outline-offset: 3px;
}

.split-toggle-card__body {
  display: grid;
  gap: var(--split-toggle-card-body-gap, var(--space-3));
  min-width: 0;
  padding-top: var(--split-toggle-card-body-padding-top, var(--space-2));
  border-top: 1px solid var(--split-toggle-card-divider-color, var(--border-subtle));
}

.split-toggle-card__toggle {
  display: grid;
  place-items: center;
  align-self: stretch;
  justify-self: stretch;
  width: 100%;
  min-width: 0;
  padding: var(--split-toggle-card-toggle-padding, var(--space-4) 0);
  border: 0;
  border-inline-start: 1px solid var(--split-toggle-card-divider-color, var(--border-subtle));
  background: var(--split-toggle-card-toggle-bg, transparent);
  color: var(--split-toggle-card-toggle-color, var(--text-secondary));
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-std), color var(--dur-fast) var(--ease-std);
}

.split-toggle-card__toggle:hover,
.split-toggle-card__toggle:focus-visible {
  background: var(--split-toggle-card-toggle-hover-bg, var(--info-surface));
  color: var(--split-toggle-card-toggle-hover-color, var(--brand-strong));
}

.split-toggle-card__toggle:focus-visible {
  outline: 2px solid var(--split-toggle-card-focus-color, var(--brand-muted));
  outline-offset: -3px;
}

.split-toggle-card__toggle svg {
  flex: none;
  display: block;
  margin: 0;
}
</style>
