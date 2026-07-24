<script setup lang="ts">
import { computed } from "vue";
import BinaryCheckbox from "@meshrix/ui-console/binary-checkbox";

export type DashboardPluginStatus = {
  id: string;
  version: string;
  features: string[];
  effective: boolean;
};

const props = defineProps<{
  plugins: DashboardPluginStatus[];
}>();

const orderedPlugins = computed(() => [...props.plugins].sort((left, right) =>
  left.id.localeCompare(right.id),
));
const effectiveCount = computed(() => props.plugins.filter((plugin) => plugin.effective).length);
</script>

<template>
  <article class="surface-card dashboard-plugin-card" aria-labelledby="dashboard-plugin-card-title">
    <div class="section-header dashboard-plugin-card-header">
      <div>
        <h3 id="dashboard-plugin-card-title">插件</h3>
        <p>已生效的插件保持勾选；已装载但未生效的插件以灰色显示。</p>
      </div>
      <span class="dashboard-plugin-summary">{{ effectiveCount }}/{{ plugins.length }} 已生效</span>
    </div>
    <div v-if="orderedPlugins.length" class="dashboard-plugin-list">
      <div
        v-for="plugin in orderedPlugins"
        :key="plugin.id"
        class="dashboard-plugin-item"
        :data-effective="plugin.effective"
      >
        <BinaryCheckbox
          :model-value="plugin.effective"
          :label="plugin.id"
          :disabled="!plugin.effective"
          readonly
        />
        <span class="dashboard-plugin-version">v{{ plugin.version }}</span>
      </div>
    </div>
    <div v-else class="dashboard-plugin-empty">暂无已装载插件</div>
  </article>
</template>
