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

export type AgentSettings = {
  agentToolExecution: AgentToolExecutionConfig;
  executionSandbox: Record<string, unknown> | null;
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
