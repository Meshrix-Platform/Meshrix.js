<script setup lang="ts">
import StorageDiscoveryCard from "../../components/admin/storage/StorageDiscoveryCard.vue";
import StorageOverviewCard from "../../components/admin/storage/StorageOverviewCard.vue";
import StorageRuntimeCard from "../../components/admin/storage/StorageRuntimeCard.vue";
import StorageSessionCard from "../../components/admin/storage/StorageSessionCard.vue";
import { useStorageViewConsole } from "../../composables/console-storage-view-controller";
import { provideStorageView } from "../../composables/storageViewContext";

const storageView = useStorageViewConsole();
provideStorageView(storageView);
</script>

<template>
  <section id="storage" class="detail-grid">
    <StorageOverviewCard />
    <StorageRuntimeCard />
    <StorageDiscoveryCard />
    <StorageSessionCard />
  </section>
</template>
