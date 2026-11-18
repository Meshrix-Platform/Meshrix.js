<script setup lang="ts">
import { useConsoleSideNavContext } from "../../../composables/consoleSideNavContext";

defineOptions({ name: "ConsoleSideNavBackdrop" });

const { sideNavOpen } = useConsoleSideNavContext();

function closeSideNav() {
  sideNavOpen.value = false;
}
</script>

<template>
  <div class="side-nav-backdrop" aria-hidden="true" @click="closeSideNav"></div>
</template>
