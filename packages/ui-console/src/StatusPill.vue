<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  label: string | number;
  tone?: string;
  enabled?: boolean | null;
  showDot?: boolean;
  ariaLabel?: string;
}>(), {
  tone: "",
  enabled: null,
  showDot: true,
  ariaLabel: "",
});

const normalizedTone = computed(() => {
  const tone = String(props.tone || "").trim();
  if (tone) {
    return tone;
  }
  if (props.enabled === true) {
    return "success";
  }
  if (props.enabled === false) {
    return "neutral";
  }
  return "neutral";
});

const displayLabel = computed(() => String(props.label ?? ""));
const accessibleLabel = computed(() => props.ariaLabel || displayLabel.value);
</script>

<template>
  <span
    class="standard-status-pill status-pill"
    :data-tone="normalizedTone"
    :data-enabled="enabled === null ? undefined : enabled"
    :aria-label="accessibleLabel"
  >
    <span v-if="showDot" class="standard-status-pill-dot" aria-hidden="true" />
    <span class="standard-status-pill-label">{{ displayLabel }}</span>
  </span>
</template>

<style scoped>
.standard-status-pill {
  /* Default (neutral) */
  --_border: var(--border-strong);
  --_bg:     var(--bg-subtle);
  --_color:  var(--text-secondary);

  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 0 auto;
  height: 22px;
  max-width: 100%;
  padding: 0 var(--space-2);
  border: 1px solid var(--_border);
  border-radius: var(--radius-full);
  background: var(--_bg);
  color: var(--_color);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  line-height: 1;
  white-space: nowrap;
  letter-spacing: 0.01em;
}

/* Tone overrides */
.standard-status-pill[data-tone="queued"],
.standard-status-pill[data-tone="warning"] {
  --_border: var(--warning-border);
  --_bg:     var(--warning-surface);
  --_color:  var(--warning-text);
}

.standard-status-pill[data-tone="running"],
.standard-status-pill[data-tone="info"] {
  --_border: var(--info-border);
  --_bg:     var(--info-surface);
  --_color:  var(--info);
}

.standard-status-pill[data-tone="completed"],
.standard-status-pill[data-tone="aligned"],
.standard-status-pill[data-tone="online"],
.standard-status-pill[data-tone="success"] {
  --_border: var(--success-border);
  --_bg:     var(--success-surface);
  --_color:  var(--success);
}

.standard-status-pill[data-tone="failed"],
.standard-status-pill[data-tone="danger"],
.standard-status-pill[data-tone="high"] {
  --_border: var(--danger-border);
  --_bg:     var(--danger-surface);
  --_color:  var(--danger);
}

.standard-status-pill[data-tone="muted"],
.standard-status-pill[data-tone="neutral"],
.standard-status-pill[data-tone="offline"],
.standard-status-pill[data-tone="medium"],
.standard-status-pill[data-tone="low"] {
  --_border: var(--border-subtle);
  --_bg:     var(--bg-subtle);
  --_color:  var(--text-muted);
}

.standard-status-pill-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: currentColor;
  opacity: 0.8;
}

.standard-status-pill-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
