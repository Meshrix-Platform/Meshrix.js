import {
  AGENT_LOCAL_NODE_COMMAND_ENV_KEYS,
  DEFAULT_AGENT_TOOL_EXECUTION,
  DEFAULT_GATEWAY_ASSISTANT_DEFAULTS,
  DEFAULT_SETTINGS,
  MODEL_LIBRARY_PROVIDERS,
  MODEL_PROVIDERS,
  MODEL_USAGE_DEFINITIONS
} from "./settings-defaults.ts";
import {
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "#meshrix/agents/agent-configs/credential-binding";

function sanitizeNumericSetting(value?: any, fallback?: any) : any {
  const parsed: any = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function configuredString(source?: any, key?: any, fallback: any = "") : any {
  return Object.hasOwn(source || {}, key)
    ? String(source[key] ?? "").trim()
    : String(fallback ?? "").trim();
}

function normalizeModelProvider(value?: any, fallback: any = "") : any {
  const normalized: any = String(value || "").trim();
  if (MODEL_PROVIDERS.has(normalized)) {
    return normalized;
  }
  return MODEL_PROVIDERS.has(fallback) ? fallback : "";
}

export function normalizeModelLibraryEntries(value?: any, settings: Record<string, any> = {}) : any {
  const incoming: any = Array.isArray(value) ? value : [];
  const normalized: any[] = [];
  const seen: any = new Set<any>();
  const add: any = (provider?: any) : any => {
    const item: any = String(provider || "").trim();
    if (!MODEL_LIBRARY_PROVIDERS.has(item) || seen.has(item)) {
      return;
    }
    seen.add(item);
    normalized.push(item);
  };

  for (const item of incoming) {
    add(item);
  }

  if (incoming.length === 0 && !Object.hasOwn(settings || {}, "modelLibraryEntries")) {
    for (const model of Array.isArray(settings?.modelLibraryAgents)
      ? settings.modelLibraryAgents
      : []) {
      add(model?.provider);
    }
  }

  return normalized;
}

function normalizeModelAssignment(value?: any) : any {
  if (value && typeof value === "object") {
    const providerInput: any = String(value.provider || "").trim();
    const provider: any = MODEL_PROVIDERS.has(providerInput) ? providerInput : "";
    const model: any = String(value.model || "").trim();
    if (!provider || !model) {
      return null;
    }
    return {
      provider,
      model
    };
  }

  return null;
}

function normalizeAgentModuleAccess(value: Record<string, any> = {}) : any {
  const incoming: any = normalizePlainObject(value);
  const mode: any = String(incoming.mode || incoming.scope || "").trim();
  const moduleIds: any = normalizeStringList(
    incoming.moduleIds || incoming.modules || incoming.allowedModuleIds
  ).filter((item?: any) : any => MODEL_USAGE_DEFINITIONS.some((definition?: any) : any => definition.id === item));
  if (mode === "all") {
    return {
      mode: "all",
      moduleIds: []
    };
  }
  if (mode === "selected" || mode === "restricted" || !mode) {
    return {
      mode: "selected",
      moduleIds: [...new Set<any>(moduleIds)]
    };
  }
  return {
    mode: "selected",
    moduleIds: [...new Set<any>(moduleIds)]
  };
}

function modelLibraryAgentIdentities(model: Record<string, any> = {}) : any {
  return [model.uid, model.instanceId, model.alias]
    .map((item?: any) : any => String(item || "").trim())
    .filter(Boolean);
}

function modelLibraryAgentId(model: Record<string, any> = {}) : any {
  return String(model.uid || model.instanceId || model.alias || "").trim();
}

function modelAllowsModule(model: Record<string, any> = {}, moduleId: any = "") : any {
  const access: any = normalizeAgentModuleAccess(model.moduleAccess);
  if (access.mode !== "selected") {
    return true;
  }
  return access.moduleIds.includes(moduleId);
}

function resolveModuleModelAssignmentToAgent(assignment?: any, modelLibraryAgents: any = [], moduleId: any = "") : any {
  if (!assignment) {
    return null;
  }
  const provider: any = String(assignment.provider || "").trim();
  const model: any = String(assignment.model || "").trim();
  if (!provider || !model) {
    return null;
  }
  const providerModels: any = modelLibraryAgents.filter(
    (item?: any) : any => String(item?.provider || "").trim() === provider
  );
  const directMatch: any = providerModels.find((item?: any) : any =>
    modelLibraryAgentIdentities(item).includes(model) && modelAllowsModule(item, moduleId)
  );
  if (directMatch) {
    return {
      provider,
      model: modelLibraryAgentId(directMatch)
    };
  }

  return null;
}

function normalizeModuleModelAssignments(
  assignments?: any,
  modelLibraryAgents: any = [],
) : any {
  const normalized: Record<string, any> = {};
  const incoming: any = assignments && typeof assignments === "object" ? assignments : {};
  const models: any = Array.isArray(modelLibraryAgents) ? modelLibraryAgents : [];

  for (const definition of MODEL_USAGE_DEFINITIONS) {
    const assignment: any = normalizeModelAssignment(
      incoming[definition.id]
    );
    const resolved: any = resolveModuleModelAssignmentToAgent(assignment, models, definition.id);
    if (resolved) {
      normalized[definition.id] = resolved;
    }
  }

  return normalized;
}

function normalizeModuleAgentProfile(value: Record<string, any> = {}) : any {
  const incoming: any = normalizePlainObject(value);
  return {
    enabled: incoming.enabled === true,
    role: String(incoming.role || incoming.roleId || "").trim(),
    contextProfileId: String(incoming.contextProfileId || incoming.profileId || "").trim(),
    systemPrompt: String(incoming.systemPrompt || incoming.prompt || "").trim(),
    parameters: normalizePlainObject(incoming.parameters, {}),
    dependencyContext: normalizePlainObject(incoming.dependencyContext || incoming.dependencies, {})
  };
}

function normalizeModuleAgentProfiles(value: Record<string, any> = {}, modelLibraryAgents: any = [], moduleModelAssignments: Record<string, any> = {}) : any {
  void moduleModelAssignments;
  const incoming: any = normalizePlainObject(value);
  const normalized: Record<string, any> = {};
  const modelsById: any = new Map<any, any>(
    (Array.isArray(modelLibraryAgents) ? modelLibraryAgents : [])
      .map((model?: any) : any => [modelLibraryAgentId(model), model])
      .filter(([id]: any[]) : any => id)
  );

  for (const definition of MODEL_USAGE_DEFINITIONS) {
    const moduleId: any = definition.id;
    const group: any = normalizePlainObject(incoming[moduleId]);
    const agents: Record<string, any> = {};
    const incomingAgents: any = normalizePlainObject(group.agents);
    for (const [agentId, profile] of (Object.entries(incomingAgents) as [string, any][])) {
      const normalizedAgentId: any = String(agentId || "").trim();
      const model: any = modelsById.get(normalizedAgentId);
      if (!model || !modelAllowsModule(model, moduleId)) {
        continue;
      }
      agents[normalizedAgentId] = normalizeModuleAgentProfile(profile);
    }

    const primaryAgent: any = String(group.primaryAgent || "").trim();

    if (Object.keys(agents).length > 0 || primaryAgent) {
      normalized[moduleId] = {
        primaryAgent: agents[primaryAgent] ? primaryAgent : "",
        agents
      };
    }
  }

  return normalized;
}

function normalizeModuleIntelligence(moduleIntelligence?: any, moduleModelAssignments: Record<string, any> = {}) : any {
  void moduleModelAssignments;
  const incoming: any =
    moduleIntelligence && typeof moduleIntelligence === "object" ? moduleIntelligence : {};
  const normalized: Record<string, any> = {};
  for (const definition of MODEL_USAGE_DEFINITIONS) {
    if (Object.hasOwn(incoming, definition.id)) {
      normalized[definition.id] = incoming[definition.id] === true;
    }
  }
  return normalized;
}

function normalizeExecutionSandbox(value?: any) : any {
  if (value === undefined || value === null || value === "") return null;
  const incoming: any = normalizePlainObject(value, null);
  if (!incoming) return null;
  if (Object.keys(incoming).length === 0) return null;
  const allowedFields: any = new Set<any>([
    "enabled",
    "providerMode",
    "providerId",
    "profileId",
    "policyRevision",
    "receiptRequirement",
    "allowedProviderClasses",
    "profiles"
  ]);
  if (Object.keys(incoming).some((field?: any) : any => !allowedFields.has(field))) return null;
  const providerClasses: any = new Set<any>([
    "rootless-podman",
    "podman",
    "rootless-docker",
    "docker",
    "registered-container",
    "registered-vm"
  ]);
  const allowedProviderClasses: any = Array.isArray(incoming.allowedProviderClasses)
    ? [...new Set<any>(incoming.allowedProviderClasses
        .map((entry?: any) : any => String(entry || "").trim())
        .filter((entry?: any) : any => providerClasses.has(entry)))]
    : [];
  const profiles: any = Array.isArray(incoming.profiles)
    ? incoming.profiles.filter((entry?: any) : any => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry?: any) : any => JSON.parse(JSON.stringify(entry)))
    : [];
  return {
    enabled: incoming.enabled === true,
    providerMode: String(incoming.providerMode || "").trim(),
    providerId: String(incoming.providerId || "").trim(),
    profileId: String(incoming.profileId || "").trim(),
    policyRevision: String(incoming.policyRevision || "").trim(),
    receiptRequirement: String(incoming.receiptRequirement || "").trim(),
    allowedProviderClasses,
    profiles
  };
}

export function normalizeStringList(value?: any) : any {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item?: any) : any => item.trim()).filter(Boolean);
  }
  return [];
}

export function normalizePlainObject(value?: any, fallback: Record<string, any> = {}) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function firstEnvironmentValue(keys: any = []) : any {
  for (const key of keys) {
    const value: any = String(process.env[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveAgentLocalNodeCommandOverride(local: Record<string, any> = {}) : any {
  const configuredNodeCommand: any = String(local.nodeCommand || local.nodePath || "").trim();
  return firstEnvironmentValue(AGENT_LOCAL_NODE_COMMAND_ENV_KEYS) || configuredNodeCommand;
}

function normalizeAgentLocalCommandVariables(value?: any) : any {
  const variables: any = Array.isArray(value) ? value : [];
  return variables
    .map((item?: any) : any => {
      const variable: any = normalizePlainObject(item);
      const name: any = String(variable.name || variable.key || "").trim();
      if (!name) {
        return null;
      }
      const hasDefault: any = Object.hasOwn(variable, "defaultValue") || Object.hasOwn(variable, "default");
      return {
        name,
        label: String(variable.label || variable.title || name).trim(),
        required: variable.required === true,
        ...(hasDefault
          ? { defaultValue: String(variable.defaultValue ?? variable.default ?? "") }
          : {}),
        allowedValues: normalizeStringList(variable.allowedValues || variable.enum || variable.options),
        description: String(variable.description || variable.help || "").trim()
      };
    })
    .filter(Boolean);
}

function normalizeAgentLocalCommandTemplate(
  command?: any,
  index?: any,
  resolvedNodeCommand?: any
) : any {
  void index;
  const commandId: any = String(command.commandId || command.id || "").trim();
  const commandValue: any = String(command.command || "").trim();
  const variables: any = normalizeAgentLocalCommandVariables(command.variables);
  const rawArgs: any = normalizeStringList(command.args);
  const usesTemplateVariables: any = variables.length > 0;
  return {
    commandId,
    label: String(command.label || command.name || "").trim(),
    command: commandId === "node-version" && resolvedNodeCommand
      ? resolvedNodeCommand
      : commandValue,
    args: rawArgs,
    cwd: String(command.cwd || "").trim(),
    description: String(command.description || "").trim(),
    variables,
    allowExtraArgs: command.allowExtraArgs === true && !usesTemplateVariables
  };
}

function readPresentString(source: Record<string, any> = {}, keys: any = []) : any {
  const value: any = normalizePlainObject(source);
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      return String(value[key] ?? "").trim();
    }
  }
  return undefined;
}

function modelAgentId(model: Record<string, any> = {}) : any {
  return String(model.uid || model.instanceId || model.alias || "").trim();
}

function normalizeModelLibraryAgent(value: Record<string, any> = {}, index: any = 0) : any {
  const incoming: any = normalizePlainObject(value);
  const provider: any = normalizeModelProvider(
    incoming.provider || incoming.modelProvider || "",
    ""
  );
  const model: any =
    readPresentString(incoming, ["model", "modelId", "engine"]) ?? "";
  const label: any =
    readPresentString(incoming, ["label", "name", "agentName"]) ?? "";
  const agentName: any =
    readPresentString(incoming, ["agentName", "label", "name"]) ?? "";
  const engine: any = readPresentString(incoming, ["engine"]) ?? "";
  const existingInstanceId: any = String(incoming.instanceId || incoming.id || "").trim();
  const explicitUid: any = String(incoming.uid || "").trim();
  const existingAlias: any = String(incoming.alias || incoming.modelAlias || "").trim();
  void index;
  const uid: any = explicitUid || existingInstanceId || existingAlias;
  const alias: any = uid;
  const timeoutMs: any = Number(incoming.timeoutMs ?? 0);
  return {
    uid,
    instanceId: uid,
    provider,
    alias,
    label,
    baseUrl: normalizeModelEndpoint(incoming.baseUrl || incoming.url),
    url: normalizeModelEndpoint(incoming.url),
    model,
    apiKey: String(
      incoming.apiKey ||
        incoming.token ||
        ""
    ).trim(),
    apiKeyConfigured: incoming.apiKeyConfigured === true,
    token: String(incoming.token || incoming.apiKey || "").trim(),
    tokenConfigured: incoming.tokenConfigured === true,
    tokenHeader: normalizeModelTokenHeader(incoming.tokenHeader),
    tokenPrefix: normalizeModelTokenPrefix(incoming.tokenPrefix),
    agentName,
    engine,
    pluginList: normalizeStringList(incoming.pluginList),
    systemPrompt: String(incoming.systemPrompt || incoming.prompt || "").trim(),
    parameters: normalizePlainObject(incoming.parameters, {}),
    moduleAccess: normalizeAgentModuleAccess(incoming.moduleAccess),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
  };
}

export function normalizeModelLibraryAgents(value: any = []) : any {
  const input: any = Array.isArray(value) ? value : [];
  const normalized: any = input
    .map((item?: any, index?: any) : any => normalizeModelLibraryAgent(item, index))
    .filter((item?: any) : any => item.provider && item.alias);
  return normalized;
}

function normalizeGatewayAssistantDefaults(value: Record<string, any> = {}) : any {
  const incoming: any = normalizePlainObject(value);
  const thinkingMode: any = String(incoming.thinkingMode || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.thinkingMode).trim();
  return {
    ...DEFAULT_GATEWAY_ASSISTANT_DEFAULTS,
    ...incoming,
    systemPrompt: String(incoming.systemPrompt || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.systemPrompt).trim(),
    toolPolicyPrompt: String(incoming.toolPolicyPrompt || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.toolPolicyPrompt).trim(),
    continuationPrompt: String(incoming.continuationPrompt || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.continuationPrompt).trim(),
    answerTemplate: String(incoming.answerTemplate || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.answerTemplate).trim(),
    contextProfileId:
      String(incoming.contextProfileId || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.contextProfileId).trim() ||
      DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.contextProfileId,
    thinkingMode: ["enabled", "disabled", "default"].includes(thinkingMode) ? thinkingMode : "",
    temperature: sanitizeNumericSetting(
      incoming.temperature,
      DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.temperature
    ),
    maxTokens: sanitizeNumericSetting(
      incoming.maxTokens,
      DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.maxTokens
    ),
    maxIterations: sanitizeNumericSetting(
      incoming.maxIterations,
      DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.maxIterations
    ),
    limit: sanitizeNumericSetting(incoming.limit, DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.limit),
    toolChoice: String(incoming.toolChoice || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.toolChoice).trim(),
    gatewayReviewModelAlias: String(
      incoming.gatewayReviewModelAlias || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.gatewayReviewModelAlias
    ).trim(),
    ruleAuthoringModelAlias: String(
      incoming.ruleAuthoringModelAlias || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.ruleAuthoringModelAlias
    ).trim(),
    reviewFusionModelAlias: String(
      incoming.reviewFusionModelAlias || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.reviewFusionModelAlias
    ).trim(),
    reviewFusionSystemPrompt: String(
      incoming.reviewFusionSystemPrompt || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.reviewFusionSystemPrompt
    ).trim(),
    reviewFusionTemperature: sanitizeNumericSetting(
      incoming.reviewFusionTemperature,
      DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.reviewFusionTemperature
    ),
    reviewFusionMaxTokens: sanitizeNumericSetting(
      incoming.reviewFusionMaxTokens,
      DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.reviewFusionMaxTokens
    )
  };
}

export function normalizeAgentToolExecution(value: Record<string, any> = {}) : any {
  const incoming: any = normalizePlainObject(value);
  const http: any = normalizePlainObject(incoming.http);
  const local: any = normalizePlainObject(incoming.local);
  const configuredNodeCommand: any = String(local.nodeCommand || local.nodePath || "").trim();
  const nodeCommandOverride: any = resolveAgentLocalNodeCommandOverride(local);
  const httpTimeoutMs: any = Number(http.timeoutMs ?? DEFAULT_AGENT_TOOL_EXECUTION.http.timeoutMs);
  const maxResponseBytes: any = Number(http.maxResponseBytes ?? DEFAULT_AGENT_TOOL_EXECUTION.http.maxResponseBytes);
  const localTimeoutMs: any = Number(local.timeoutMs ?? DEFAULT_AGENT_TOOL_EXECUTION.local.timeoutMs);
  const maxOutputBytes: any = Number(local.maxOutputBytes ?? DEFAULT_AGENT_TOOL_EXECUTION.local.maxOutputBytes);
  return {
    functionCallSchema: normalizePlainObject(
      incoming.functionCallSchema,
      DEFAULT_AGENT_TOOL_EXECUTION.functionCallSchema
    ),
    http: {
      ...DEFAULT_AGENT_TOOL_EXECUTION.http,
      ...http,
      enabled: http.enabled === true,
      allowedHosts: normalizeStringList(http.allowedHosts),
      allowLocalForDevelopment: http.allowLocalForDevelopment === true,
      timeoutMs: Number.isFinite(httpTimeoutMs) && httpTimeoutMs > 0 ? httpTimeoutMs : 0,
      maxResponseBytes: Number.isFinite(maxResponseBytes) && maxResponseBytes > 0 ? maxResponseBytes : 0
    },
    local: {
      ...DEFAULT_AGENT_TOOL_EXECUTION.local,
      ...local,
      enabled: local.enabled === true,
      allowDirectCommands: false,
      timeoutMs: Number.isFinite(localTimeoutMs) && localTimeoutMs > 0 ? localTimeoutMs : 0,
      maxOutputBytes: Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : 0,
      nodeCommand: configuredNodeCommand,
      commands: Array.isArray(local.commands)
        ? local.commands.map((item?: any, index?: any) : any =>
            normalizeAgentLocalCommandTemplate(
              normalizePlainObject(item),
              index,
              nodeCommandOverride
            )
          ).filter((item?: any) : any => item.commandId && item.command)
        : []
    }
  };
}

export function normalizeSettings(settings?: any) : any {
  const incomingSettings: Record<string, any> = { ...(settings || {}) };
  const defaultModelProvider: any = normalizeModelProvider(
    configuredString(settings, "defaultModelProvider", DEFAULT_SETTINGS.defaultModelProvider),
    ""
  );
  const defaultModel: any = configuredString(settings, "defaultModel", DEFAULT_SETTINGS.defaultModel);

  const modelLibraryAgents: any = normalizeModelLibraryAgents(settings?.modelLibraryAgents);
  const modelLibraryRevision: any = Number(settings?.modelLibraryRevision);
  const moduleModelAssignments: any = normalizeModuleModelAssignments(
    settings?.moduleModelAssignments,
    modelLibraryAgents
  );
  const moduleAgentProfiles: any = normalizeModuleAgentProfiles(
    settings?.moduleAgentProfiles,
    modelLibraryAgents,
    moduleModelAssignments
  );
  const moduleIntelligence: any = normalizeModuleIntelligence(
    settings?.moduleIntelligence,
    moduleModelAssignments
  );

  return {
    ...DEFAULT_SETTINGS,
    ...incomingSettings,
    modelIntelligenceEnabled:
      !Object.hasOwn(settings || {}, "modelIntelligenceEnabled")
        ? DEFAULT_SETTINGS.modelIntelligenceEnabled
        : settings.modelIntelligenceEnabled === true,
    defaultModelProvider,
    defaultModel,
    modelLibraryEntries: normalizeModelLibraryEntries(settings?.modelLibraryEntries, settings),
    modelLibraryAgentIds: modelLibraryAgents.map((model?: any) : any => modelAgentId(model)).filter(Boolean),
    modelLibraryAgents,
    modelLibraryRevision:
      Number.isSafeInteger(modelLibraryRevision) && modelLibraryRevision >= 0
        ? modelLibraryRevision
        : 0,
    gatewayAssistantDefaults: normalizeGatewayAssistantDefaults(settings?.gatewayAssistantDefaults),
    agentToolExecution: normalizeAgentToolExecution(settings?.agentToolExecution),
    executionSandbox: normalizeExecutionSandbox(settings?.executionSandbox),
    moduleModelAssignments,
    moduleAgentProfiles,
    moduleIntelligence
  };
}

export function resolveDefaultModelSettings(settings: Record<string, any> = {}) : any {
  const normalized: any = normalizeSettings(settings);
  return {
    provider: normalized.defaultModelProvider,
    model: normalized.defaultModel,
    enabled: normalized.modelIntelligenceEnabled === true
  };
}

export function resolveModelForModule(settings: Record<string, any> = {}, moduleId: any = "") : any {
  const normalized: any = normalizeSettings(settings);
  const requiresIntelligence: any = normalized.moduleIntelligence[moduleId] === true;

  if (!requiresIntelligence) {
    return {
      provider: "",
      model: "",
      enabled: false,
      moduleId
    };
  }

  const assignment: any = normalized.moduleModelAssignments[moduleId];
  if (!assignment?.provider || !assignment?.model) {
    return {
      provider: "",
      model: "",
      enabled: false,
      moduleId
    };
  }

  return {
    provider: assignment.provider,
    model: assignment.model,
    enabled: normalized.modelIntelligenceEnabled === true,
    moduleId,
    profile: normalized.moduleAgentProfiles?.[moduleId]?.agents?.[assignment.model] || null,
    agentProfiles: normalized.moduleAgentProfiles?.[moduleId]?.agents || {}
  };
}
