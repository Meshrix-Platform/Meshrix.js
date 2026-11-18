<script setup lang="ts">
import RuntimeModuleConfigItem from "./RuntimeModuleConfigItem.vue";
import type { RuntimeModuleRow } from "../../../composables/console-runtime-module-display-utils";

defineProps<{
  group: {
    id: string;
    label: string;
    description: string;
    rows: RuntimeModuleRow[];
  };
}>();
</script>

<template>
  <section class="mount-config-group">
    <div class="mount-group-header">
      <div>
        <h4>{{ group.label }}</h4>
        <p>{{ group.description }}</p>
      </div>
    </div>

    <RuntimeModuleConfigItem
      v-for="item in group.rows"
      :key="item.name"
      :item="item"
    />
  </section>
</template>
