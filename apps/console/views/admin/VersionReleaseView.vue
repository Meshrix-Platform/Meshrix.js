<script setup lang="ts">
import { onMounted, ref } from "vue";
import VersionReleaseBaselineCard from "../../components/admin/version-release/VersionReleaseBaselineCard.vue";
import VersionReleaseReadinessCard from "../../components/admin/version-release/VersionReleaseReadinessCard.vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import {
  loadVersionReleaseSnapshot,
  type ProductionHealthResponse,
  type ReadinessBaselineStatus,
} from "../../lib/version-release";

const baseline = ref<ReadinessBaselineStatus | null>(null);
const baselineError = ref("");
const productionHealth = ref<ProductionHealthResponse | null>(null);
const productionHealthError = ref("");

async function refreshVersionRelease() {
  baselineError.value = "";
  productionHealthError.value = "";
  const snapshot = await loadVersionReleaseSnapshot();
  if (snapshot.baseline !== undefined) {
    baseline.value = snapshot.baseline;
  }
  if (snapshot.productionHealth !== undefined) {
    productionHealth.value = snapshot.productionHealth;
  }
  baselineError.value = snapshot.baselineError || "";
  productionHealthError.value = snapshot.productionHealthError || "";
}

onMounted(() => {
  void refreshVersionRelease();
});

usePageRefreshHandler(
  (detail: any) => detail.viewId === "admin" && detail.adminView === "versionRelease",
  refreshVersionRelease,
);
</script>

<template>
  <section class="version-release-layout">
    <VersionReleaseReadinessCard
      :health="productionHealth"
      :health-error="productionHealthError"
    />
    <VersionReleaseBaselineCard :baseline="baseline" :baseline-error="baselineError" />
  </section>
</template>

<style scoped>
.version-release-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
