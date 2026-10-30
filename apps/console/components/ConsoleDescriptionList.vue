<script setup lang="ts">
export type ConsoleDescriptionItem = {
  label: string;
  value: string;
  mono?: boolean;
};

withDefaults(
  defineProps<{
    items: ConsoleDescriptionItem[];
    columns?: 2 | 3 | 4;
  }>(),
  { columns: 3 },
);
</script>

<template>
  <dl class="console-description-list" :data-columns="columns">
    <div v-for="item in items" :key="item.label" class="console-description-item">
      <dt>{{ item.label }}</dt>
      <dd :class="{ mono: item.mono }">{{ item.value }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.console-description-list {
  display: grid;
  gap: var(--space-2-5);
  margin: 0;
}

.console-description-list[data-columns="2"] {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.console-description-list[data-columns="3"] {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.console-description-list[data-columns="4"] {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.console-description-item {
  min-width: 0;
  padding: var(--space-3) 0;
  border: 0;
  border-bottom: 1px solid var(--console-rule);
  border-radius: 0;
  background: transparent;
}

.console-description-item dt {
  color: var(--console-ink-secondary);
  font-size: var(--text-md);
  font-weight: var(--font-medium);
}

.console-description-item dd {
  min-width: 0;
  margin: var(--space-1) 0 0;
  color: var(--text-primary);
  font-size: var(--text-lg);
  overflow-wrap: anywhere;
}

.console-description-item dd.mono {
  font-family: var(--font-mono);
  font-size: var(--text-base);
}

@media (max-width: 1120px) {
  .console-description-list[data-columns="3"],
  .console-description-list[data-columns="4"] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .console-description-list[data-columns="2"],
  .console-description-list[data-columns="3"],
  .console-description-list[data-columns="4"] {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
