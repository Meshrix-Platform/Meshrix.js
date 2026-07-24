export type AgentSettings = {
  modelIntelligenceEnabled: boolean;
  defaultModelProvider: string;
  defaultModel: string;
  modelLibraryEntries: string[];
  modelLibraryAgentIds?: string[];
  modelLibraryAgents: AgentModelConfig[];
  modelLibraryRevision: number;
  gatewayAssistantDefaults: GatewayAssistantDefaults;
  agentToolExecution: AgentToolExecutionConfig;
  moduleModelAssignments: Record<string, { provider: string; model: string }>;
  moduleAgentProfiles: Record<string, ModuleAgentProfileGroup>;
  moduleIntelligence: Record<string, boolean>;
  gatewayTargets?: GatewayTarget[];
};

export type GatewayTargetKind = "global";

export type GatewayTarget = {
  kind: GatewayTargetKind;
  label: string;
  provider?: string;
  refs?: string[];
};

export type ModelProbeResponse = {
  ok: boolean;
  configured: boolean;
  provider: string;
  model: string;
  statusCode: number;
  latencyMs: number;
  checkedAt: string;
  message: string;
  answerSnippet?: string;
};

export type AgentGatewayConfig = {
  alias: string;
  label?: string;
  url: string;
  token: string;
  tokenConfigured?: boolean;
  tokenHeader: string;
  tokenPrefix: string;
  agentName: string;
  pluginList: string[];
  engine: string;
  parameters: Record<string, unknown>;
  timeoutMs: number;
};

export type AgentModelConfig = {
  uid?: string;
  instanceId: string;
  provider: string;
  alias: string;
  label?: string;
  baseUrl?: string;
  url?: string;
  model: string;
  apiKey?: string;
  apiKeyConfigured?: boolean;
  token?: string;
  tokenConfigured?: boolean;
  tokenHeader?: string;
  tokenPrefix?: string;
  agentName?: string;
  pluginList?: string[];
  engine?: string;
  systemPrompt?: string;
  parameters?: Record<string, unknown>;
  moduleAccess?: AgentModuleAccess;
  timeoutMs?: number;
  parametersText?: string;
};

export type AgentSelectorOption = {
  agentUid: string;
  value: string;
  label: string;
  provider: string;
  model: string;
  moduleIds: string[];
  capabilities: string[];
  status: "available" | "unconfigured" | "unsupported";
  selectable: boolean;
  reason?: string;
};

export type AgentSelectorState = {
  schemaVersion: string;
  source: string;
  updatedAt: string;
  options: AgentSelectorOption[];
};

export type AgentConfigManifestEntry = {
  id: string;
  file: string;
  label: string;
  enabled: boolean;
};

export type AgentConfigManifest = {
  schemaVersion: string;
  kind: string;
  updatedAt: string;
  entries: AgentConfigManifestEntry[];
};

export type AgentConfigState = {
  generation: string;
  revision: number;
  modelManifest: AgentConfigManifest;
  agentManifest: AgentConfigManifest;
};

export type AgentModuleAccess = {
  mode: "all" | "selected";
  moduleIds: string[];
};

export type ModuleAgentProfile = {
  enabled: boolean;
  role: string;
  contextProfileId: string;
  systemPrompt: string;
  parameters: Record<string, unknown>;
  parametersText?: string;
  dependencyContext: Record<string, unknown>;
  dependencyContextText?: string;
};

export type ModuleAgentProfileGroup = {
  primaryAgent: string;
  agents: Record<string, ModuleAgentProfile>;
};

export type GatewayAssistantDefaults = {
  systemPrompt: string;
  toolPolicyPrompt: string;
  continuationPrompt: string;
  answerTemplate: string;
  contextProfileId: string;
  thinkingMode: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  limit: number;
  toolChoice: string;
  gatewayReviewModelAlias?: string;
  ruleAuthoringModelAlias?: string;
  reviewFusionModelAlias?: string;
  reviewFusionSystemPrompt?: string;
  reviewFusionTemperature?: number;
  reviewFusionMaxTokens?: number;
};

export type AgentToolExecutionConfig = {
  functionCallSchema?: Record<string, unknown>;
  http: {
    enabled: boolean;
    allowedHosts: string[];
    timeoutMs: number;
    maxResponseBytes: number;
  };
  local: {
    enabled: boolean;
    allowDirectCommands: boolean;
    timeoutMs: number;
    maxOutputBytes: number;
    nodeCommand?: string;
    commands: Array<{
      commandId: string;
      label: string;
      command: string;
      args: string[];
      cwd: string;
      description: string;
      variables?: Array<{
        name: string;
        label?: string;
        required?: boolean;
        defaultValue?: string;
        allowedValues?: string[];
        description?: string;
      }>;
      allowExtraArgs?: boolean;
    }>;
  };
};

export type AgentRegistryItem = {
  alias: string;
  model: string;
  provider: string;
  label: string;
  callMode: string;
  serverHttpPath: string;
  serverRpcMethod: string;
  urlConfigured: boolean;
  tokenConfigured: boolean;
  agentName: string;
  pluginList: string[];
  engine: string;
  timeoutMs: number;
  parameterKeys: string[];
  systemPromptConfigured?: boolean;
  capabilities: string[];
};

export type AgentRegistryResponse = {
  schemaVersion: string;
  provider: string;
  defaultAlias: string;
  agents: AgentRegistryItem[];
};

export type AgentGatewayCallRequest = {
  modelAlias?: string;
  alias?: string;
  agentName?: string;
  systemPrompt?: string;
  pluginList?: string[] | string;
  question: string;
  sessionId?: string;
  taskId?: string;
  moduleId?: string;
  featureId?: string;
  functionId?: string;
  userId?: string;
  projectId?: string;
  engine?: string;
  parameters?: Record<string, unknown>;
};

export type AgentGatewayCallResponse = {
  ok: boolean;
  answer: string;
  text: string;
  dialogId: string;
  finish: boolean;
  request: AgentGatewayCallRequest;
  upstream: {
    status: number;
    contentType: string;
  };
  events: Array<{
    type: string;
    content: string;
    nodeId: string | null;
    riskDescription: string | null;
    finish: boolean;
  }>;
  chunks?: {
    answer?: string[];
    text?: string[];
    rawText?: string[];
  };
  toolCalls?: Array<{
    id: string;
    type: "function" | string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type GatewayAssistantToolResult = {
  tool: string;
  arguments: Record<string, unknown>;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  result?: Record<string, unknown> | null;
};

export type GatewayAssistantStep = {
  iteration: number;
  status?: string;
  phase?: string;
  contextBudget?: Record<string, unknown>;
  model?: Record<string, unknown>;
  functionCallSource?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    status?: string;
    selectedAt?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  toolResults?: GatewayAssistantToolResult[];
  events?: Array<Record<string, unknown>>;
};

export type GatewayAssistantRunResponse = {
  protocolVersion: string;
  ok: boolean;
  pending?: boolean;
  workspace?: Record<string, unknown>;
  run?: Record<string, unknown>;
  answer?: string;
  evidenceRefs?: string[];
  toolResults?: GatewayAssistantToolResult[];
  contextPack?: Record<string, unknown>;
  degraded?: boolean;
  steps?: GatewayAssistantStep[];
  error?: string;
};

export type AgentSyncTopicRule = {
  topic: string;
  label: string;
  description: string;
  enabled: boolean;
  retain: boolean;
};

export type AgentSyncConfig = {
  schemaVersion: string;
  enabled: boolean;
  defaultTopicEnabled: boolean;
  updatedAt: string;
  topics: AgentSyncTopicRule[];
};

export type AgentSyncPublishRequest = {
  topic: string;
  type?: string;
  agentName?: string;
  clientId?: string;
  sessionId?: string;
  userId?: string;
  projectId?: string;
  retain?: boolean;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

export type ProtocolEvent = {
  schemaVersion: string;
  offset: number;
  id: string;
  topic: string;
  type: string;
  publisher: string;
  publishedAt: string;
  payload: Record<string, unknown>;
};

export type EventSubscriptionResponse = {
  cursor: number;
  nextCursor: number;
  topics: string[];
  events: ProtocolEvent[];
  snapshots?: ProtocolEvent[];
};
