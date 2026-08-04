<script setup lang="ts">
import "./WorkspaceExpandedDetail.css";
import WorkspaceCheckpointPanel from "./WorkspaceCheckpointPanel.vue";
import WorkspaceDeleteAction from "./WorkspaceDeleteAction.vue";
import WorkspaceExpandedOverview from "./WorkspaceExpandedOverview.vue";
import WorkspaceResolvedProfilePanel from "./WorkspaceResolvedProfilePanel.vue";
import { useWorkspacesViewContext } from "@meshrix/ui-console/workspaces-view-context";

const { selected, workspaceExpansionSlotId } = useWorkspacesViewContext();
</script>

<template>
  <Teleport v-if="selected" :to="`#${workspaceExpansionSlotId(selected)}`">
    <div class="ws-card-expanded">
      <div class="workspace-detail-body">
        <WorkspaceExpandedOverview />
        <WorkspaceCheckpointPanel />
        <WorkspaceResolvedProfilePanel />
        <WorkspaceDeleteAction />
      </div>
    </div>
  </Teleport>
</template>
