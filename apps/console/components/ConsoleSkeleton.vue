<script setup lang="ts">
import { computed } from "vue";

// Presentational mapping onto the existing skeleton utility classes in
// apps/console/styles/features/dashboard-progress.css — no new global CSS.
const props = withDefaults(defineProps<{
  variant?: "text" | "text-sm" | "text-lg" | "title" | "circle" | "pill" | "btn" | "icon" | "avatar" | "card" | "block" | "row";
  lines?: number;
  width?: "full" | "half" | "third";
  pulse?: boolean;
}>(), {
  variant: "text",
  lines: 1,
  pulse: true,
});

const lineCount = computed(() : any => {
  const value: any = Math.floor(props.lines);
  return Number.isFinite(value) && value > 0 ? value : 1;
});
const skeletonClasses = computed(() : any => {
  const classes: string[] = ["skeleton", `sk-${props.variant}`];
  if (props.width) {
    classes.push(`sk-${props.width}`);
  }
  if (props.pulse) {
    classes.push("sk-pulse");
  }
  return classes;
});
</script>

<template>
  <span
    v-for="line in lineCount"
    :key="line"
    :class="skeletonClasses"
    aria-hidden="true"
  />
</template>

<style scoped>
/* dashboard-progress.css has no reduced-motion handling; stop the shimmer and
   pulse animations locally so reduced-motion users keep reduced motion. */
@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
  }
}
</style>
