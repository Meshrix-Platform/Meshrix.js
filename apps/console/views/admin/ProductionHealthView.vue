<script setup lang="ts">
import { onMounted, ref } from "vue";
import ProductionCoverageWarning from "../../components/admin/production-health/ProductionCoverageWarning.vue";
import ProductionGateTable from "../../components/admin/production-health/ProductionGateTable.vue";
import ProductionHealthBottomGrid from "../../components/admin/production-health/ProductionHealthBottomGrid.vue";
import ProductionHealthHeroCard from "../../components/admin/production-health/ProductionHealthHeroCard.vue";
import ProductionSectionGrid from "../../components/admin/production-health/ProductionSectionGrid.vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import {
  loadProductionHealthSnapshot,
  type ProductionHealthResponse,
} from "../../lib/production-health";

const health = ref<ProductionHealthResponse | null>(null);
const loading = ref(false);
const loadError = ref("");

async function refreshProductionHealth() {
  loading.value = true;
  loadError.value = "";
  try {
    const snapshot = await loadProductionHealthSnapshot();
    if (snapshot.health !== undefined) {
      health.value = snapshot.health;
    }
    loadError.value = snapshot.loadError || "";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refreshProductionHealth();
});

usePageRefreshHandler(
  (detail) => detail.viewId === "admin" && detail.adminView === "productionHealth",
  refreshProductionHealth,
);
</script>

<template>
  <section class="production-health-layout">
    <ProductionHealthHeroCard :health="health" :load-error="loadError" />
    <ProductionCoverageWarning
      v-if="health?.coverage.missing.length"
      :missing="health.coverage.missing"
    />
    <ProductionSectionGrid :sections="health?.sections || []" />
    <ProductionGateTable :gates="health?.gates || []" />
    <ProductionHealthBottomGrid
      :actions="health?.actions || []"
      :history="health?.history || []"
    />
  </section>
</template>

<style scoped>
.production-health-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
