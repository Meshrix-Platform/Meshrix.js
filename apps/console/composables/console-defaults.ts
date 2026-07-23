import type {
  AgentSettings,
  ClientAlignmentState,
  DiscoveryConfig,
  SplitJobStatus,
} from "../lib/types";
import { clientAlignmentStateLabels } from "@lico/ui-console/console-client-display-utils";
import type { AdminView, AppView, CloudProvider } from "../types/app";
import { MODEL_USAGE_DEFINITIONS } from "@lico/contracts/modules/model-usage";

export const modelLibraryProviderDefinitions: Array<{
  id: CloudProvider;
  label: string;
  description: string;
}> = [
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "OpenAI-compatible Chat Completions，API Key 由服务端代理使用。",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "OpenRouter API Key、Base URL 与模型 ID。",
  },
  {
    id: "openai",
    label: "OpenAI API",
    description: "OpenAI Chat Completions API；端点、模型与凭据均由当前智能体显式配置。",
  },
  {
    id: "copilot",
    label: "Copilot / 企业代理",
    description: "企业代理或兼容 Chat Completions 的内部模型服务。",
  },
  {
    id: "local-model",
    label: "本地模型服务",
    description: "本机或局域网内的模型服务 Endpoint。",
  },
];

export const systemLogPaginationConfig = {
  defaultPageSize: 20,
  maxPageSize: 100,
  pageSizeOptions: [10, 20, 50, 100],
};

export type IntelligentModuleDefinition = {
  id: string;
  label: string;
  designedModule: string;
  description: string;
  alertRequired?: boolean;
};

export const intelligentModuleDefinitions: IntelligentModuleDefinition[] = MODEL_USAGE_DEFINITIONS.map((definition) => ({
  id: definition.id,
  label: definition.label,
  designedModule: definition.designedModule,
  description: definition.description,
  alertRequired: definition.alertRequired,
}));

export const emptySettings: AgentSettings = {
  modelIntelligenceEnabled: false,
  defaultModelProvider: "",
  defaultModel: "",
  modelLibraryEntries: [],
  modelLibraryAgents: [],
  modelLibraryRevision: 0,
  gatewayAssistantDefaults: {
    systemPrompt: "",
    toolPolicyPrompt: "",
    continuationPrompt: "",
    answerTemplate: "",
    contextProfileId: "",
    thinkingMode: "",
    temperature: 0,
    maxTokens: 0,
    maxIterations: 0,
    limit: 0,
    toolChoice: "",
    gatewayReviewModelAlias: "",
    ruleAuthoringModelAlias: "",
    reviewFusionModelAlias: "",
    reviewFusionSystemPrompt: "",
    reviewFusionTemperature: 0,
    reviewFusionMaxTokens: 0,
  },
  agentToolExecution: {
    functionCallSchema: {},
    http: {
      enabled: false,
      allowedHosts: [],
      timeoutMs: 0,
      maxResponseBytes: 0,
    },
    local: {
      enabled: false,
      allowDirectCommands: false,
      timeoutMs: 0,
      maxOutputBytes: 0,
      nodeCommand: "",
      commands: [],
    },
  },
  moduleModelAssignments: {},
  moduleAgentProfiles: {},
  moduleIntelligence: {},
};

export const emptyDiscovery: DiscoveryConfig = {
  serverId: "",
  serverLabel: "",
  bootstrapBaseUrl: "",
  advertisedBaseUrl: "",
  activeServiceUrl: "",
  forwardBaseUrl: "",
  mode: "",
  configVersion: "",
  refreshIntervalSeconds: 0,
  checkInIntervalSeconds: 0,
  offlineAfterSeconds: 0,
};

export const jobStatusLabels: Record<SplitJobStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const alignmentStateLabels = clientAlignmentStateLabels as Record<ClientAlignmentState, string>;

export const moduleNameLabels: Record<string, string> = {
  storage: "存储",
};

export const moduleNameDescriptions: Record<string, string> = {
  storage: "公开平台的基础持久化能力。",
};

export const moduleGroupDefinitions = [
  {
    id: "storage",
    label: "存储管理",
    description: "公开平台的通用持久化和元数据模块。",
    names: ["storage"],
  },
];

export const adminViewTitleMap: Partial<Record<AdminView, string>> = {
  jobs: "工作队列",
  logs: "日志记录",
  tools: "工具列表",
  toolList: "工具列表",
  toolGovernance: "工具治理",
  toolStats: "工具统计",
  operationPermission: "工具权限",
  agentConfig: "大模型配置",
  agentAssignment: "智能体分配",
  contextManagement: "上下文管理",
  maintenanceAgent: "智能巡检",
  opsMonitor: "运维监控",
  strategyManagement: "策略管理",
  tagManagement: "标签管理",
  versionRelease: "版本发布",
  versionAssembly: "版本装配",
  productionHealth: "交付门禁",
  storage: "运行状态",
  modules: "模块管理",
};

export const viewTitleMap: Record<AppView, string> = {
  dashboard: "工作台",
  approval: "审批流",
  workspaces: "工作树",
  admin: "管理",
};
