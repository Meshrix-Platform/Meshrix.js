import {
  asPlainObject,
  asStringList,
  normalizeTimeout
} from "./shared.mjs";
import {
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "../agent-configs/credential-binding.mjs";

export const AGENT_GATEWAY_MODEL_PROVIDERS = Object.freeze([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);
const AGENT_GATEWAY_MODEL_PROVIDER_SET = new Set(AGENT_GATEWAY_MODEL_PROVIDERS);

function adapterAlias(value, fallback = "") {
  const normalized = String(value || "").trim();
  if (normalized) {
    return normalized;
  }
  return String(fallback || "").trim();
}

function readPresentString(source = {}, keys = []) {
  const value = asPlainObject(source);
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      return String(value[key] ?? "").trim();
    }
  }
  return undefined;
}

function normalizeDeepSeekEntry(settings = {}, entry = {}) {
  const modelEntry = asPlainObject(entry);
  void settings;
  const baseUrl = normalizeModelEndpoint(modelEntry.baseUrl || modelEntry.url);
  const modelFieldPresent = ["model", "modelId", "engine"].some((key) =>
    Object.hasOwn(modelEntry, key)
  );
  const configuredModel = readPresentString(modelEntry, ["model", "modelId", "engine"]);
  const model = configuredModel ?? "";
  const alias = adapterAlias(
    modelEntry.uid ||
      modelEntry.instanceId ||
      modelEntry.alias ||
      modelEntry.modelAlias,
    ""
  );
  return {
    alias,
    model,
    modelFieldPresent,
    provider: "deepseek",
    label:
      readPresentString(modelEntry, ["label", "name", "agentName"]) ??
      "",
    baseUrl,
    url: deepSeekChatCompletionsUrl(baseUrl),
    token: String(
      modelEntry.apiKey ||
        modelEntry.token ||
        ""
    ).trim(),
    tokenHeader: normalizeModelTokenHeader(modelEntry.tokenHeader),
    tokenPrefix: normalizeModelTokenPrefix(modelEntry.tokenPrefix),
    agentName:
      readPresentString(modelEntry, ["agentName", "label", "name"]) ?? "",
    pluginList: asStringList(modelEntry.pluginList),
    engine: readPresentString(modelEntry, ["engine"]) ?? "",
    parameters: asPlainObject(modelEntry.parameters),
    systemPrompt: String(modelEntry.systemPrompt || modelEntry.prompt || "").trim(),
    timeoutMs: normalizeTimeout(modelEntry.timeoutMs)
  };
}

function normalizeOpenAiCompatibleEntry(settings = {}, entry = {}, provider = "") {
  const modelEntry = asPlainObject(entry);
  const providerId = String(provider || modelEntry.provider || "").trim();
  void settings;
  const model = readPresentString(modelEntry, ["model", "modelId", "engine"]) ?? "";
  const alias = adapterAlias(
    modelEntry.uid ||
      modelEntry.instanceId ||
      modelEntry.alias ||
      modelEntry.modelAlias,
    ""
  );
  const baseUrl = normalizeModelEndpoint(modelEntry.baseUrl || modelEntry.url);
  const token = String(modelEntry.apiKey || modelEntry.token || "").trim();
  return {
    alias,
    model,
    provider: providerId,
    label:
      readPresentString(modelEntry, ["label", "name", "agentName"]) ??
      "",
    baseUrl,
    url: chatCompletionsUrl(baseUrl),
    token,
    tokenHeader: normalizeModelTokenHeader(modelEntry.tokenHeader),
    tokenPrefix: normalizeModelTokenPrefix(modelEntry.tokenPrefix),
    agentName:
      readPresentString(modelEntry, ["agentName", "label", "name"]) ?? "",
    pluginList: asStringList(modelEntry.pluginList),
    engine: readPresentString(modelEntry, ["engine"]) ?? "",
    parameters: asPlainObject(modelEntry.parameters),
    systemPrompt: String(modelEntry.systemPrompt || modelEntry.prompt || "").trim(),
    timeoutMs: normalizeTimeout(modelEntry.timeoutMs)
  };
}

function resolveAgentGatewayRegistry(settings = {}) {
  const entries = [];
  const seen = new Set();
  for (const item of Array.isArray(settings.modelLibraryAgents)
    ? settings.modelLibraryAgents
    : []) {
    const provider = String(item?.provider || "").trim();
    if (provider === "deepseek") {
      const config = normalizeDeepSeekEntry(settings, item);
      if (config.alias && !seen.has(config.alias)) {
        seen.add(config.alias);
        entries.push(config);
      }
      continue;
    }
    if (["openai", "openrouter", "copilot", "local-model"].includes(provider)) {
      const config = normalizeOpenAiCompatibleEntry(settings, item, provider);
      if (config.alias && !seen.has(config.alias)) {
        seen.add(config.alias);
        entries.push(config);
      }
    }
  }

  return entries.filter((entry) => entry.alias);
}

function emptyAgentGatewayConfig(alias = "", provider = "") {
  return {
    alias,
    model: "",
    provider,
    label: "",
    baseUrl: "",
    url: "",
    token: "",
    tokenHeader: "",
    tokenPrefix: "",
    agentName: "",
    pluginList: [],
    engine: "",
    parameters: {},
    systemPrompt: "",
    timeoutMs: 0
  };
}

export function modelLibraryAgentReadiness(entry = {}, {
  allowRedactedCredential = false
} = {}) {
  const provider = String(entry.provider || "").trim();
  const alias = adapterAlias(
    entry.uid || entry.instanceId || entry.alias || entry.modelAlias,
    ""
  );
  const model = readPresentString(entry, ["model", "modelId", "engine"]) ?? "";
  const endpoint = String(entry.baseUrl || entry.url || "").trim();
  const timeoutMs = Number(entry.timeoutMs || 0);
  const token = String(entry.apiKey || entry.token || "").trim();
  const credentialConfigured = Boolean(token) || (
    allowRedactedCredential &&
    (entry.apiKeyConfigured === true || entry.tokenConfigured === true)
  );
  const tokenHeader = String(entry.tokenHeader || "").trim();
  if (!AGENT_GATEWAY_MODEL_PROVIDER_SET.has(provider)) {
    return { ready: false, status: "unsupported", reason: "unsupported-provider" };
  }
  if (!alias) {
    return { ready: false, status: "unconfigured", reason: "missing-agent-alias" };
  }
  if (!model) {
    return { ready: false, status: "unconfigured", reason: "missing-model" };
  }
  if (!endpoint) {
    return { ready: false, status: "unconfigured", reason: "missing-endpoint" };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ready: false, status: "unconfigured", reason: "missing-timeout" };
  }
  if (provider !== "local-model" && !credentialConfigured) {
    return { ready: false, status: "unconfigured", reason: "missing-credential" };
  }
  if (credentialConfigured && !tokenHeader) {
    return { ready: false, status: "unconfigured", reason: "missing-credential-header" };
  }
  return { ready: true, status: "available", reason: "" };
}

function publicAgentGatewayEntry(config) {
  const readiness = modelLibraryAgentReadiness(config);
  return {
    alias: config.alias,
    model: config.model || "",
    provider: config.provider || "",
    label: config.label,
    callMode: "server-proxy",
    serverHttpPath: "/api/agent-gateway/call",
    serverRpcMethod: "agent_gateway.call",
    urlConfigured: Boolean(config.url),
    tokenConfigured: Boolean(config.token),
    agentName: config.agentName,
    pluginList: config.pluginList,
    engine: config.engine,
    timeoutMs: config.timeoutMs,
    parameterKeys: Object.keys(asPlainObject(config.parameters)),
    systemPromptConfigured: Boolean(config.systemPrompt),
    status: readiness.status,
    configured: readiness.ready,
    reason: readiness.reason,
    capabilities: readiness.ready ? ["agent.invoke", "gateway.forward"] : []
  };
}

function publicAgentGatewayRegistry(settings = {}) {
  const agents = resolveAgentGatewayRegistry(settings).map(publicAgentGatewayEntry);
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    provider: "agent-gateway",
    defaultAlias: "",
    agents
  };
}

function resolveAgentGatewayConfig(settings = {}, input = {}) {
  const registry = resolveAgentGatewayRegistry(settings);
  const requestedProvider = String(input.provider || "").trim();
  const requestedAlias = adapterAlias(
    input.alias || input.agentAlias || input.modelAlias || "",
    ""
  );
  if (!requestedAlias) {
    return emptyAgentGatewayConfig();
  }
  const matches = registry.filter((entry) => (
    (!requestedProvider || entry.provider === requestedProvider) &&
    entry.alias === requestedAlias
  ));
  if (matches.length === 1) {
    return matches[0];
  }
  return emptyAgentGatewayConfig(requestedAlias, requestedProvider);
}

function publicAgentGatewayConfig(settings = {}, input = {}) {
  const config = resolveAgentGatewayConfig(settings, input);
  return {
    ...config,
    token: "",
    urlConfigured: Boolean(config.url),
    tokenConfigured: Boolean(config.token)
  };
}

function buildAgentGatewayPayload(input = {}, settings = {}) {
  const config = resolveAgentGatewayConfig(settings, input);
  const payload = {
    agentName: String(input.agentName || config.agentName || "").trim(),
    pluginList: asStringList(input.pluginList ?? config.pluginList),
    question: String(input.question || input.query || "").trim(),
    sessionId: String(input.sessionId || "").trim(),
    userId: String(input.userId || "").trim(),
    projectId: String(input.projectId || "").trim(),
    engine: String(input.engine || config.engine || "").trim(),
    parameters: {
      ...config.parameters,
      ...asPlainObject(input.parameters)
    }
  };
  const contextProfileId = String(input.contextProfileId || input.profileId || "").trim();
  const toolGrantId = String(input.toolGrantId || input.grantId || "").trim();
  if (contextProfileId) {
    payload.contextProfileId = contextProfileId;
  }
  if (toolGrantId) {
    payload.toolGrantId = toolGrantId;
    payload.grantId = toolGrantId;
  }
  if (input.workspaceContext && typeof input.workspaceContext === "object" && !Array.isArray(input.workspaceContext)) {
    payload.workspaceContext = {
      workspaceId: String(input.workspaceContext.workspaceId || "").trim(),
      currentGeneration: Number(input.workspaceContext.currentGeneration || 0),
      contextFingerprint: String(input.workspaceContext.contextFingerprint || "").trim(),
      contextProfileId: String(input.workspaceContext.contextProfileId || "").trim(),
      modelAlias: String(input.workspaceContext.modelAlias || "").trim(),
      toolGrantId: String(input.workspaceContext.toolGrantId || "").trim(),
      gatewaySourceIds: asStringList(input.workspaceContext.gatewaySourceIds)
    };
  }
  const systemPrompt = String(input.systemPrompt || config.systemPrompt || "").trim();
  if (systemPrompt) {
    payload.systemPrompt = systemPrompt;
  }
  if (systemPrompt && !payload.parameters.systemPrompt) {
    payload.parameters.systemPrompt = payload.systemPrompt;
  }
  return payload;
}

function resolveModuleAgentProfile(settings = {}, input = {}, config = {}) {
  const moduleId = String(
    input.moduleId || input.featureId || input.functionId || input.module || ""
  ).trim();
  if (!moduleId) {
    return null;
  }
  const alias = String(config.alias || input.alias || input.modelAlias || "").trim();
  if (!alias) {
    return null;
  }
  const group = asPlainObject(settings.moduleAgentProfiles?.[moduleId], null);
  if (!group) {
    return null;
  }
  const agents = asPlainObject(group.agents, null);
  if (!agents || !Object.hasOwn(agents, alias)) {
    return null;
  }
  const profile = asPlainObject(agents[alias], null);
  if (!profile || profile.enabled === false) {
    return null;
  }
  return {
    moduleId,
    alias,
    role: String(profile.role || "").trim(),
    contextProfileId: String(profile.contextProfileId || "").trim(),
    systemPrompt: String(profile.systemPrompt || "").trim(),
    parameters: asPlainObject(profile.parameters),
    dependencyContext: asPlainObject(profile.dependencyContext || profile.dependencies)
  };
}

function withModuleAgentProfileInput(settings = {}, input = {}, config = {}) {
  const profile = resolveModuleAgentProfile(settings, input, config);
  if (!profile) {
    return {
      input,
      profile: null
    };
  }
  const dependencyBlock = {
    moduleId: profile.moduleId,
    agentAlias: profile.alias,
    role: profile.role,
    contextProfileId: profile.contextProfileId,
    sessionId: String(input.sessionId || "").trim(),
    taskId: String(input.taskId || input.runId || "").trim(),
    dependencyContext: profile.dependencyContext
  };
  const modulePrompt = [
    profile.systemPrompt,
    `模块/功能运行上下文：${JSON.stringify(dependencyBlock)}`
  ].filter(Boolean).join("\n\n");
  return {
    profile,
    input: {
      ...input,
      moduleAgentProfile: dependencyBlock,
      systemPrompt: [modulePrompt, input.systemPrompt].filter(Boolean).join("\n\n"),
      parameters: {
        ...profile.parameters,
        ...asPlainObject(input.parameters)
      },
      contextProfileId: input.contextProfileId || profile.contextProfileId || ""
    }
  };
}

function deepSeekChatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim()
    .replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

function chatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

export {
  buildAgentGatewayPayload,
  publicAgentGatewayConfig,
  publicAgentGatewayRegistry,
  resolveAgentGatewayConfig,
  resolveAgentGatewayRegistry,
  withModuleAgentProfileInput
};
