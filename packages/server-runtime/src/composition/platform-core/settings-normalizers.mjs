import {
  AGENT_LOCAL_NODE_COMMAND_ENV_KEYS,
  DEFAULT_AGENT_TOOL_EXECUTION,
  DEFAULT_GATEWAY_ASSISTANT_DEFAULTS,
  DEFAULT_SETTINGS,
  MODEL_LIBRARY_PROVIDERS,
  MODEL_PROVIDERS,
  MODEL_USAGE_DEFINITIONS
} from "./settings-defaults.mjs";
import {
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "#meshrix/agents/agent-configs/credential-binding";

function sanitizeNumericSetting(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function configuredString(source, key, fallback = "") {
  return Object.hasOwn(source || {}, key)
    ? String(source[key] ?? "").trim()
    : String(fallback ?? "").trim();
}

function normalizeModelProvider(value, fallback = "") {
  const normalized = String(value || "").trim();
  if (MODEL_PROVIDERS.has(normalized)) {
    return normalized;
  }
  return MODEL_PROVIDERS.has(fallback) ? fallback : "";
}

export function normalizeModelLibraryEntries(value, settings = {}) {
  const incoming = Array.isArray(value) ? value : [];
  const normalized = [];
  const seen = new Set();
  const add = (provider) => {
    const item = String(provider || "").trim();
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

function normalizeModelAssignment(value) {
  if (value && typeof value === "object") {
    const providerInput = String(value.provider || "").trim();
    const provider = MODEL_PROVIDERS.has(providerInput) ? providerInput : "";
    const model = String(value.model || "").trim();
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

function normalizeAgentModuleAccess(value = {}) {
  const incoming = normalizePlainObject(value);
  const mode = String(incoming.mode || incoming.scope || "").trim();
  const moduleIds = normalizeStringList(
    incoming.moduleIds || incoming.modules || incoming.allowedModuleIds
  ).filter((item) => MODEL_USAGE_DEFINITIONS.some((definition) => definition.id === item));
  if (mode === "all") {
    return {
      mode: "all",
      moduleIds: []
    };
  }
  if (mode === "selected" || mode === "restricted" || !mode) {
    return {
      mode: "selected",
      moduleIds: [...new Set(moduleIds)]
    };
  }
  return {
    mode: "selected",
    moduleIds: [...new Set(moduleIds)]
  };
}

function modelLibraryAgentIdentities(model = {}) {
  return [model.uid, model.instanceId, model.alias]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function modelLibraryAgentId(model = {}) {
  return String(model.uid || model.instanceId || model.alias || "").trim();
}

function modelAllowsModule(model = {}, moduleId = "") {
  const access = normalizeAgentModuleAccess(model.moduleAccess);
  if (access.mode !== "selected") {
    return true;
  }
  return access.moduleIds.includes(moduleId);
}

function resolveModuleModelAssignmentToAgent(assignment, modelLibraryAgents = [], moduleId = "") {
  if (!assignment) {
    return null;
  }
  const provider = String(assignment.provider || "").trim();
  const model = String(assignment.model || "").trim();
  if (!provider || !model) {
    return null;
  }
  const providerModels = modelLibraryAgents.filter(
    (item) => String(item?.provider || "").trim() === provider
  );
  const directMatch = providerModels.find((item) =>
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
  assignments,
  modelLibraryAgents = [],
) {
  const normalized = {};
  const incoming = assignments && typeof assignments === "object" ? assignments : {};
  const models = Array.isArray(modelLibraryAgents) ? modelLibraryAgents : [];

  for (const definition of MODEL_USAGE_DEFINITIONS) {
    const assignment = normalizeModelAssignment(
      incoming[definition.id]
    );
    const resolved = resolveModuleModelAssignmentToAgent(assignment, models, definition.id);
    if (resolved) {
      normalized[definition.id] = resolved;
    }
  }

  return normalized;
}

function normalizeModuleAgentProfile(value = {}) {
  const incoming = normalizePlainObject(value);
  return {
    enabled: incoming.enabled === true,
    role: String(incoming.role || incoming.roleId || "").trim(),
    contextProfileId: String(incoming.contextProfileId || incoming.profileId || "").trim(),
    systemPrompt: String(incoming.systemPrompt || incoming.prompt || "").trim(),
    parameters: normalizePlainObject(incoming.parameters, {}),
    dependencyContext: normalizePlainObject(incoming.dependencyContext || incoming.dependencies, {})
  };
}

function normalizeModuleAgentProfiles(value = {}, modelLibraryAgents = [], moduleModelAssignments = {}) {
  void moduleModelAssignments;
  const incoming = normalizePlainObject(value);
  const normalized = {};
  const modelsById = new Map(
    (Array.isArray(modelLibraryAgents) ? modelLibraryAgents : [])
      .map((model) => [modelLibraryAgentId(model), model])
      .filter(([id]) => id)
  );

  for (const definition of MODEL_USAGE_DEFINITIONS) {
    const moduleId = definition.id;
    const group = normalizePlainObject(incoming[moduleId]);
    const agents = {};
    const incomingAgents = normalizePlainObject(group.agents);
    for (const [agentId, profile] of Object.entries(incomingAgents)) {
      const normalizedAgentId = String(agentId || "").trim();
      const model = modelsById.get(normalizedAgentId);
      if (!model || !modelAllowsModule(model, moduleId)) {
        continue;
      }
      agents[normalizedAgentId] = normalizeModuleAgentProfile(profile);
    }

    const primaryAgent = String(group.primaryAgent || "").trim();

    if (Object.keys(agents).length > 0 || primaryAgent) {
      normalized[moduleId] = {
        primaryAgent: agents[primaryAgent] ? primaryAgent : "",
        agents
      };
    }
  }

  return normalized;
}

function normalizeModuleIntelligence(moduleIntelligence, moduleModelAssignments = {}) {
  void moduleModelAssignments;
  const incoming =
    moduleIntelligence && typeof moduleIntelligence === "object" ? moduleIntelligence : {};
  const normalized = {};
  for (const definition of MODEL_USAGE_DEFINITIONS) {
    if (Object.hasOwn(incoming, definition.id)) {
      normalized[definition.id] = incoming[definition.id] === true;
    }
  }
  return normalized;
}

function normalizeExecutionSandbox(value) {
  if (value === undefined || value === null || value === "") return null;
  const incoming = normalizePlainObject(value, null);
  if (!incoming) return null;
  if (Object.keys(incoming).length === 0) return null;
  const allowedFields = new Set([
    "enabled",
    "providerMode",
    "providerId",
    "profileId",
    "policyRevision",
    "receiptRequirement",
    "allowedProviderClasses",
    "profiles"
  ]);
  if (Object.keys(incoming).some((field) => !allowedFields.has(field))) return null;
  const providerClasses = new Set([
    "rootless-podman",
    "podman",
    "rootless-docker",
    "docker",
    "registered-container",
    "registered-vm"
  ]);
  const allowedProviderClasses = Array.isArray(incoming.allowedProviderClasses)
    ? [...new Set(incoming.allowedProviderClasses
        .map((entry) => String(entry || "").trim())
        .filter((entry) => providerClasses.has(entry)))]
    : [];
  const profiles = Array.isArray(incoming.profiles)
    ? incoming.profiles.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => JSON.parse(JSON.stringify(entry)))
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

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function normalizePlainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function firstEnvironmentValue(keys = []) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function resolveAgentLocalNodeCommandOverride(local = {}) {
  const configuredNodeCommand = String(local.nodeCommand || local.nodePath || "").trim();
  return firstEnvironmentValue(AGENT_LOCAL_NODE_COMMAND_ENV_KEYS) || configuredNodeCommand;
}

function normalizeAgentLocalCommandVariables(value) {
  const variables = Array.isArray(value) ? value : [];
  return variables
    .map((item) => {
      const variable = normalizePlainObject(item);
      const name = String(variable.name || variable.key || "").trim();
      if (!name) {
        return null;
      }
      const hasDefault = Object.hasOwn(variable, "defaultValue") || Object.hasOwn(variable, "default");
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
  command,
  index,
  resolvedNodeCommand
) {
  void index;
  const commandId = String(command.commandId || command.id || "").trim();
  const commandValue = String(command.command || "").trim();
  const variables = normalizeAgentLocalCommandVariables(command.variables);
  const rawArgs = normalizeStringList(command.args);
  const usesTemplateVariables = variables.length > 0;
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

function readPresentString(source = {}, keys = []) {
  const value = normalizePlainObject(source);
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      return String(value[key] ?? "").trim();
    }
  }
  return undefined;
}

function modelAgentId(model = {}) {
  return String(model.uid || model.instanceId || model.alias || "").trim();
}

function normalizeModelLibraryAgent(value = {}, index = 0) {
  const incoming = normalizePlainObject(value);
  const provider = normalizeModelProvider(
    incoming.provider || incoming.modelProvider || "",
    ""
  );
  const model =
    readPresentString(incoming, ["model", "modelId", "engine"]) ?? "";
  const label =
    readPresentString(incoming, ["label", "name", "agentName"]) ?? "";
  const agentName =
    readPresentString(incoming, ["agentName", "label", "name"]) ?? "";
  const engine = readPresentString(incoming, ["engine"]) ?? "";
  const existingInstanceId = String(incoming.instanceId || incoming.id || "").trim();
  const explicitUid = String(incoming.uid || "").trim();
  const existingAlias = String(incoming.alias || incoming.modelAlias || "").trim();
  void index;
  const uid = explicitUid || existingInstanceId || existingAlias;
  const alias = uid;
  const timeoutMs = Number(incoming.timeoutMs ?? 0);
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

export function normalizeModelLibraryAgents(value = []) {
  const input = Array.isArray(value) ? value : [];
  const normalized = input
    .map((item, index) => normalizeModelLibraryAgent(item, index))
    .filter((item) => item.provider && item.alias);
  return normalized;
}

function normalizeGatewayAssistantDefaults(value = {}) {
  const incoming = normalizePlainObject(value);
  const thinkingMode = String(incoming.thinkingMode || DEFAULT_GATEWAY_ASSISTANT_DEFAULTS.thinkingMode).trim();
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

export function normalizeAgentToolExecution(value = {}) {
  const incoming = normalizePlainObject(value);
  const http = normalizePlainObject(incoming.http);
  const local = normalizePlainObject(incoming.local);
  const configuredNodeCommand = String(local.nodeCommand || local.nodePath || "").trim();
  const nodeCommandOverride = resolveAgentLocalNodeCommandOverride(local);
  const httpTimeoutMs = Number(http.timeoutMs ?? DEFAULT_AGENT_TOOL_EXECUTION.http.timeoutMs);
  const maxResponseBytes = Number(http.maxResponseBytes ?? DEFAULT_AGENT_TOOL_EXECUTION.http.maxResponseBytes);
  const localTimeoutMs = Number(local.timeoutMs ?? DEFAULT_AGENT_TOOL_EXECUTION.local.timeoutMs);
  const maxOutputBytes = Number(local.maxOutputBytes ?? DEFAULT_AGENT_TOOL_EXECUTION.local.maxOutputBytes);
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
        ? local.commands.map((item, index) =>
            normalizeAgentLocalCommandTemplate(
              normalizePlainObject(item),
              index,
              nodeCommandOverride
            )
          ).filter((item) => item.commandId && item.command)
        : []
    }
  };
}

export function normalizeSettings(settings) {
  const incomingSettings = { ...(settings || {}) };
  const defaultModelProvider = normalizeModelProvider(
    configuredString(settings, "defaultModelProvider", DEFAULT_SETTINGS.defaultModelProvider),
    ""
  );
  const defaultModel = configuredString(settings, "defaultModel", DEFAULT_SETTINGS.defaultModel);

  const modelLibraryAgents = normalizeModelLibraryAgents(settings?.modelLibraryAgents);
  const modelLibraryRevision = Number(settings?.modelLibraryRevision);
  const moduleModelAssignments = normalizeModuleModelAssignments(
    settings?.moduleModelAssignments,
    modelLibraryAgents
  );
  const moduleAgentProfiles = normalizeModuleAgentProfiles(
    settings?.moduleAgentProfiles,
    modelLibraryAgents,
    moduleModelAssignments
  );
  const moduleIntelligence = normalizeModuleIntelligence(
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
    modelLibraryAgentIds: modelLibraryAgents.map((model) => modelAgentId(model)).filter(Boolean),
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

export function resolveDefaultModelSettings(settings = {}) {
  const normalized = normalizeSettings(settings);
  return {
    provider: normalized.defaultModelProvider,
    model: normalized.defaultModel,
    enabled: normalized.modelIntelligenceEnabled === true
  };
}

export function resolveModelForModule(settings = {}, moduleId = "") {
  const normalized = normalizeSettings(settings);
  const requiresIntelligence = normalized.moduleIntelligence[moduleId] === true;

  if (!requiresIntelligence) {
    return {
      provider: "",
      model: "",
      enabled: false,
      moduleId
    };
  }

  const assignment = normalized.moduleModelAssignments[moduleId];
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
