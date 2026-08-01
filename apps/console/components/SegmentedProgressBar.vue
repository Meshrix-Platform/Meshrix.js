<script setup lang="ts">
import { computed } from "vue";

type SegmentedProgressState = "pending" | "active" | "running" | "complete" | "completed" | "failed";

type SegmentedProgressSegment = {
  key?: string | number;
  label?: string;
  state?: SegmentedProgressState | string;
};

const props = withDefaults(defineProps<{
  ariaLabel?: string;
  completedSteps?: number;
  labels?: string[];
  segments?: SegmentedProgressSegment[];
  showLabels?: boolean;
  size?: "compact" | "default";
  totalSteps?: number;
  valueLabel?: string;
}>(), {
  ariaLabel: "进度",
  completedSteps: 0,
  labels: () => [],
  segments: () => [],
  showLabels: false,
  size: "default",
  totalSteps: 0,
  valueLabel: "",
});

function normalizeState(state: any = "") {
  if (state === "complete" || state === "completed") return "complete";
  if (state === "active" || state === "running") return "active";
  if (state === "failed") return "failed";
  return "pending";
}

const normalizedSegments = computed(() => {
  if (props.segments.length) {
    return props.segments.map((segment: any, index: any) => ({
      key: String(segment.key ?? index),
      label: String(segment.label || segment.key || `步骤 ${index + 1}`),
      state: normalizeState(String(segment.state || "")),
    }));
  }
  const total = Math.max(0, props.totalSteps || props.labels.length);
  const labels = props.labels.length ? props.labels : Array.from({ length: total }, (_: any, index: any) => `步骤 ${index + 1}`);
  return labels.map((label: any, index: any) => ({
    key: `${label}:${index}`,
    label,
    state: index < props.completedSteps ? "complete" : "pending",
  }));
});

const completedCount = computed(() =>
  normalizedSegments.value.filter((segment: any) => segment.state === "complete").length,
);
const gridColumns = computed(() =>
  `repeat(${Math.max(1, normalizedSegments.value.length)}, minmax(0, 1fr))`,
);
</script>

<template>
  <div
    class="meshrix-segmented-progress"
    :data-size="size"
    :data-show-labels="showLabels"
    role="progressbar"
    :aria-label="ariaLabel"
    :aria-valuemin="0"
    :aria-valuemax="normalizedSegments.length"
    :aria-valuenow="completedCount"
    :aria-valuetext="valueLabel || undefined"
    :style="{ gridTemplateColumns: gridColumns }"
  >
    <div
      v-for="segment in normalizedSegments"
      :key="segment.key"
      class="meshrix-segmented-progress-segment"
      :data-state="segment.state"
      :title="segment.label"
    >
      <span class="meshrix-segmented-progress-bar" aria-hidden="true" />
      <small v-if="showLabels">{{ segment.label }}</small>
    </div>
  </div>
</template>

<style scoped>
.meshrix-segmented-progress {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  align-items: start;
}

.meshrix-segmented-progress[data-size="compact"] {
  gap: var(--space-2);
}

.meshrix-segmented-progress-segment {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.meshrix-segmented-progress-bar {
  display: block;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--border-subtle);
  transition:
    background-color var(--dur-med) var(--ease-std),
    box-shadow var(--dur-med) var(--ease-std);
}

.meshrix-segmented-progress-segment[data-state="active"] .meshrix-segmented-progress-bar {
  background: var(--brand);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 26%, transparent);
}

.meshrix-segmented-progress-segment[data-state="complete"] .meshrix-segmented-progress-bar {
  background: var(--success);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--success) 28%, transparent);
}

.meshrix-segmented-progress-segment[data-state="failed"] .meshrix-segmented-progress-bar {
  background: var(--danger);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 28%, transparent);
}

.meshrix-segmented-progress-segment small {
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
  overflow-wrap: anywhere;
}

.meshrix-segmented-progress-segment[data-state="active"] small {
  color: var(--brand);
}

.meshrix-segmented-progress-segment[data-state="complete"] small {
  color: var(--success);
}

.meshrix-segmented-progress-segment[data-state="failed"] small {
  color: var(--danger);
}
</style>
