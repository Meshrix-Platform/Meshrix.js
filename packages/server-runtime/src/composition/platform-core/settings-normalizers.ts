import {
  AGENT_LOCAL_NODE_COMMAND_ENV_KEYS,
  DEFAULT_AGENT_TOOL_EXECUTION,
  type AgentToolCommand,
  type AgentToolCommandVariable,
  type AgentToolExecutionSettings,
  type ExecutionSandboxSettings,
  type RuntimeSettings
} from "./settings-defaults.ts";

const SANDBOX_FIELDS = new Set([
  "enabled",
  "providerMode",
  "providerId",
  "profileId",
  "policyRevision",
  "receiptRequirement",
  "allowedProviderClasses",
  "profiles"
]);

const SANDBOX_PROVIDER_CLASSES = new Set([
  "rootless-podman",
  "podman",
  "rootless-docker",
  "docker",
  "registered-container",
  "registered-vm"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizePlainObject(
  value: unknown,
  fallback: Record<string, unknown> | null = {}
): Record<string, unknown> | null {
  return isRecord(value) ? value : fallback;
}

export function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function environmentNodeCommand(local: Record<string, unknown>): string {
  for (const key of AGENT_LOCAL_NODE_COMMAND_ENV_KEYS) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return String(local.nodeCommand ?? local.nodePath ?? "").trim();
}

function normalizeCommandVariables(value: unknown): AgentToolCommandVariable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const name = String(candidate.name ?? candidate.key ?? "").trim();
    if (!name) return [];
    const variable: AgentToolCommandVariable = {
      name,
      label: String(candidate.label ?? candidate.title ?? name).trim(),
      required: candidate.required === true,
      allowedValues: normalizeStringList(candidate.allowedValues ?? candidate.enum ?? candidate.options),
      description: String(candidate.description ?? candidate.help ?? "").trim()
    };
    if (Object.hasOwn(candidate, "defaultValue") || Object.hasOwn(candidate, "default")) {
      variable.defaultValue = String(candidate.defaultValue ?? candidate.default ?? "");
    }
    return [variable];
  });
}

function normalizeCommands(value: unknown, nodeCommand: string): AgentToolCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const commandId = String(candidate.commandId ?? candidate.id ?? "").trim();
    const configuredCommand = String(candidate.command ?? "").trim();
    const command = commandId === "node-version" && nodeCommand ? nodeCommand : configuredCommand;
    if (!commandId || !command) return [];
    const variables = normalizeCommandVariables(candidate.variables);
    return [{
      commandId,
      label: String(candidate.label ?? candidate.name ?? "").trim(),
      command,
      args: normalizeStringList(candidate.args),
      cwd: String(candidate.cwd ?? "").trim(),
      description: String(candidate.description ?? "").trim(),
      variables,
      allowExtraArgs: candidate.allowExtraArgs === true && variables.length === 0
    }];
  });
}

export function normalizeAgentToolExecution(value: unknown): AgentToolExecutionSettings {
  const incoming = isRecord(value) ? value : {};
  const http = isRecord(incoming.http) ? incoming.http : {};
  const local = isRecord(incoming.local) ? incoming.local : {};
  const configuredNodeCommand = String(local.nodeCommand ?? local.nodePath ?? "").trim();
  return {
    functionCallSchema: isRecord(incoming.functionCallSchema) ? incoming.functionCallSchema : {},
    http: {
      enabled: http.enabled === true,
      allowedHosts: normalizeStringList(http.allowedHosts),
      allowLocalForDevelopment: http.allowLocalForDevelopment === true,
      timeoutMs: positiveNumber(http.timeoutMs),
      maxResponseBytes: positiveNumber(http.maxResponseBytes)
    },
    local: {
      enabled: local.enabled === true,
      allowDirectCommands: false,
      timeoutMs: positiveNumber(local.timeoutMs),
      maxOutputBytes: positiveNumber(local.maxOutputBytes),
      nodeCommand: configuredNodeCommand,
      commands: normalizeCommands(local.commands, environmentNodeCommand(local))
    }
  };
}

function normalizeExecutionSandbox(value: unknown): ExecutionSandboxSettings | null {
  if (value === undefined || value === null || value === "" || !isRecord(value)) return null;
  const fields = Object.keys(value);
  if (fields.length === 0 || fields.some((field) => !SANDBOX_FIELDS.has(field))) return null;
  const allowedProviderClasses = Array.from(new Set(
    normalizeStringList(value.allowedProviderClasses).filter((entry) => SANDBOX_PROVIDER_CLASSES.has(entry))
  ));
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.filter(isRecord).map((profile) => structuredClone(profile))
    : [];
  return {
    enabled: value.enabled === true,
    providerMode: String(value.providerMode ?? "").trim(),
    providerId: String(value.providerId ?? "").trim(),
    profileId: String(value.profileId ?? "").trim(),
    policyRevision: String(value.policyRevision ?? "").trim(),
    receiptRequirement: String(value.receiptRequirement ?? "").trim(),
    allowedProviderClasses,
    profiles
  };
}

export function normalizeSettings(settings: unknown): RuntimeSettings {
  const incoming = isRecord(settings) ? settings : {};
  return {
    agentToolExecution: normalizeAgentToolExecution(
      Object.hasOwn(incoming, "agentToolExecution")
        ? incoming.agentToolExecution
        : DEFAULT_AGENT_TOOL_EXECUTION
    ),
    executionSandbox: normalizeExecutionSandbox(incoming.executionSandbox)
  };
}
