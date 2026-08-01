import { computed, type ComputedRef, type Ref } from "vue";
import { intelligentModuleDefinitions } from "./console-defaults";
import type { AgentModelConfig, AgentSettings } from "../lib/types";
import type { AgentConfigurationAlert } from "../types/app";

export type DashboardAgentOption = {
  value: string;
  label?: string;
  enabled: boolean;
  disabledReason?: string;
  ref?: string;
};

type DashboardConfigurationAlertControllerOptions = {
  gatewayAssistantAgentOptions: ComputedRef<DashboardAgentOption[]>;
  gatewayAssistantForm: Ref<{ modelAlias?: string }>;
  agentModelAssignmentOptions: ComputedRef<DashboardAgentOption[]>;
  agentSelectorOptions: ComputedRef<DashboardAgentOption[]>;
  moduleModelRef: (moduleId: string) => string;
  moduleNeedsIntelligence: (moduleId: string) => boolean;
  ruleAuthoringForm: Ref<{ modelAlias?: string }>;
  ruleAuthoringModelOptions: ComputedRef<DashboardAgentOption[]>;
  settingsDraft: Ref<AgentSettings>;
  visibleModelEntries: ComputedRef<AgentModelConfig[]>;
};

type AgentSelectionAlertParams = {
  alertId: string;
  category: string;
  title: string;
  detail: string;
  value: string;
  options: DashboardAgentOption[];
  view?: AgentConfigurationAlert["view"];
  adminView?: AgentConfigurationAlert["adminView"];
  targetId?: string;
};

function agentSelectionAlert(params: AgentSelectionAlertParams): AgentConfigurationAlert | null {
  const value: any = String(params.value || "").trim();
  if (!value) {
    return {
      alertId: params.alertId,
      category: params.category,
      title: params.title,
      detail: params.detail,
      status: "未配置智能体",
      tone: "warning",
      view: params.view,
      adminView: params.adminView,
      targetId: params.targetId,
    };
  }
  const option: any = params.options.find((item?: any) : any => item.value === value);
  if (!option?.enabled) {
    return {
      alertId: params.alertId,
      category: params.category,
      title: params.title,
      detail: option?.disabledReason
        ? `${params.detail} 当前选择不可用：${option.disabledReason}。`
        : `${params.detail} 当前选择已不在模型库或尚未完成授权。`,
      status: "智能体不可用",
      tone: "danger",
      view: params.view,
      adminView: params.adminView,
      targetId: params.targetId,
    };
  }
  return null;
}

export function createConsoleDashboardConfigurationAlertController(
  options: DashboardConfigurationAlertControllerOptions,
) : any {
  const agentConfigurationAlerts: any = computed<AgentConfigurationAlert[]>(() : any => {
    const alerts: AgentConfigurationAlert[] = [];
    if (options.visibleModelEntries.value.length === 0) {
      alerts.push({
        alertId: "model-library-empty",
        category: "模型库",
        title: "模型库为空",
        detail: "需要先新增至少一个智能体模型，后续功能和模块才能显式绑定。",
        status: "无可用智能体",
        tone: "danger",
        view: "admin",
        adminView: "agentConfig",
        targetId: "agent-model-library",
      });
    }
    for (const item of [
      agentSelectionAlert({
        alertId: "gateway-assistant-agent",
        category: "服务网关",
        title: "网关审计智能体",
        detail: "网关审计需要一个可用智能体来规划工具调用和打开证据。",
        value: options.settingsDraft.value.gatewayAssistantDefaults?.gatewayReviewModelAlias || options.gatewayAssistantForm.value.modelAlias || "",
        options: options.gatewayAssistantAgentOptions.value,
        view: "admin",
        adminView: "agentAssignment",
        targetId: "gateway-assistant-agent",
      }),
      agentSelectionAlert({
        alertId: "rule-authoring-agent",
        category: "工作台",
        title: "创建规则智能体",
        detail: "创建规则的智能对话模式需要一个可用智能体辅助生成规则草稿。",
        value: options.settingsDraft.value.gatewayAssistantDefaults?.ruleAuthoringModelAlias || options.ruleAuthoringForm.value.modelAlias || "",
        options: options.ruleAuthoringModelOptions.value,
        view: "admin",
        adminView: "agentAssignment",
        targetId: "rule-authoring-agent",
      }),
      agentSelectionAlert({
        alertId: "approval-flow-agent",
        category: "网关治理",
        title: "审批合并智能体",
        detail: "审批合并分析需要显式绑定一个可用智能体，用于合并多路审计线索与结构化结果。",
        value: options.settingsDraft.value.gatewayAssistantDefaults?.reviewFusionModelAlias || "",
        options: options.agentSelectorOptions.value,
        view: "admin",
        adminView: "agentAssignment",
        targetId: "approval-flow-agent",
      }),
    ]) {
      if (item) {
        alerts.push(item);
      }
    }
    for (const moduleDefinition of intelligentModuleDefinitions) {
      if (!options.moduleNeedsIntelligence(moduleDefinition.id)) {
        continue;
      }
      const refValue: any = options.moduleModelRef(moduleDefinition.id);
      const option: any = options.agentModelAssignmentOptions.value.find((item?: any) : any => item.ref === refValue);
      if (!refValue) {
        if (moduleDefinition.alertRequired === false) {
          continue;
        }
        alerts.push({
          alertId: `module:${moduleDefinition.id}`,
          category: "模块模型分配",
          title: moduleDefinition.label,
          detail: moduleDefinition.description,
          status: "未配置智能体",
          tone: "warning",
          view: "admin",
          adminView: "agentAssignment",
          targetId: `module-agent-${moduleDefinition.id}`,
        });
        continue;
      }
      if (!option?.enabled) {
        alerts.push({
          alertId: `module:${moduleDefinition.id}`,
          category: "模块模型分配",
          title: moduleDefinition.label,
          detail: `${moduleDefinition.description} 当前绑定的智能体不可用或未完成授权。`,
          status: "智能体不可用",
          tone: "danger",
          view: "admin",
          adminView: "agentAssignment",
          targetId: `module-agent-${moduleDefinition.id}`,
        });
      }
    }
    return alerts;
  });

  const agentConfigurationAlertSummary: any = computed(() : any => {
    const dangerCount: any = agentConfigurationAlerts.value.filter((item?: any) : any => item.tone === "danger").length;
    const warningCount: any = agentConfigurationAlerts.value.length - dangerCount;
    if (agentConfigurationAlerts.value.length === 0) {
      return "所有需要智能体的功能都已显式绑定可用智能体。";
    }
    return [
      dangerCount ? `${dangerCount} 项不可用` : "",
      warningCount ? `${warningCount} 项未配置` : "",
    ].filter(Boolean).join("，");
  });

  return {
    agentConfigurationAlertSummary,
    agentConfigurationAlerts,
  };
}
