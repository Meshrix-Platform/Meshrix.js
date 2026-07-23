import { computed, ref, type Ref } from "vue";
import {
  getOperationPermissionAudit,
  getOperationPermissionCatalog,
  getOperationPermissionGrants,
  getOperationPermissionMetrics,
  previewToolPolicy as previewToolPolicyApi,
  type OperationPermissionAuditItem,
  type OperationPermissionCatalog,
  type OperationPermissionGrant,
  type OperationPermissionMetrics,
  type OperationPermissionProfile,
  type OperationPermissionTool,
  type OperationPermissionToolGroup,
  type OperationPermissionToolset,
} from "../lib/operation-permission-client";
import type { OptionBarOption } from "../types/app";
import { createConsoleToolGrantsController } from "./console-tool-grants-controller";

type ConsoleOperationPermissionControllerOptions = {
  clearAllBusy: () => void;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleOperationPermissionController(
  options: ConsoleOperationPermissionControllerOptions,
) {
  const operationPermissionCatalogState = ref<OperationPermissionCatalog | null>(null);
  const operationPermissionGrantsState = ref<OperationPermissionGrant[]>([]);
  const operationPermissionMetricsState = ref<OperationPermissionMetrics | null>(null);
  const operationPermissionAuditItems = ref<OperationPermissionAuditItem[]>([]);
  const selectedOperationPermissionToolId = ref("lico.gateway.health");
  const policyPreviewToolId = ref("lico.gateway.health");
  const policyPreviewProfileId = ref("gateway-operator");
  const policyPreviewGrantId = ref("");
  const policyPreviewResult = ref<Record<string, unknown> | null>(null);
  const selectedOperationPermissionToolsetId = ref("");

  const toolScopes = computed(() => operationPermissionCatalogState.value?.scopes || []);
  const toolCatalog = computed(() => operationPermissionCatalogState.value?.tools || []);
  const operationPermissionTools = computed<OperationPermissionTool[]>(() => operationPermissionCatalogState.value?.tools || []);
  const operationPermissionToolsets = computed<OperationPermissionToolset[]>(
    () => operationPermissionCatalogState.value?.toolsets || [],
  );
  const operationPermissionProfiles = computed<OperationPermissionProfile[]>(
    () => operationPermissionCatalogState.value?.profiles || [],
  );
  const operationPermissionToolGroups = computed<OperationPermissionToolGroup[]>(() => {
    const catalogGroups = operationPermissionCatalogState.value?.toolGroups;
    if (catalogGroups?.length) {
      return catalogGroups;
    }
    const groups: OperationPermissionToolGroup[] = [];
    for (const toolset of operationPermissionToolsets.value) {
      const tools = operationPermissionTools.value.filter((tool) => tool.toolsets.includes(toolset.id));
      if (!tools.length) {
        continue;
      }
      groups.push({
        id: toolset.id,
        label: toolset.label || toolset.id,
        description: toolset.description || "",
        toolsetId: toolset.id,
        requiredScopes: toolset.requiredScopes || [],
        defaultForAgents: toolset.defaultForAgents === true,
        grantable: toolset.grantable !== false,
        maxRisk: tools.reduce(
          (max, tool) => (riskRank(tool.risk) > riskRank(max) ? tool.risk : max),
          "read_only",
        ),
        toolCount: tools.length,
        activeToolCount: tools.filter((tool) => tool.status === "active").length,
        internalToolCount: tools.filter((tool) => tool.status === "internal").length,
        writeToolCount: tools.filter((tool) => tool.readOnly === false).length,
        sampleToolIds: tools.slice(0, 6).map((tool) => tool.id),
      });
    }
    return groups.sort((left, right) => {
      if (left.defaultForAgents !== right.defaultForAgents) {
        return left.defaultForAgents ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
  });
  const activeOperationPermissionToolCount = computed(
    () => operationPermissionTools.value.filter((tool) => tool.status === "active").length,
  );
  const internalOperationPermissionToolCount = computed(
    () => operationPermissionTools.value.filter((tool) => tool.status === "internal").length,
  );
  const operationPermissionStatusRows = computed(() =>
    Object.entries(operationPermissionMetricsState.value?.byStatus || {}).map(([label, value]) => ({
      label,
      value,
    })),
  );
  const operationPermissionRiskRows = computed(() =>
    Object.entries(operationPermissionMetricsState.value?.byRisk || {}).map(([label, value]) => ({
      label,
      value,
    })),
  );
  const defaultAgentToolsetIds = computed(
    () => new Set(operationPermissionToolsets.value.filter((toolset) => toolset.defaultForAgents).map((toolset) => toolset.id)),
  );
  const defaultAgentToolCount = computed(
    () => operationPermissionTools.value.filter((tool) => tool.toolsets.some((toolset) => defaultAgentToolsetIds.value.has(toolset))).length,
  );
  const selectedOperationPermissionToolset = computed(
    () => operationPermissionToolGroups.value.find((group) => group.id === selectedOperationPermissionToolsetId.value) || null,
  );
  const selectedOperationPermissionToolsetTools = computed<OperationPermissionTool[]>(() => {
    if (!selectedOperationPermissionToolsetId.value) {
      return [];
    }
    return operationPermissionTools.value.filter((tool) => tool.toolsets.includes(selectedOperationPermissionToolsetId.value));
  });

  function riskRank(risk = "read_only") {
    const ranks: Record<string, number> = {
      read_only: 0,
      safe_write: 1,
      repair_write: 2,
      destructive: 3,
    };
    return ranks[String(risk || "read_only")] ?? ranks.read_only;
  }

  const selectedOperationPermissionTool = computed(() => {
    const selectedId = selectedOperationPermissionToolId.value || policyPreviewToolId.value;
    return operationPermissionTools.value.find((tool) => tool.id === selectedId) || operationPermissionTools.value[0] || null;
  });

  const policyPreviewCandidateTools = computed(() => {
    if (selectedOperationPermissionToolsetTools.value.length > 0) {
      return selectedOperationPermissionToolsetTools.value;
    }
    const profile = operationPermissionProfiles.value.find((item) => item.id === policyPreviewProfileId.value);
    const profileToolsets = new Set(profile?.toolsets || []);
    const profileAllow = new Set(profile?.toolAllow || []);
    const profileDeny = new Set(profile?.toolDeny || []);
    const baseTools = profileToolsets.size > 0
      ? operationPermissionTools.value.filter((tool) => tool.toolsets.some((toolset) => profileToolsets.has(toolset)))
      : operationPermissionTools.value.filter((tool) => tool.toolsets.some((toolset) => defaultAgentToolsetIds.value.has(toolset)));
    return baseTools.filter((tool) => {
      if (profileDeny.has(tool.id)) {
        return false;
      }
      if (profileAllow.size > 0 && !profileAllow.has(tool.id)) {
        return false;
      }
      return true;
    });
  });

  const policyPreviewToolOptionBarOptions = computed<OptionBarOption[]>(() =>
    policyPreviewCandidateTools.value.map((tool) => ({
      value: tool.id,
      label: `${tool.label} / ${tool.id}`,
    })),
  );

  const policyPreviewProfileOptionBarOptions = computed<OptionBarOption[]>(() => [
    { value: "", label: "不绑定档案" },
    ...operationPermissionProfiles.value.map((profile) => ({
      value: profile.id,
      label: `${profile.label} / ${profile.id}`,
    })),
  ]);

  function previewToolDefinition() {
    return operationPermissionTools.value.find((tool) => tool.id === policyPreviewToolId.value) || null;
  }

  function selectToolForManagement(toolId: string) {
    selectedOperationPermissionToolId.value = toolId;
    policyPreviewToolId.value = toolId;
  }

  function selectOperationPermissionToolset(toolsetId: string) {
    selectedOperationPermissionToolsetId.value = toolsetId;
    const firstTool = selectedOperationPermissionToolsetTools.value[0] || null;
    if (firstTool) {
      selectToolForManagement(firstTool.id);
    }
  }

  function ensureSelectedOperationPermissionToolset() {
    const groups = operationPermissionToolGroups.value;
    if (groups.length === 0) {
      selectedOperationPermissionToolsetId.value = "";
      return;
    }

    const selectedGroupStillExists = groups.some((group) => group.id === selectedOperationPermissionToolsetId.value);
    if (!selectedGroupStillExists) {
      selectedOperationPermissionToolsetId.value = groups[0].id;
    }

    const visibleTools = selectedOperationPermissionToolsetTools.value;
    if (visibleTools.length === 0) {
      return;
    }
    const selectedToolStillVisible = visibleTools.some((tool) => tool.id === selectedOperationPermissionToolId.value);
    if (!selectedToolStillVisible) {
      selectToolForManagement(visibleTools[0].id);
    }
  }

  function policyPreviewGrant() {
    const tool = previewToolDefinition();
    return {
      id: "console-preview-grant",
      label: "Console preview grant",
      enabled: true,
      scopes: tool?.requiredScopes || [],
      toolsets: tool?.toolsets || [],
      toolAllow: [],
      toolDeny: [],
      metadata: {},
    };
  }

  async function refreshOperationPermission(optionsArg: { silent?: boolean } = {}) {
    const showBusy = !optionsArg.silent;
    if (showBusy) {
      options.setBusy("operation-permission");
    }
    options.error.value = "";

    try {
      const [grants, catalog, audit, metrics] = await Promise.all([
        getOperationPermissionGrants(),
        getOperationPermissionCatalog(),
        getOperationPermissionAudit(50),
        getOperationPermissionMetrics(),
      ]);
      operationPermissionGrantsState.value = grants.grants;
      operationPermissionCatalogState.value = catalog;
      operationPermissionAuditItems.value = audit.items;
      operationPermissionMetricsState.value = metrics.metrics;
      if (!policyPreviewToolId.value && catalog.tools.length > 0) {
        policyPreviewToolId.value = catalog.tools[0].id;
      }
      if (!selectedOperationPermissionToolId.value && catalog.tools.length > 0) {
        selectedOperationPermissionToolId.value = catalog.tools[0].id;
      }
      ensureSelectedOperationPermissionToolset();
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新智能体工具失败。";
    } finally {
      if (showBusy) {
        options.clearAllBusy();
      }
    }
  }

  const {
    copyIssuedToolToken,
    createGrant,
    deleteGrant,
    enabledToolGrantCount,
    grantHasScope,
    grantHasToolset,
    grantToolRuleState,
    issuedToolToken,
    newGrantLabel,
    newGrantScopes,
    newGrantToolsets,
    rotateGrant,
    setGrantToolRule,
    toggleGrantScope,
    toggleGrantToolset,
    toggleNewGrantScope,
    toggleNewGrantToolset,
    toolGrants,
    updateGrant,
  } = createConsoleToolGrantsController({
    clearAllBusy: options.clearAllBusy,
    error: options.error,
    refreshOperationPermission,
    setBusy: options.setBusy,
    operationPermissionGrantsState,
  });

  async function previewToolPolicy() {
    if (!policyPreviewToolId.value) {
      options.error.value = "请选择需要预览的工具。";
      return;
    }
    options.setBusy("tool-policy-preview");
    options.error.value = "";
    try {
      const payload: Record<string, unknown> = {
        toolId: policyPreviewToolId.value,
        input: {},
        dryRun: false,
      };
      if (policyPreviewGrantId.value.trim()) {
        payload.grantId = policyPreviewGrantId.value.trim();
      } else {
        payload.grant = policyPreviewGrant();
      }
      if (policyPreviewProfileId.value.trim()) {
        payload.profileId = policyPreviewProfileId.value.trim();
      }
      policyPreviewResult.value = await previewToolPolicyApi(payload);
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "工具策略预览失败。";
    } finally {
      options.clearAllBusy();
    }
  }

  return {
    activeOperationPermissionToolCount,
    copyIssuedToolToken,
    createGrant,
    deleteGrant,
    defaultAgentToolCount,
    enabledToolGrantCount,
    grantHasScope,
    grantHasToolset,
    grantToolRuleState,
    internalOperationPermissionToolCount,
    issuedToolToken,
    newGrantLabel,
    newGrantScopes,
    newGrantToolsets,
    policyPreviewGrant,
    policyPreviewGrantId,
    policyPreviewProfileId,
    policyPreviewProfileOptionBarOptions,
    policyPreviewResult,
    policyPreviewToolId,
    policyPreviewToolOptionBarOptions,
    previewToolDefinition,
    previewToolPolicy,
    refreshOperationPermission,
    selectedOperationPermissionToolset,
    selectedOperationPermissionToolsetId,
    selectedOperationPermissionToolsetTools,
    selectOperationPermissionToolset,
    rotateGrant,
    selectToolForManagement,
    selectedOperationPermissionTool,
    selectedOperationPermissionToolId,
    setGrantToolRule,
    toggleGrantScope,
    toggleGrantToolset,
    toggleNewGrantScope,
    toggleNewGrantToolset,
    toolCatalog,
    toolGrants,
    operationPermissionAuditItems,
    operationPermissionCatalogState,
    operationPermissionGrantsState,
    operationPermissionMetricsState,
    operationPermissionProfiles,
    operationPermissionRiskRows,
    operationPermissionStatusRows,
    operationPermissionToolGroups,
    operationPermissionTools,
    operationPermissionToolsets,
    toolScopes,
    updateGrant,
  };
}
