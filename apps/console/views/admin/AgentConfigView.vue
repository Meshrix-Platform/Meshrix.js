<script setup lang="ts">
import AgentInvocationSettingsPanel from "../../components/admin/agent-config/AgentInvocationSettingsPanel.vue";
import AgentModelLibraryPanel from "../../components/admin/agent-config/AgentModelLibraryPanel.vue";
</script>

<template>
  <section class="agent-config-layout">
    <AgentModelLibraryPanel />
    <AgentInvocationSettingsPanel />
  </section>
</template>
