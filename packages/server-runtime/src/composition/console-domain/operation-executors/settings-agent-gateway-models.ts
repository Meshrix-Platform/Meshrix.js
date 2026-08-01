
import crypto from "node:crypto";
import { safeUrlSummary } from "@meshrix/agents/agent-gateway/shared";
import {
  modelCredentialBindingKey,
  normalizeModelEndpoint,
  normalizeModelTokenHeader,
  normalizeModelTokenPrefix
} from "@meshrix/agents/agent-configs/credential-binding";
import { publishProtocolEvent } from "./shared.ts";

function settingsPortFrom(context: Record<string, any> = {}) : any {
  const settingsPort: any = context.settingsPort;
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

export function agentRuntimeProviderFrom(context: Record<string, any> = {}) : any {
  return context.agentRuntimeProvider || null;
}

export function agentConfigRegistryFrom(context: Record<string, any> = {}) : any {
  const provider: any = agentRuntimeProviderFrom(context);
  if (typeof provider?.getAgentConfigRegistry === "function") {
    return provider.getAgentConfigRegistry();
  }
  return null;
}

export function normalizeModelLibraryAgentAuditAgent(entry: Record<string, any> = {}) : any {
  const provider: any = String(entry.provider || "").trim();
  const model: any = String(entry.model || entry.engine || "").trim();
  const alias: any = String(entry.alias || entry.uid || entry.instanceId || "").trim();
  const agentName: any = String(entry.agentName || entry.label || alias || "").trim();
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

export function normalizeModelLibraryAuditList(models: any = []) : any {
  const normalized: any[] = [];
  for (const model of Array.isArray(models) ? models : []) {
    const item: any = normalizeModelLibraryAgentAuditAgent(model);
    if (!item.provider && !item.model && !item.uid) {
      continue;
    }
    normalized.push(item);
  }
  normalized.sort((left?: any, right?: any) : any => {
    const providerSort: any = String(left.provider || "").localeCompare(String(right.provider || ""));
    if (providerSort !== 0) {
      return providerSort;
    }
    const modelSort: any = String(left.model || "").localeCompare(String(right.model || ""));
    if (modelSort !== 0) {
      return modelSort;
    }
    return String(left.uid || "").localeCompare(String(right.uid || ""));
  });
  return {
    total: normalized.length,
    providers: [...new Set<any>(normalized.map((item?: any) : any => String(item.provider || "").trim()).filter(Boolean))],
    items: normalized
  };
}

export function modelLibraryAgentAuditKey(entry: Record<string, any> = {}) : any {
  const uid: any = String(entry.uid || "").trim();
  const provider: any = String(entry.provider || "").trim();
  const model: any = String(entry.model || entry.engine || "").trim();
  const alias: any = String(entry.alias || entry.agentName || entry.label || "").trim();
  if (uid) {
    return uid;
  }
  return `${provider}::${model}::${alias}`;
}

export function diffModelLibraryAgents(before: any = [], after: any = []) : any {
  const beforeMap: any = new Map<any, any>(
    (Array.isArray(before) ? before : [])
      .map((agent?: any) : any => [modelLibraryAgentAuditKey(agent), normalizeModelLibraryAgentAuditAgent(agent)])
      .filter(([key]: any[]) : any => String(key).trim().length > 0)
  );
  const afterMap: any = new Map<any, any>(
    (Array.isArray(after) ? after : [])
      .map((agent?: any) : any => [modelLibraryAgentAuditKey(agent), normalizeModelLibraryAgentAuditAgent(agent)])
      .filter(([key]: any[]) : any => String(key).trim().length > 0)
  );
  const added: any[] = [];
  const removed: any[] = [];
  const changed: any[] = [];
  for (const [key, next] of afterMap.entries()) {
    const previous: any = beforeMap.get(key) || null;
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

export function preserveModelLibrarySecretsForProbe(incomingModels?: any, currentSettings: Record<string, any> = {}) : any {
  if (!Array.isArray(incomingModels)) {
    return incomingModels;
  }
  const currentModels: any = Array.isArray(currentSettings.modelLibraryAgents)
    ? currentSettings.modelLibraryAgents
    : [];
  const currentByBinding: any = new Map<any, any>();
  for (const model of currentModels) {
    const binding: any = modelCredentialBindingKey(model);
    if (binding) {
      currentByBinding.set(binding, model);
    }
  }
  return incomingModels.map((model?: any) : any => {
    const binding: any = modelCredentialBindingKey(model);
    const current: any = binding ? currentByBinding.get(binding) : null;
    if (!current) {
      return model;
    }
    const next: Record<string, any> = { ...model };
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

export function mergeSettingsForModelProbe(currentSettings: Record<string, any> = {}, incomingSettings: Record<string, any> = {}, normalizeSettings?: any) : any {
  if (typeof normalizeSettings !== "function") {
    throw new TypeError("mergeSettingsForModelProbe requires normalizeSettings from the settings port.");
  }
  const current: any = normalizeSettings(currentSettings);
  const incoming: any = incomingSettings && typeof incomingSettings === "object" ? incomingSettings : {};
  const nextSettings: Record<string, any> = {
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

export function normalizeAgentStringList(value?: any) : any {
  if (Array.isArray(value)) {
    return value.map((item?: any) : any => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item?: any) : any => item.trim()).filter(Boolean);
  }
  return [];
}

export function normalizeAgentParameters(value?: any) : any {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed: any = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeAgentModelPayload(payload: Record<string, any> = {}) : any {
  const source: any = payload?.agent || payload?.value || payload?.config || payload || {};
  const patch: Record<string, any> = {};
  const assignString: any = (target?: any, keys?: any) : any => {
    for (const key of keys) {
      if (Object.hasOwn(source, key)) {
        const value: any = source[key];
        patch[target] = String(value ?? "").trim();
        return;
      }
    }
  };

  assignString("uid", ["uid", "agentId"]);
  assignString("provider", ["provider", "modelProvider"]);
  assignString("label", ["name", "label", "agentName"]);
  assignString("model", ["model", "modelId", "engine"]);
  for (const [target, keys] of ([
    ["baseUrl", ["baseUrl", "base_url"]],
    ["url", ["url", "endpoint"]]
  ] as any[])) {
    for (const key of keys) {
      if (Object.hasOwn(source, key)) {
        patch[target] = normalizeModelEndpoint(source[key]);
        break;
      }
    }
  }
  for (const [target, keys, configuredKey] of ([
    ["apiKey", ["apiKey", "api_key", "key"], "apiKeyConfigured"],
    ["token", ["token"], "tokenConfigured"]
  ] as any[])) {
    let assigned: any = false;
    for (const key of keys) {
      if (Object.hasOwn(source, key)) {
        const value: any = String(source[key] ?? "").trim();
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
    const timeoutMs: any = Number(source.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      patch.timeoutMs = timeoutMs;
    }
  }
  return patch;
}

export function applyAgentModelPatch(previous: Record<string, any> = {}, patch: Record<string, any> = {}) : any {
  const previousBinding: any = modelCredentialBindingKey(previous);
  const next: Record<string, any> = {
    ...previous,
    ...patch,
    uid: previous.uid || previous.instanceId || previous.alias || "",
    instanceId: previous.instanceId || previous.uid || previous.alias || "",
    alias: previous.alias || previous.uid || previous.instanceId || ""
  };
  const bindingChanged: any = Boolean(previousBinding) &&
    modelCredentialBindingKey(next) !== previousBinding;
  for (const [secretKey, configuredKey] of [
    ["apiKey", "apiKeyConfigured"],
    ["token", "tokenConfigured"]
  ]) {
    const secretExplicit: any = Object.hasOwn(patch, secretKey);
    const clearExplicit: any = Object.hasOwn(patch, configuredKey) && patch[configuredKey] === false;
    if (clearExplicit || (bindingChanged && !secretExplicit)) {
      next[secretKey] = "";
    }
    next[configuredKey] = Boolean(String(next[secretKey] || "").trim());
  }
  return next;
}

export function sanitizeAgentPatchForLog(patch: Record<string, any> = {}) : any {
  const safe: Record<string, any> = {};
  const entries: any = (Object.entries(patch || {}) as [string, any][]);
  for (const [key, value] of entries) {
    if (["apiKey", "token", "apiKeyConfigured", "tokenConfigured"].includes(key)) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export function createAgentUid(entry: Record<string, any> = {}) : any {
  const digest: any = crypto
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

export function agentModelIdentity(entry: Record<string, any> = {}) : any {
  return [entry.uid, entry.instanceId, entry.alias, entry.id]
    .map((item?: any) : any => String(item || "").trim())
    .filter(Boolean);
}

export function findAgentModelIndex(models: any = [], agentId: any = "") : any {
  const id: any = String(agentId || "").trim();
  if (!id) {
    return -1;
  }
  return models.findIndex((entry?: any) : any => agentModelIdentity(entry).includes(id));
}

export function agentModelProviders(models: any = []) : any {
  return [
    ...new Set<any>(
      models
        .map((entry?: any) : any => String(entry.provider || "").trim())
        .filter(Boolean)
    )
  ];
}

export async function loadAgentRuntimeSettings(context: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> {
  return settingsPortFrom(context).loadSettings(context.userDataPath, options);
}

export async function saveAgentModelLibrary(context: Record<string, any> = {}, current?: any, models?: any) : Promise<any> {
  const agentRuntimeProvider: any = agentRuntimeProviderFrom(context);
  if (!agentRuntimeProvider || typeof agentRuntimeProvider.publicAgentGatewayRegistry !== "function") {
    throw new Error("Agent gateway runtime provider is not configured.");
  }
  const settingsPort: any = settingsPortFrom(context);
  const saved: any = await settingsPort.saveSettings(context.userDataPath, {
    ...current,
    modelLibraryAgents: models,
    modelLibraryEntries: agentModelProviders(models),
    modelLibraryAgentIds: models.map((model?: any) : any => model.uid || model.instanceId || model.alias).filter(Boolean)
  });
  const redactedSettings: any = await loadAgentRuntimeSettings(context, { redactSecrets: true });
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
