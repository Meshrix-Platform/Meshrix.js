<script setup lang="ts">
import StatusPill from "../../StatusPill.vue";
import { statusLabel } from "../../../lib/production-health";
import type { ProductionHealthSection } from "../../../lib/types";

defineProps<{
  sections: ProductionHealthSection[];
}>();
</script>

<template>
  <section class="production-section-grid">
    <article
      v-for="section in sections"
      :key="section.id"
      class="surface-card production-section-card"
    >
      <div class="section-header compact-section-header">
        <div>
          <h3>{{ section.label }}</h3>
          <p>{{ section.description }}</p>
        </div>
        <StatusPill :tone="section.tone" :label="statusLabel(section.status)" />
      </div>
      <div class="production-section-score">
        <strong>{{ section.passed }} / {{ section.total }}</strong>
        <span>门禁通过</span>
      </div>
      <div class="production-gate-chips">
        <span
          v-for="gate in section.gates"
          :key="gate.id"
          :data-tone="gate.tone"
        >
          {{ gate.title }}
        </span>
        <span
          v-for="gateId in section.missingGateIds"
          :key="gateId"
          data-tone="warning"
        >
          {{ gateId }}
        </span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.production-section-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: minmax(220px, 1fr);
  align-items: stretch;
  gap: var(--space-4);
}

.production-section-grid > .production-section-card {
  margin-top: 0;
}

.production-section-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  min-height: 220px;
}

.compact-section-header {
  align-items: flex-start;
}

.production-section-score {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.production-section-score strong {
  color: var(--text-primary);
  font-size: var(--text-2xl);
  line-height: 1;
}

.production-section-score span {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.production-gate-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.production-gate-chips span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
}

.production-gate-chips span[data-tone="success"] {
  border-color: var(--success-border);
  background: var(--success-surface);
  color: var(--success);
}

.production-gate-chips span[data-tone="warning"] {
  border-color: var(--warning-border);
  background: var(--warning-surface);
  color: var(--warning-text);
}

.production-gate-chips span[data-tone="danger"] {
  border-color: var(--danger-border);
  background: var(--danger-surface);
  color: var(--danger);
}

@media (max-width: 1120px) {
  .production-section-grid {
    grid-template-columns: 1fr;
  }
}
</style>
