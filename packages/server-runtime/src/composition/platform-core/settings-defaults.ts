import path from "node:path";

export interface AgentToolCommandVariable {
  name: string;
  label: string;
  required: boolean;
  defaultValue?: string;
  allowedValues: string[];
  description: string;
}

export interface AgentToolCommand {
  commandId: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  description: string;
  variables: AgentToolCommandVariable[];
  allowExtraArgs: boolean;
}

export interface AgentToolExecutionSettings {
  functionCallSchema: Record<string, unknown>;
  http: {
    enabled: boolean;
    allowedHosts: string[];
    allowLocalForDevelopment: boolean;
    timeoutMs: number;
    maxResponseBytes: number;
  };
  local: {
    enabled: boolean;
    allowDirectCommands: false;
    timeoutMs: number;
    maxOutputBytes: number;
    nodeCommand: string;
    commands: AgentToolCommand[];
  };
}

export interface ExecutionSandboxSettings {
  enabled: boolean;
  providerMode: string;
  providerId: string;
  profileId: string;
  policyRevision: string;
  receiptRequirement: string;
  allowedProviderClasses: string[];
  profiles: Record<string, unknown>[];
}

export interface RuntimeSettings {
  agentToolExecution: AgentToolExecutionSettings;
  executionSandbox: ExecutionSandboxSettings | null;
}

export const AGENT_LOCAL_NODE_COMMAND_ENV_KEYS = Object.freeze([
  "MESHRIX_AGENT_LOCAL_NODE_COMMAND",
  "MESHRIX_NODE_COMMAND",
  "NODE_BINARY"
]);

export const DEFAULT_AGENT_TOOL_EXECUTION: AgentToolExecutionSettings = {
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

export const DEFAULT_SETTINGS: RuntimeSettings = Object.freeze({
  agentToolExecution: DEFAULT_AGENT_TOOL_EXECUTION,
  executionSandbox: null
});

export function getSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, "settings.json");
}

export function getAgentToolSettingsDirectory(userDataPath: string): string {
  return path.join(userDataPath, "operation-permission");
}

export function getAgentToolExecutionSettingsPath(userDataPath: string): string {
  return path.join(getAgentToolSettingsDirectory(userDataPath), "execution.json");
}
