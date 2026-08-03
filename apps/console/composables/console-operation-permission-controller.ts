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
  clearBusy: (key: string) => void;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleOperationPermissionController(
  options: ConsoleOperationPermissionControllerOptions,
) : any {
  const operationPermissionCatalogState: any = ref<OperationPermissionCatalog | null>(null);
  const operationPermissionGrantsState: any = ref<OperationPermissionGrant[]>([]);
  const operationPermissionMetricsState: any = ref<OperationPermissionMetrics | null>(null);
  const operationPermissionAuditItems: any = ref<OperationPermissionAuditItem[]>([]);
  const selectedOperationPermissionToolId: any = ref("meshrix.gateway.health");
  const policyPreviewToolId: any = ref("meshrix.gateway.health");
  const policyPreviewProfileId: any = ref("gateway-operator");
  const policyPreviewGrantId: any = ref("");
  const policyPreviewResult: any = ref<Record<string, unknown> | null>(null);
  const selectedOperationPermissionToolsetId: any = ref("");

  const toolScopes: any = computed(() : any => operationPermissionCatalogState.value?.scopes || []);
  const toolCatalog: any = computed(() : any => operationPermissionCatalogState.value?.tools || []);
  const operationPermissionTools: any = computed<OperationPermissionTool[]>(() : any => operationPermissionCatalogState.value?.tools || []);
  const operationPermissionToolsets: any = computed<OperationPermissionToolset[]>(
    () : any => operationPermissionCatalogState.value?.toolsets || [],
  );
  const operationPermissionProfiles: any = computed<OperationPermissionProfile[]>(
    () : any => operationPermissionCatalogState.value?.profiles || [],
  );
  const operationPermissionToolGroups: any = computed<OperationPermissionToolGroup[]>(() : any => {
    const catalogGroups: any = operationPermissionCatalogState.value?.toolGroups;
    if (catalogGroups?.length) {
      return catalogGroups;
    }
    const groups: OperationPermissionToolGroup[] = [];
    for (const toolset of operationPermissionToolsets.value) {
      const tools: any = operationPermissionTools.value.filter((tool?: any) : any => tool.toolsets.includes(toolset.id));
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
          (max?: any, tool?: any) : any => (riskRank(tool.risk) > riskRank(max) ? tool.risk : max),
          "read_only",
        ),
        toolCount: tools.length,
        activeToolCount: tools.filter((tool?: any) : any => tool.status === "active").length,
        internalToolCount: tools.filter((tool?: any) : any => tool.status === "internal").length,
        writeToolCount: tools.filter((tool?: any) : any => tool.readOnly === false).length,
        sampleToolIds: tools.slice(0, 6).map((tool?: any) : any => tool.id),
      });
    }
    return groups.sort((left?: any, right?: any) : any => {
      if (left.defaultForAgents !== right.defaultForAgents) {
        return left.defaultForAgents ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
  });
  const activeOperationPermissionToolCount: any = computed(
    () : any => operationPermissionTools.value.filter((tool?: any) : any => tool.status === "active").length,
  );
  const internalOperationPermissionToolCount: any = computed(
    () : any => operationPermissionTools.value.filter((tool?: any) : any => tool.status === "internal").length,
  );
  const operationPermissionStatusRows: any = computed(() : any =>
    (Object.entries(operationPermissionMetricsState.value?.byStatus || {}) as [string, any][]).map(([label, value]: any[]) : any => ({
      label,
      value,
    })),
  );
  const operationPermissionRiskRows: any = computed(() : any =>
    (Object.entries(operationPermissionMetricsState.value?.byRisk || {}) as [string, any][]).map(([label, value]: any[]) : any => ({
      label,
      value,
    })),
  );
  const defaultAgentToolsetIds: any = computed(
    () : any => new Set<any>(operationPermissionToolsets.value.filter((toolset?: any) : any => toolset.defaultForAgents).map((toolset?: any) : any => toolset.id)),
  );
  const defaultAgentToolCount: any = computed(
    () : any => operationPermissionTools.value.filter((tool?: any) : any => tool.toolsets.some((toolset?: any) : any => defaultAgentToolsetIds.value.has(toolset))).length,
  );
  const selectedOperationPermissionToolset: any = computed(
    () : any => operationPermissionToolGroups.value.find((group?: any) : any => group.id === selectedOperationPermissionToolsetId.value) || null,
  );
  const selectedOperationPermissionToolsetTools: any = computed<OperationPermissionTool[]>(() : any => {
    if (!selectedOperationPermissionToolsetId.value) {
      return [];
    }
    return operationPermissionTools.value.filter((tool?: any) : any => tool.toolsets.includes(selectedOperationPermissionToolsetId.value));
  });

  function riskRank(risk: any = "read_only") : any {
    const ranks: Record<string, number> = {
      read_only: 0,
      safe_write: 1,
      repair_write: 2,
      destructive: 3,
    };
    return ranks[String(risk || "read_only")] ?? ranks.read_only;
  }

  const selectedOperationPermissionTool: any = computed(() : any => {
    const selectedId: any = selectedOperationPermissionToolId.value || policyPreviewToolId.value;
    return operationPermissionTools.value.find((tool?: any) : any => tool.id === selectedId) || operationPermissionTools.value[0] || null;
  });

  const policyPreviewCandidateTools: any = computed(() : any => {
    if (selectedOperationPermissionToolsetTools.value.length > 0) {
      return selectedOperationPermissionToolsetTools.value;
    }
    const profile: any = operationPermissionProfiles.value.find((item?: any) : any => item.id === policyPreviewProfileId.value);
    const profileToolsets: any = new Set<any>(profile?.toolsets || []);
    const profileAllow: any = new Set<any>(profile?.toolAllow || []);
    const profileDeny: any = new Set<any>(profile?.toolDeny || []);
    const baseTools: any = profileToolsets.size > 0
      ? operationPermissionTools.value.filter((tool?: any) : any => tool.toolsets.some((toolset?: any) : any => profileToolsets.has(toolset)))
      : operationPermissionTools.value.filter((tool?: any) : any => tool.toolsets.some((toolset?: any) : any => defaultAgentToolsetIds.value.has(toolset)));
    return baseTools.filter((tool?: any) : any => {
      if (profileDeny.has(tool.id)) {
        return false;
      }
      if (profileAllow.size > 0 && !profileAllow.has(tool.id)) {
        return false;
      }
      return true;
    });
  });

  const policyPreviewToolOptionBarOptions: any = computed<OptionBarOption[]>(() : any =>
    policyPreviewCandidateTools.value.map((tool?: any) : any => ({
      value: tool.id,
      label: `${tool.label} / ${tool.id}`,
    })),
  );

  const policyPreviewProfileOptionBarOptions: any = computed<OptionBarOption[]>(() : any => [
    { value: "", label: "不绑定档案" },
    ...operationPermissionProfiles.value.map((profile?: any) : any => ({
      value: profile.id,
      label: `${profile.label} / ${profile.id}`,
    })),
  ]);

  function previewToolDefinition() : any {
    return operationPermissionTools.value.find((tool?: any) : any => tool.id === policyPreviewToolId.value) || null;
  }

  function selectToolForManagement(toolId: string) : any {
    selectedOperationPermissionToolId.value = toolId;
    policyPreviewToolId.value = toolId;
  }

  function selectOperationPermissionToolset(toolsetId: string) : any {
    selectedOperationPermissionToolsetId.value = toolsetId;
    const firstTool: any = selectedOperationPermissionToolsetTools.value[0] || null;
    if (firstTool) {
      selectToolForManagement(firstTool.id);
    }
  }

  function ensureSelectedOperationPermissionToolset() : any {
    const groups: any = operationPermissionToolGroups.value;
    if (groups.length === 0) {
      selectedOperationPermissionToolsetId.value = "";
      return;
    }

    const selectedGroupStillExists: any = groups.some((group?: any) : any => group.id === selectedOperationPermissionToolsetId.value);
    if (!selectedGroupStillExists) {
      selectedOperationPermissionToolsetId.value = groups[0].id;
    }

    const visibleTools: any = selectedOperationPermissionToolsetTools.value;
    if (visibleTools.length === 0) {
      return;
    }
    const selectedToolStillVisible: any = visibleTools.some((tool?: any) : any => tool.id === selectedOperationPermissionToolId.value);
    if (!selectedToolStillVisible) {
      selectToolForManagement(visibleTools[0].id);
    }
  }

  function policyPreviewGrant() : any {
    const tool: any = previewToolDefinition();
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

  async function refreshOperationPermission(optionsArg: { silent?: boolean } = {}) : Promise<any> {
    const showBusy: any = !optionsArg.silent;
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
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "刷新智能体工具失败。";
    } finally {
      if (showBusy) {
        options.clearBusy("operation-permission");
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
    clearBusy: options.clearBusy,
    error: options.error,
    refreshOperationPermission,
    setBusy: options.setBusy,
    operationPermissionGrantsState,
  });

  async function previewToolPolicy() : Promise<any> {
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
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "工具策略预览失败。";
    } finally {
      options.clearBusy("tool-policy-preview");
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
