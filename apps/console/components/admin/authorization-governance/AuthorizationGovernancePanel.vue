<script setup lang="ts">
import type { AuthorizationGovernancePanel } from "./authorization-governance-panel-rows";

defineProps<{
  panel: AuthorizationGovernancePanel;
}>();
</script>

<template>
  <section class="authorization-governance-panel">
    <div class="panel-title">
      <strong>{{ panel.title }}</strong>
      <span>{{ panel.count }}</span>
    </div>
    <div class="governance-list">
      <div v-for="row in panel.rows" :key="row.key" class="governance-row">
        <strong>{{ row.title }}</strong>
        <span>{{ row.detail }}</span>
        <small>{{ row.meta }}</small>
      </div>
      <div v-if="panel.count === 0" class="governance-empty">{{ panel.emptyLabel }}</div>
    </div>
  </section>
</template>
