
import crypto from "node:crypto";
import { safeUrlSummary } from "@lico/agents/agent-gateway/shared";
import {
  modelCredentialBindingKey,
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "@lico/agents/agent-configs/credential-binding";
import { publishProtocolEvent } from "./shared.mjs";

function settingsPortFrom(context = {}) {
  const settingsPort = context.settingsPort;
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.saveSettings !== "function" ||
    typeof settingsPort.normalizeSettings !== "function"
  ) {
    throw new TypeError("Settings operations require an explicit settings port.");
  }
  return settingsPort;
}

export function agentRuntimeProviderFrom(context = {}) {
  return context.agentRuntimeProvider || null;
}

export function agentConfigRegistryFrom(context = {}) {
  const provider = agentRuntimeProviderFrom(context);
  if (typeof provider?.getAgentConfigRegistry === "function") {
    return provider.getAgentConfigRegistry();
  }
  return null;
}

export function normalizeModelLibraryAgentAuditAgent(entry = {}) {
  const provider = String(entry.provider || "").trim();
  const model = String(entry.model || entry.engine || "").trim();
  const alias = String(entry.alias || entry.uid || entry.instanceId || "").trim();
  const agentName = String(entry.agentName || entry.label || alias || "").trim();
  return {
    uid: alias,
    provider,
    model,
    agentName,
    endpoint: safeUrlSummary(entry.baseUrl || entry.url),
    timeoutMs: Number(entry.timeoutMs || 0),
    apiKeyConfigured: Boolean(entry.apiKey || entry.token || entry.apiKeyConfigured || entry.tokenConfigured)
  };
}

export function normalizeModelLibraryAuditList(models = []) {
  const normalized = [];
  for (const model of Array.isArray(models) ? models : []) {
    const item = normalizeModelLibraryAgentAuditAgent(model);
    if (!item.provider && !item.model && !item.uid) {
      continue;
    }
    normalized.push(item);
  }
  normalized.sort((left, right) => {
    const providerSort = String(left.provider || "").localeCompare(String(right.provider || ""));
    if (providerSort !== 0) {
      return providerSort;
    }
    const modelSort = String(left.model || "").localeCompare(String(right.model || ""));
    if (modelSort !== 0) {
      return modelSort;
    }
    return String(left.uid || "").localeCompare(String(right.uid || ""));
  });
  return {
    total: normalized.length,
    providers: [...new Set(normalized.map((item) => String(item.provider || "").trim()).filter(Boolean))],
    items: normalized
  };
}

export function modelLibraryAgentAuditKey(entry = {}) {
  const uid = String(entry.uid || "").trim();
  const provider = String(entry.provider || "").trim();
  const model = String(entry.model || entry.engine || "").trim();
  const alias = String(entry.alias || entry.agentName || entry.label || "").trim();
  if (uid) {
    return uid;
  }
  return `${provider}::${model}::${alias}`;
}

export function diffModelLibraryAgents(before = [], after = []) {
  const beforeMap = new Map(
    (Array.isArray(before) ? before : [])
      .map((agent) => [modelLibraryAgentAuditKey(agent), normalizeModelLibraryAgentAuditAgent(agent)])
      .filter(([key]) => String(key).trim().length > 0)
  );
  const afterMap = new Map(
    (Array.isArray(after) ? after : [])
      .map((agent) => [modelLibraryAgentAuditKey(agent), normalizeModelLibraryAgentAuditAgent(agent)])
      .filter(([key]) => String(key).trim().length > 0)
  );
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, next] of afterMap.entries()) {
    const previous = beforeMap.get(key) || null;
    if (!previous) {
      added.push(next);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changed.push({ before: previous, after: next, key });
    }
  }
  for (const [key, item] of beforeMap.entries()) {
    if (!afterMap.has(key)) {
      removed.push(item);
    }
  }
  return {
    beforeCount: beforeMap.size,
    afterCount: afterMap.size,
    added,
    removed,
    changed
  };
}

export function preserveModelLibrarySecretsForProbe(incomingModels, currentSettings = {}) {
  if (!Array.isArray(incomingModels)) {
    return incomingModels;
  }
  const currentModels = Array.isArray(currentSettings.modelLibraryAgents)
    ? currentSettings.modelLibraryAgents
    : [];
  const currentByBinding = new Map();
  for (const model of currentModels) {
    const binding = modelCredentialBindingKey(model);
    if (binding) {
      currentByBinding.set(binding, model);
    }
  }
  return incomingModels.map((model) => {
    const binding = modelCredentialBindingKey(model);
    const current = binding ? currentByBinding.get(binding) : null;
    if (!current) {
      return model;
    }
    const next = { ...model };
    if (
      (!Object.hasOwn(next, "apiKey") || (!String(next.apiKey || "").trim() && next.apiKeyConfigured === true)) &&
      current.apiKey
    ) {
      next.apiKey = current.apiKey;
    }
    if (
      (!Object.hasOwn(next, "token") || (!String(next.token || "").trim() && next.tokenConfigured === true)) &&
      current.token
    ) {
      next.token = current.token;
    }
    return next;
  });
}

export function mergeSettingsForModelProbe(currentSettings = {}, incomingSettings = {}, normalizeSettings) {
  if (typeof normalizeSettings !== "function") {
    throw new TypeError("mergeSettingsForModelProbe requires normalizeSettings from the settings port.");
  }
  const current = normalizeSettings(currentSettings);
  const incoming = incomingSettings && typeof incomingSettings === "object" ? incomingSettings : {};
  const nextSettings = {
    ...current,
    ...incoming
  };

  if (Array.isArray(incoming?.modelLibraryAgents)) {
    nextSettings.modelLibraryAgents = preserveModelLibrarySecretsForProbe(
      incoming.modelLibraryAgents,
      current
    );
  }

  return normalizeSettings(nextSettings);
}

export function normalizeAgentStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function normalizeAgentParameters(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeAgentModelPayload(payload = {}) {
  const source = payload?.agent || payload?.value || payload?.config || payload || {};
  const patch = {};
  const assignString = (target, keys) => {
    for (const key of keys) {
      if (Object.hasOwn(source, key)) {
        const value = source[key];
        patch[target] = String(value ?? "").trim();
        return;
      }
    }
  };

  assignString("uid", ["uid", "agentId"]);
  assignString("provider", ["provider", "modelProvider"]);
  assignString("label", ["name", "label", "agentName"]);
  assignString("model", ["model", "modelId", "engine"]);
  for (const [target, keys] of [
    ["baseUrl", ["baseUrl", "base_url"]],
    ["url", ["url", "endpoint"]]
  ]) {
    for (const key of keys) {
      if (Object.hasOwn(source, key)) {
        patch[target] = normalizeModelEndpoint(source[key]);
        break;
      }
    }
  }
  for (const [target, keys, configuredKey] of [
    ["apiKey", ["apiKey", "api_key", "key"], "apiKeyConfigured"],
    ["token", ["token"], "tokenConfigured"]
  ]) {
    let assigned = false;
    for (const key of keys) {
      if (Object.hasOwn(source, key)) {
        const value = String(source[key] ?? "").trim();
        patch[target] = value;
        patch[configuredKey] = Boolean(value);
        assigned = true;
        break;
      }
    }
    if (!assigned && Object.hasOwn(source, configuredKey)) {
      patch[configuredKey] = source[configuredKey] === true;
    }
  }
  for (const key of ["tokenHeader", "token_header"]) {
    if (Object.hasOwn(source, key)) {
      patch.tokenHeader = normalizeModelTokenHeader(source[key]);
      break;
    }
  }
  for (const key of ["tokenPrefix", "token_prefix"]) {
    if (Object.hasOwn(source, key)) {
      patch.tokenPrefix = normalizeModelTokenPrefix(source[key]);
      break;
    }
  }
  assignString("systemPrompt", ["systemPrompt", "prompt"]);

  if (source.parameters !== undefined || source.parametersText !== undefined) {
    patch.parameters = normalizeAgentParameters(source.parameters ?? source.parametersText);
  }
  if (source.pluginList !== undefined || source.plugins !== undefined) {
    patch.pluginList = normalizeAgentStringList(source.pluginList ?? source.plugins);
  }
  if (source.timeoutMs !== undefined && source.timeoutMs !== null && source.timeoutMs !== "") {
    const timeoutMs = Number(source.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      patch.timeoutMs = timeoutMs;
    }
  }
  return patch;
}

export function applyAgentModelPatch(previous = {}, patch = {}) {
  const previousBinding = modelCredentialBindingKey(previous);
  const next = {
    ...previous,
    ...patch,
    uid: previous.uid || previous.instanceId || previous.alias || "",
    instanceId: previous.instanceId || previous.uid || previous.alias || "",
    alias: previous.alias || previous.uid || previous.instanceId || ""
  };
  const bindingChanged = Boolean(previousBinding) &&
    modelCredentialBindingKey(next) !== previousBinding;
  for (const [secretKey, configuredKey] of [
    ["apiKey", "apiKeyConfigured"],
    ["token", "tokenConfigured"]
  ]) {
    const secretExplicit = Object.hasOwn(patch, secretKey);
    const clearExplicit = Object.hasOwn(patch, configuredKey) && patch[configuredKey] === false;
    if (clearExplicit || (bindingChanged && !secretExplicit)) {
      next[secretKey] = "";
    }
    next[configuredKey] = Boolean(String(next[secretKey] || "").trim());
  }
  return next;
}

export function sanitizeAgentPatchForLog(patch = {}) {
  const safe = {};
  const entries = Object.entries(patch || {});
  for (const [key, value] of entries) {
    if (["apiKey", "token", "apiKeyConfigured", "tokenConfigured"].includes(key)) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export function createAgentUid(entry = {}) {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        entry.provider || "",
        entry.label || entry.agentName || "",
        entry.model || entry.engine || "",
        entry.baseUrl || entry.url || "",
        crypto.randomUUID()
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 16);
  return `agent_${digest}`;
}

export function agentModelIdentity(entry = {}) {
  return [entry.uid, entry.instanceId, entry.alias, entry.id]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

export function findAgentModelIndex(models = [], agentId = "") {
  const id = String(agentId || "").trim();
  if (!id) {
    return -1;
  }
  return models.findIndex((entry) => agentModelIdentity(entry).includes(id));
}

export function agentModelProviders(models = []) {
  return [
    ...new Set(
      models
        .map((entry) => String(entry.provider || "").trim())
        .filter(Boolean)
    )
  ];
}

export async function loadAgentRuntimeSettings(context = {}, options = {}) {
  return settingsPortFrom(context).loadSettings(context.userDataPath, options);
}

export async function saveAgentModelLibrary(context = {}, current, models) {
  const agentRuntimeProvider = agentRuntimeProviderFrom(context);
  if (!agentRuntimeProvider || typeof agentRuntimeProvider.publicAgentGatewayRegistry !== "function") {
    throw new Error("Agent gateway runtime provider is not configured.");
  }
  const settingsPort = settingsPortFrom(context);
  const saved = await settingsPort.saveSettings(context.userDataPath, {
    ...current,
    modelLibraryAgents: models,
    modelLibraryEntries: agentModelProviders(models),
    modelLibraryAgentIds: models.map((model) => model.uid || model.instanceId || model.alias).filter(Boolean)
  });
  const redactedSettings = await loadAgentRuntimeSettings(context, { redactSecrets: true });
  await publishProtocolEvent(
    context.protocolEventBus,
    "settings.current",
    redactedSettings,
    { type: "settings.updated" }
  );
  return {
    saved,
    registry: await agentRuntimeProvider.publicAgentGatewayRegistry(saved)
  };
}
