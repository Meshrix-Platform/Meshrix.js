<script setup lang="ts">
import ConfigFoldCard from "../ConfigFoldCard.vue";
import { useWorkspacesViewContext } from "@meshrix/ui-console/workspaces-view-context";

const { chainData } = useWorkspacesViewContext();
</script>

<template>
  <ConfigFoldCard v-if="chainData" title="解析后的合并 Profile（含继承链）">
    <pre class="config-json-preview">{{ JSON.stringify(chainData.resolvedProfile, null, 2) }}</pre>
  </ConfigFoldCard>
</template>
