<script setup lang="ts">
import RuntimeModulesPanel from "../../components/admin/modules/RuntimeModulesPanel.vue";
import { useModulesViewConsole } from "../../composables/console-modules-view-controller";
import { provideModulesView } from "../../composables/modulesViewContext";

const modulesView = useModulesViewConsole();
provideModulesView(modulesView);
</script>

<template>
  <RuntimeModulesPanel />
</template>
