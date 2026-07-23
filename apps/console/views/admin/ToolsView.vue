<script setup lang="ts">
import { computed, ref } from "vue";
import { useServerConsoleShellContext } from '../../composables/serverConsoleShellContext';
import ToolAuditCard from './tools/ToolAuditCard.vue';
import ToolCatalogDetailPane from './tools/ToolCatalogDetailPane.vue';
import ToolCatalogIndexPane from './tools/ToolCatalogIndexPane.vue';
import ToolCatalogSearch from './tools/ToolCatalogSearch.vue';
import ToolGovernancePanel from './tools/ToolGovernancePanel.vue';
import ToolUsageStatsCard from './tools/ToolUsageStatsCard.vue';

const {
  adminView,
  operationPermissionConsole,
} = useServerConsoleShellContext();

const {
  activeOperationPermissionToolCount = computed(() => 0),
  busyKey = ref(""),
  defaultAgentToolCount = computed(() => 0),
  internalOperationPermissionToolCount = computed(() => 0),
  policyPreviewGrantId = ref(""),
  policyPreviewProfileId = ref(""),
  policyPreviewProfileOptionBarOptions = ref([]),
  policyPreviewResult = ref(null),
  policyPreviewToolId = ref(""),
  policyPreviewToolOptionBarOptions = ref([]),
  previewToolPolicy = async () => undefined,
  refreshOperationPermission = async () => undefined,
  selectToolForManagement = () => undefined,
  selectedOperationPermissionToolId = ref(""),
  selectedOperationPermissionToolset = ref(null),
  selectedOperationPermissionToolsetId = ref(""),
  selectedOperationPermissionToolsetTools = ref([]),
  selectOperationPermissionToolset = () => undefined,
  toolGrants = ref([]),
  operationPermissionAuditItems = ref([]),
  operationPermissionCatalogState = ref(null),
  operationPermissionMetricsState = ref(null),
  operationPermissionProfiles = ref([]),
  operationPermissionRiskRows = ref([]),
  operationPermissionStatusRows = ref([]),
  operationPermissionToolGroups = ref([]),
  operationPermissionTools = ref([]),
  operationPermissionToolsets = ref([]),
  toolScopes = ref([]),
} = operationPermissionConsole;

const isCatalogView = computed(() => adminView.value === "toolList" || adminView.value === "tools");
const isGovernanceView = computed(() => adminView.value === "toolGovernance");
const isStatsView = computed(() => adminView.value === "toolStats");
</script>

<template>
  <section class="tools-layout">
    <template v-if="isCatalogView">
      <article class="tool-catalog-workspace">
        <div class="section-header tool-catalog-meta-bar">
          <div class="section-tags">
            <span>目录指纹 {{ operationPermissionCatalogState?.fingerprint?.slice(0, 12) || "未加载" }}</span>
            <span>工具集 {{ operationPermissionToolGroups.length }}</span>
            <span>原子工具 {{ operationPermissionTools.length }}</span>
            <span>默认 {{ defaultAgentToolCount }}</span>
            <span>内部 {{ internalOperationPermissionToolCount }}</span>
          </div>
          <ToolCatalogSearch
            :tools="operationPermissionTools"
            :toolsets="operationPermissionToolsets"
            :tool-scopes="toolScopes"
            :selected-toolset-id="selectedOperationPermissionToolsetId"
            :selected-tool-id="selectedOperationPermissionToolId"
            @select-toolset="selectOperationPermissionToolset"
            @select-tool="selectToolForManagement"
          />
        </div>

        <div class="tool-catalog-shell">
          <ToolCatalogIndexPane
            :groups="operationPermissionToolGroups"
            :selected-toolset-id="selectedOperationPermissionToolsetId"
            :tool-scopes="toolScopes"
            @select-toolset="selectOperationPermissionToolset"
          />
          <ToolCatalogDetailPane
            :toolset="selectedOperationPermissionToolset"
            :tools="selectedOperationPermissionToolsetTools"
            :selected-tool-id="selectedOperationPermissionToolId"
            :toolsets="operationPermissionToolsets"
            :tool-scopes="toolScopes"
            :groups-count="operationPermissionToolGroups.length"
          />
        </div>
      </article>
    </template>

    <ToolGovernancePanel
      v-else-if="isGovernanceView"
      v-model:policy-preview-tool-id="policyPreviewToolId"
      v-model:policy-preview-profile-id="policyPreviewProfileId"
      v-model:policy-preview-grant-id="policyPreviewGrantId"
      :profiles="operationPermissionProfiles"
      :grants="toolGrants"
      :tool-options="policyPreviewToolOptionBarOptions"
      :profile-options="policyPreviewProfileOptionBarOptions"
      :busy-key="busyKey"
      :preview-result="policyPreviewResult"
      @preview="previewToolPolicy"
    />

    <template v-else>
      <ToolUsageStatsCard
        :catalog-state="operationPermissionCatalogState"
        :active-tool-count="activeOperationPermissionToolCount"
        :tool-count="operationPermissionTools.length"
        :metrics-state="operationPermissionMetricsState"
        :status-rows="operationPermissionStatusRows"
        :risk-rows="operationPermissionRiskRows"
      />
      <ToolAuditCard :items="operationPermissionAuditItems" />
    </template>
  </section>
</template>
