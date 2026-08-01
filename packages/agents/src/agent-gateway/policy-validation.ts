import {
  asPlainObject,
  asStringList,
  normalizeTimeout
} from "./shared.ts";
import {
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "../agent-configs/credential-binding.ts";

export const AGENT_GATEWAY_MODEL_PROVIDERS: readonly any[] = Object.freeze([
  "openai",
  "deepseek",
  "openrouter",
  "copilot",
  "local-model"
]);
const AGENT_GATEWAY_MODEL_PROVIDER_SET: any = new Set<any>(AGENT_GATEWAY_MODEL_PROVIDERS);

function adapterAlias(value?: any, fallback: any = "") : any {
  const normalized: any = String(value || "").trim();
  if (normalized) {
    return normalized;
  }
  return String(fallback || "").trim();
}

function readPresentString(source: Record<string, any> = {}, keys: any = []) : any {
  const value: any = asPlainObject(source);
  for (const key of keys) {
    if (Object.hasOwn(value, key)) {
      return String(value[key] ?? "").trim();
    }
  }
  return undefined;
}

function normalizeDeepSeekEntry(settings: Record<string, any> = {}, entry: Record<string, any> = {}) : any {
  const modelEntry: any = asPlainObject(entry);
  void settings;
  const baseUrl: any = normalizeModelEndpoint(modelEntry.baseUrl || modelEntry.url);
  const modelFieldPresent: any = ["model", "modelId", "engine"].some((key?: any) : any =>
    Object.hasOwn(modelEntry, key)
  );
  const configuredModel: any = readPresentString(modelEntry, ["model", "modelId", "engine"]);
  const model: any = configuredModel ?? "";
  const alias: any = adapterAlias(
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

function normalizeOpenAiCompatibleEntry(settings: Record<string, any> = {}, entry: Record<string, any> = {}, provider: any = "") : any {
  const modelEntry: any = asPlainObject(entry);
  const providerId: any = String(provider || modelEntry.provider || "").trim();
  void settings;
  const model: any = readPresentString(modelEntry, ["model", "modelId", "engine"]) ?? "";
  const alias: any = adapterAlias(
    modelEntry.uid ||
      modelEntry.instanceId ||
      modelEntry.alias ||
      modelEntry.modelAlias,
    ""
  );
  const baseUrl: any = normalizeModelEndpoint(modelEntry.baseUrl || modelEntry.url);
  const token: any = String(modelEntry.apiKey || modelEntry.token || "").trim();
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

function resolveAgentGatewayRegistry(settings: Record<string, any> = {}) : any {
  const entries: any[] = [];
  const seen: any = new Set<any>();
  for (const item of Array.isArray(settings.modelLibraryAgents)
    ? settings.modelLibraryAgents
    : []) {
    const provider: any = String(item?.provider || "").trim();
    if (provider === "deepseek") {
      const config: any = normalizeDeepSeekEntry(settings, item);
      if (config.alias && !seen.has(config.alias)) {
        seen.add(config.alias);
        entries.push(config);
      }
      continue;
    }
    if (["openai", "openrouter", "copilot", "local-model"].includes(provider)) {
      const config: any = normalizeOpenAiCompatibleEntry(settings, item, provider);
      if (config.alias && !seen.has(config.alias)) {
        seen.add(config.alias);
        entries.push(config);
      }
    }
  }

  return entries.filter((entry?: any) : any => entry.alias);
}

function emptyAgentGatewayConfig(alias: any = "", provider: any = "") : any {
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

export function modelLibraryAgentReadiness(entry: Record<string, any> = {}, {
  allowRedactedCredential = false
}: Record<string, any> = {}) : any {
  const provider: any = String(entry.provider || "").trim();
  const alias: any = adapterAlias(
    entry.uid || entry.instanceId || entry.alias || entry.modelAlias,
    ""
  );
  const model: any = readPresentString(entry, ["model", "modelId", "engine"]) ?? "";
  const endpoint: any = String(entry.baseUrl || entry.url || "").trim();
  const timeoutMs: any = Number(entry.timeoutMs || 0);
  const token: any = String(entry.apiKey || entry.token || "").trim();
  const credentialConfigured: any = Boolean(token) || (
    allowRedactedCredential &&
    (entry.apiKeyConfigured === true || entry.tokenConfigured === true)
  );
  const tokenHeader: any = String(entry.tokenHeader || "").trim();
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

function publicAgentGatewayEntry(config?: any) : any {
  const readiness: any = modelLibraryAgentReadiness(config);
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

function publicAgentGatewayRegistry(settings: Record<string, any> = {}) : any {
  const agents: any = resolveAgentGatewayRegistry(settings).map(publicAgentGatewayEntry);
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    provider: "agent-gateway",
    defaultAlias: "",
    agents
  };
}

function resolveAgentGatewayConfig(settings: Record<string, any> = {}, input: Record<string, any> = {}) : any {
  const registry: any = resolveAgentGatewayRegistry(settings);
  const requestedProvider: any = String(input.provider || "").trim();
  const requestedAlias: any = adapterAlias(
    input.alias || input.agentAlias || input.modelAlias || "",
    ""
  );
  if (!requestedAlias) {
    return emptyAgentGatewayConfig();
  }
  const matches: any = registry.filter((entry?: any) : any => (
    (!requestedProvider || entry.provider === requestedProvider) &&
    entry.alias === requestedAlias
  ));
  if (matches.length === 1) {
    return matches[0];
  }
  return emptyAgentGatewayConfig(requestedAlias, requestedProvider);
}

function publicAgentGatewayConfig(settings: Record<string, any> = {}, input: Record<string, any> = {}) : any {
  const config: any = resolveAgentGatewayConfig(settings, input);
  return {
    ...config,
    token: "",
    urlConfigured: Boolean(config.url),
    tokenConfigured: Boolean(config.token)
  };
}

function buildAgentGatewayPayload(input: Record<string, any> = {}, settings: Record<string, any> = {}) : any {
  const config: any = resolveAgentGatewayConfig(settings, input);
  const payload: Record<string, any> = {
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
  const contextProfileId: any = String(input.contextProfileId || input.profileId || "").trim();
  const toolGrantId: any = String(input.toolGrantId || input.grantId || "").trim();
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
  const systemPrompt: any = String(input.systemPrompt || config.systemPrompt || "").trim();
  if (systemPrompt) {
    payload.systemPrompt = systemPrompt;
  }
  if (systemPrompt && !payload.parameters.systemPrompt) {
    payload.parameters.systemPrompt = payload.systemPrompt;
  }
  return payload;
}

function resolveModuleAgentProfile(settings: Record<string, any> = {}, input: Record<string, any> = {}, config: Record<string, any> = {}) : any {
  const moduleId: any = String(
    input.moduleId || input.featureId || input.functionId || input.module || ""
  ).trim();
  if (!moduleId) {
    return null;
  }
  const alias: any = String(config.alias || input.alias || input.modelAlias || "").trim();
  if (!alias) {
    return null;
  }
  const group: any = asPlainObject(settings.moduleAgentProfiles?.[moduleId], null);
  if (!group) {
    return null;
  }
  const agents: any = asPlainObject(group.agents, null);
  if (!agents || !Object.hasOwn(agents, alias)) {
    return null;
  }
  const profile: any = asPlainObject(agents[alias], null);
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

function withModuleAgentProfileInput(settings: Record<string, any> = {}, input: Record<string, any> = {}, config: Record<string, any> = {}) : any {
  const profile: any = resolveModuleAgentProfile(settings, input, config);
  if (!profile) {
    return {
      input,
      profile: null
    };
  }
  const dependencyBlock: Record<string, any> = {
    moduleId: profile.moduleId,
    agentAlias: profile.alias,
    role: profile.role,
    contextProfileId: profile.contextProfileId,
    sessionId: String(input.sessionId || "").trim(),
    taskId: String(input.taskId || input.runId || "").trim(),
    dependencyContext: profile.dependencyContext
  };
  const modulePrompt: any = [
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

function deepSeekChatCompletionsUrl(baseUrl?: any) : any {
  const normalized: any = String(baseUrl || "").trim()
    .replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

function chatCompletionsUrl(baseUrl?: any) : any {
  const normalized: any = String(baseUrl || "").trim().replace(/\/+$/, "");
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
