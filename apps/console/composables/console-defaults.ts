import type {
  AgentSettings,
  ClientAlignmentState,
  DiscoveryConfig,
  SplitJobStatus,
} from "../lib/types";
import { clientAlignmentStateLabels } from "@meshrix/ui-console/console-client-display-utils";
import type { AdminView, AppView } from "../types/app";

export const systemLogPaginationConfig: Record<string, any> = {
  defaultPageSize: 20,
  maxPageSize: 100,
  pageSizeOptions: [10, 20, 50, 100],
};

export const emptySettings: AgentSettings = {
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
  executionSandbox: null,
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

export const alignmentStateLabels: any = clientAlignmentStateLabels as Record<ClientAlignmentState, string>;

export const moduleNameLabels: Record<string, string> = {
  storage: "存储",
};

export const moduleNameDescriptions: Record<string, string> = {
  storage: "公开平台的基础持久化能力。",
};

export const moduleGroupDefinitions: any[] = [
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
  workspaces: "工作空间",
  admin: "管理",
};
