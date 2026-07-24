import type {
  AgentModelConfig,
  AgentModuleAccess,
  AgentSettings,
  ModuleAgentProfile,
} from "../lib/types";
import type { CloudProvider } from "../types/app";
import {
  emptySettings,
  intelligentModuleDefinitions,
  modelLibraryProviderDefinitions,
} from "./console-defaults";

const intelligentModuleIds = new Set(intelligentModuleDefinitions.map((definition) => definition.id));

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeModelLibraryEntries(value: unknown): CloudProvider[] {
  const allowed = new Set(modelLibraryProviderDefinitions.map((item) => item.id));
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  return entries
    .map((item) => String(item || "").trim() as CloudProvider)
    .filter((item: any) => {
      if (!allowed.has(item) || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

export function modelAgentUid(...parts: unknown[]) {
  const source = parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n") || String(Date.now());
  let hash = 2166136261;
  let hash2 = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    hash ^= code;
    hash = Math.imul(hash, 16777619);
    hash2 ^= code + index + 1;
    hash2 = Math.imul(hash2, 16777619);
  }
  const partA = (hash >>> 0).toString(16).padStart(8, "0");
  const partB = (hash2 >>> 0).toString(16).padStart(8, "0");
  return `agent_${partA}${partB}`;
}

export function modelEntryStringField(entry: Partial<AgentModelConfig>, keys: string[]) {
  const record = asRecord(entry) || {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return String(record[key] ?? "").trim();
    }
  }
  return undefined;
}

export function modelProviderLabel(provider: CloudProvider | string) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "deepseek":
      return "DeepSeek";
    case "copilot":
      return "Copilot";
    case "local-model":
      return "本地模型";
    default:
      return provider || "未知";
  }
}

export function normalizeAgentModelEntry(
  entry: Partial<AgentModelConfig>,
  index = 0,
): AgentModelConfig {
  const provider = String(entry.provider || "") as CloudProvider;
  const model = modelEntryStringField(entry, ["model", "engine"]) ?? "";
  const label =
    modelEntryStringField(entry, ["label", "agentName"]) ?? "";
  const agentName = modelEntryStringField(entry, ["agentName", "label"]) ?? "";
  const engine = modelEntryStringField(entry, ["engine"]) ?? "";
  const existingInstanceId = String(entry.instanceId || "").trim();
  const explicitUid = String(entry.uid || "").trim();
  const existingAlias = String(entry.alias || "").trim();
  const uid = explicitUid ||
    existingInstanceId ||
    existingAlias;
  void index;
  return {
    uid,
    instanceId: uid,
    provider,
    alias: uid,
    label,
    baseUrl: normalizeModelEndpoint(entry.baseUrl),
    url: normalizeModelEndpoint(entry.url),
    model,
    apiKey: String(entry.apiKey || "").trim(),
    apiKeyConfigured: entry.apiKeyConfigured === true,
    token: String(entry.token || "").trim(),
    tokenConfigured: entry.tokenConfigured === true,
    tokenHeader: normalizeTokenHeader(entry.tokenHeader),
    tokenPrefix: normalizeTokenPrefix(entry.tokenPrefix),
    agentName,
    engine,
    pluginList: Array.isArray(entry.pluginList) ? entry.pluginList : [],
    systemPrompt: String(entry.systemPrompt || "").trim(),
    parameters: asRecord(entry.parameters) || {},
    moduleAccess: normalizeAgentModuleAccess(entry.moduleAccess),
    parametersText:
      String(entry.parametersText || "").trim() ||
      JSON.stringify(asRecord(entry.parameters) || {}, null, 2),
    timeoutMs: Number(entry.timeoutMs || 0),
  };
}

function normalizeTokenPrefix(value: unknown): string {
  const prefix = String(value ?? "");
  if (/[\r\n\0]/u.test(prefix)) {
    throw new TypeError("模型凭据前缀不能包含换行或 NUL 字符。");
  }
  return prefix;
}

function normalizeTokenHeader(value: unknown): string {
  const header = String(value ?? "").trim();
  if (!header) return "";
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(header)) {
    throw new TypeError("模型凭据请求头不是合法的 HTTP 字段名。");
  }
  if (new Set([
    "connection", "content-length", "cookie", "host", "keep-alive",
    "proxy-connection", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
  ]).has(header.toLowerCase())) {
    throw new TypeError("模型凭据请求头不能使用保留或逐跳字段。");
  }
  return header;
}

function normalizeModelEndpoint(value: unknown): string {
  const endpoint = String(value ?? "").trim();
  if (!endpoint) return "";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("模型端点必须是绝对 HTTP(S) URL。");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new TypeError("模型端点必须使用 HTTP 或 HTTPS。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("模型端点不能包含用户信息、查询参数或片段。");
  }
  return endpoint;
}

export function normalizeAgentModuleAccess(value?: Partial<AgentModuleAccess>): AgentModuleAccess {
  const record = asRecord(value) || {};
  const mode = String(record.mode || "").trim() === "all" ? "all" : "selected";
  const moduleIds = Array.isArray(record.moduleIds)
    ? record.moduleIds
      .map((item) => String(item || "").trim())
      .filter((item) => item && intelligentModuleIds.has(item))
    : [];
  return {
    mode,
    moduleIds: [...new Set(moduleIds)],
  };
}

export function modelEntryParameters(entry: AgentModelConfig) {
  try {
    return JSON.parse(String(entry.parametersText || "{}"));
  } catch {
    return asRecord(entry.parameters) || {};
  }
}

export function redactAgentModelEntryForExport(entry: AgentModelConfig) {
  return {
    ...entry,
    apiKey: "",
    apiKeyConfigured: Boolean(entry.apiKey || entry.apiKeyConfigured),
    token: "",
    tokenConfigured: Boolean(entry.token || entry.tokenConfigured),
  };
}

export function redactedProviderSettingsForAgentExport(
  entry: AgentModelConfig,
) {
  return { provider: String(entry.provider || "") };
}

export function moduleAgentProfileJson(value?: string, fallback?: Record<string, unknown>) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return asRecord(parsed) || {};
  } catch {
    return fallback || {};
  }
}

export function normalizeModuleAgentProfile(profile?: Partial<ModuleAgentProfile>): ModuleAgentProfile {
  const incoming = profile || {};
  const parameters = moduleAgentProfileJson(incoming.parametersText, asRecord(incoming.parameters) || {});
  const dependencyContext = moduleAgentProfileJson(
    incoming.dependencyContextText,
    asRecord(incoming.dependencyContext) || {},
  );
  return {
    enabled: incoming.enabled === true,
    role: String(incoming.role || "").trim(),
    contextProfileId: String(incoming.contextProfileId || "").trim(),
    systemPrompt: String(incoming.systemPrompt || "").trim(),
    parameters,
    parametersText: String(incoming.parametersText || "").trim() || JSON.stringify(parameters, null, 2),
    dependencyContext,
    dependencyContextText:
      String(incoming.dependencyContextText || "").trim() ||
      JSON.stringify(dependencyContext, null, 2),
  };
}

export function normalizeModuleAgentProfilesForDraft(settings: AgentSettings) {
  const incoming = asRecord(settings.moduleAgentProfiles) || {};
  const next: AgentSettings["moduleAgentProfiles"] = {};
  for (const moduleDefinition of intelligentModuleDefinitions) {
    const group = asRecord(incoming[moduleDefinition.id]) || {};
    const agents = asRecord(group.agents) || {};
    const nextAgents: Record<string, ModuleAgentProfile> = {};
    for (const [agentId, profile] of Object.entries(agents)) {
      const normalizedAgentId = String(agentId || "").trim();
      if (!normalizedAgentId) {
        continue;
      }
      nextAgents[normalizedAgentId] = normalizeModuleAgentProfile(profile as Partial<ModuleAgentProfile>);
    }
    const primaryAgent = String(group.primaryAgent || "").trim();
    if (primaryAgent || Object.keys(nextAgents).length > 0) {
      next[moduleDefinition.id] = {
        primaryAgent,
        agents: nextAgents,
      };
    }
  }
  return next;
}

export function normalizeAgentLocalCommandsForDraft(settings: AgentSettings) {
  const localSettings = settings.agentToolExecution?.local || emptySettings.agentToolExecution.local;
  const commands = Array.isArray(localSettings.commands)
    ? localSettings.commands
    : emptySettings.agentToolExecution.local.commands;
  return commands
    .map((item, index) => {
      void index;
      const commandId = String(item.commandId || "").trim();
      const command = String(item.command || "").trim();
      const variables = Array.isArray(item.variables) ? item.variables : [];
      const rawArgs = Array.isArray(item.args) ? item.args.map((arg) => String(arg)) : [];
      return {
        ...item,
        commandId,
        label: String(item.label || "").trim(),
        command,
        args: rawArgs,
        cwd: String(item.cwd || "").trim(),
        description: String(item.description || "").trim(),
        variables,
        allowExtraArgs: item.allowExtraArgs === true,
      };
    })
    .filter((item) => item.commandId && item.command);
}
