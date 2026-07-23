<script setup lang="ts">
import ConsoleEmptyState from "../../../components/ConsoleEmptyState.vue";
import type { PublishedServiceSummary } from "../../../lib/upstream-service-publish-client";

defineOptions({ name: "PublishServiceListPanel" });

withDefaults(defineProps<{
  services?: PublishedServiceSummary[];
  selectedServiceId?: string;
}>(), {
  services: () => [],
  selectedServiceId: ""
});

const emit = defineEmits<{
  select: [serviceId: string];
}>();
</script>

<template>
  <section class="publish-panel">
    <h3>Published Services</h3>
    <button
      v-for="svc in services"
      :key="svc.serviceId"
      class="service-row"
      :class="{ active: selectedServiceId === svc.serviceId }"
      type="button"
      @click="emit('select', svc.serviceId)"
    >
      <span>
        <strong>{{ svc.serviceId }}</strong>
        <small class="badge-disabled">{{ svc.publication.status }}</small>
      </span>
      <small>r{{ svc.serviceRevision }}</small>
    </button>
    <ConsoleEmptyState v-if="!services.length" compact title="No published services." />
  </section>
</template>

<style scoped>
.publish-panel {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem;
  overflow-y: auto;
}
.publish-panel h3 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}
.service-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.85rem;
  border-radius: 4px;
  text-align: left;
}
.service-row:hover {
  background: var(--hover);
}
.service-row.active {
  background: var(--selected);
  font-weight: 600;
}
.badge-disabled {
  color: var(--danger);
  margin-left: 0.5rem;
}
</style>
