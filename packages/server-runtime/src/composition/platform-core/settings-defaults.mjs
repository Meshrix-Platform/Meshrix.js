import path from "node:path";
import { MODEL_USAGE_DEFINITIONS } from "#meshrix/contracts/modules/model-usage";

export { MODEL_USAGE_DEFINITIONS };

export const MODEL_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);
export const MODEL_LIBRARY_PROVIDERS = new Set([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);
export const DEFAULT_MODEL_PROVIDER = process.env.MESHRIX_DEFAULT_MODEL_PROVIDER || "";
export const DEFAULT_MODEL = process.env.MESHRIX_DEFAULT_MODEL || "";
export const AGENT_LOCAL_NODE_COMMAND_ENV_KEYS = [
  "MESHRIX_AGENT_LOCAL_NODE_COMMAND",
  "MESHRIX_NODE_COMMAND",
  "NODE_BINARY"
];
export const DEFAULT_GATEWAY_ASSISTANT_DEFAULTS = {
  systemPrompt: "",
  toolPolicyPrompt: "",
  continuationPrompt: "",
  answerTemplate: "",
  temperature: 0,
  maxTokens: 0,
  maxIterations: 0,
  limit: 0,
  contextProfileId: "",
  thinkingMode: "",
  toolChoice: "",
  gatewayReviewModelAlias: "",
  ruleAuthoringModelAlias: "",
  reviewFusionModelAlias: "",
  reviewFusionSystemPrompt: "",
  reviewFusionTemperature: 0,
  reviewFusionMaxTokens: 0
};

export const DEFAULT_AGENT_TOOL_EXECUTION = {
  functionCallSchema: {},
  http: {
    enabled: false,
    allowedHosts: [],
    allowLocalForDevelopment: false,
    timeoutMs: 0,
    maxResponseBytes: 0
  },
  local: {
    enabled: false,
    allowDirectCommands: false,
    timeoutMs: 0,
    maxOutputBytes: 0,
    nodeCommand: "",
    commands: []
  }
};

export function defaultModuleIntelligence() {
  return {};
}

export const DEFAULT_SETTINGS = {
  modelIntelligenceEnabled:
    process.env.MESHRIX_MODEL_INTELLIGENCE_ENABLED === "1",
  defaultModelProvider: DEFAULT_MODEL_PROVIDER,
  defaultModel: DEFAULT_MODEL,
  modelLibraryEntries: [],
  modelLibraryAgentIds: [],
  modelLibraryAgents: [],
  modelLibraryRevision: 0,
  gatewayAssistantDefaults: DEFAULT_GATEWAY_ASSISTANT_DEFAULTS,
  agentToolExecution: DEFAULT_AGENT_TOOL_EXECUTION,
  executionSandbox: null,
  moduleModelAssignments: {},
  moduleAgentProfiles: {},
  moduleIntelligence: defaultModuleIntelligence()
};

export function getSettingsPath(userDataPath) {
  return path.join(userDataPath, "settings.json");
}

export function getAgentToolSettingsDirectory(userDataPath) {
  return path.join(userDataPath, "operation-permission");
}

export function getAgentToolExecutionSettingsPath(userDataPath) {
  return path.join(getAgentToolSettingsDirectory(userDataPath), "execution.json");
}
