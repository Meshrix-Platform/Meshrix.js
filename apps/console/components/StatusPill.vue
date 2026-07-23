<script setup lang="ts">
import { computed } from "vue";
import PublicStatusPill from "@lico/ui-console/status-pill";
import { currentConsoleLocale, localizeConsoleText } from "../i18n/console";

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

const displayLabel = computed(() =>
  localizeConsoleText(String(props.label ?? ""), currentConsoleLocale.value),
);
</script>

<template>
  <PublicStatusPill
    :label="displayLabel"
    :tone="tone"
    :enabled="enabled"
    :show-dot="showDot"
    :aria-label="ariaLabel"
  />
</template>
