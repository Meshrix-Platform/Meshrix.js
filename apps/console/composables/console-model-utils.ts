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

const intelligentModuleIds: any = new Set<any>(intelligentModuleDefinitions.map((definition?: any) : any => definition.id));

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeModelLibraryEntries(value: unknown): CloudProvider[] {
  const allowed: any = new Set<any>(modelLibraryProviderDefinitions.map((item?: any) : any => item.id));
  const entries: any = Array.isArray(value) ? value : [];
  const seen: any = new Set<string>();
  return entries
    .map((item?: any) : any => String(item || "").trim() as CloudProvider)
    .filter((item?: any) : any => {
      if (!allowed.has(item) || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

export function modelAgentUid(...parts: unknown[]) : any {
  const source: any = parts
    .map((part?: any) : any => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n") || String(Date.now());
  let hash: any = 2166136261;
  let hash2: any = 2166136261;
  for (let index: any = 0; index < source.length; index += 1) {
    const code: any = source.charCodeAt(index);
    hash ^= code;
    hash = Math.imul(hash, 16777619);
    hash2 ^= code + index + 1;
    hash2 = Math.imul(hash2, 16777619);
  }
  const partA: any = (hash >>> 0).toString(16).padStart(8, "0");
  const partB: any = (hash2 >>> 0).toString(16).padStart(8, "0");
  return `agent_${partA}${partB}`;
}

export function modelEntryStringField(entry: Partial<AgentModelConfig>, keys: string[]) : any {
  const record: any = asRecord(entry) || {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return String(record[key] ?? "").trim();
    }
  }
  return undefined;
}

export function modelProviderLabel(provider: CloudProvider | string) : any {
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
  index: any = 0,
): AgentModelConfig {
  const provider: any = String(entry.provider || "") as CloudProvider;
  const model: any = modelEntryStringField(entry, ["model", "engine"]) ?? "";
  const label: any =
    modelEntryStringField(entry, ["label", "agentName"]) ?? "";
  const agentName: any = modelEntryStringField(entry, ["agentName", "label"]) ?? "";
  const engine: any = modelEntryStringField(entry, ["engine"]) ?? "";
  const existingInstanceId: any = String(entry.instanceId || "").trim();
  const explicitUid: any = String(entry.uid || "").trim();
  const existingAlias: any = String(entry.alias || "").trim();
  const uid: any = explicitUid ||
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
  const prefix: any = String(value ?? "");
  if (/[\r\n\0]/u.test(prefix)) {
    throw new TypeError("模型凭据前缀不能包含换行或 NUL 字符。");
  }
  return prefix;
}

function normalizeTokenHeader(value: unknown): string {
  const header: any = String(value ?? "").trim();
  if (!header) return "";
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(header)) {
    throw new TypeError("模型凭据请求头不是合法的 HTTP 字段名。");
  }
  if (new Set<any>([
    "connection", "content-length", "cookie", "host", "keep-alive",
    "proxy-connection", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
  ]).has(header.toLowerCase())) {
    throw new TypeError("模型凭据请求头不能使用保留或逐跳字段。");
  }
  return header;
}

function normalizeModelEndpoint(value: unknown): string {
  const endpoint: any = String(value ?? "").trim();
  if (!endpoint) return "";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TypeError("模型端点必须是绝对 HTTP(S) URL。");
  }
  if (!new Set<any>(["http:", "https:"]).has(parsed.protocol)) {
    throw new TypeError("模型端点必须使用 HTTP 或 HTTPS。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("模型端点不能包含用户信息、查询参数或片段。");
  }
  return endpoint;
}

export function normalizeAgentModuleAccess(value?: Partial<AgentModuleAccess>): AgentModuleAccess {
  const record: any = asRecord(value) || {};
  const mode: any = String(record.mode || "").trim() === "all" ? "all" : "selected";
  const moduleIds: any = Array.isArray(record.moduleIds)
    ? record.moduleIds
      .map((item?: any) : any => String(item || "").trim())
      .filter((item?: any) : any => item && intelligentModuleIds.has(item))
    : [];
  return {
    mode,
    moduleIds: [...new Set<any>(moduleIds)],
  };
}

export function modelEntryParameters(entry: AgentModelConfig) : any {
  try {
    return JSON.parse(String(entry.parametersText || "{}"));
  } catch {
    return asRecord(entry.parameters) || {};
  }
}

export function redactAgentModelEntryForExport(entry: AgentModelConfig) : any {
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
) : any {
  return { provider: String(entry.provider || "") };
}

export function moduleAgentProfileJson(value?: string, fallback?: Record<string, unknown>) : any {
  try {
    const parsed: any = JSON.parse(String(value || "{}"));
    return asRecord(parsed) || {};
  } catch {
    return fallback || {};
  }
}

export function normalizeModuleAgentProfile(profile?: Partial<ModuleAgentProfile>): ModuleAgentProfile {
  const incoming: any = profile || {};
  const parameters: any = moduleAgentProfileJson(incoming.parametersText, asRecord(incoming.parameters) || {});
  const dependencyContext: any = moduleAgentProfileJson(
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

export function normalizeModuleAgentProfilesForDraft(settings: AgentSettings) : any {
  const incoming: any = asRecord(settings.moduleAgentProfiles) || {};
  const next: AgentSettings["moduleAgentProfiles"] = {};
  for (const moduleDefinition of intelligentModuleDefinitions) {
    const group: any = asRecord(incoming[moduleDefinition.id]) || {};
    const agents: any = asRecord(group.agents) || {};
    const nextAgents: Record<string, ModuleAgentProfile> = {};
    for (const [agentId, profile] of (Object.entries(agents) as [string, any][])) {
      const normalizedAgentId: any = String(agentId || "").trim();
      if (!normalizedAgentId) {
        continue;
      }
      nextAgents[normalizedAgentId] = normalizeModuleAgentProfile(profile as Partial<ModuleAgentProfile>);
    }
    const primaryAgent: any = String(group.primaryAgent || "").trim();
    if (primaryAgent || Object.keys(nextAgents).length > 0) {
      next[moduleDefinition.id] = {
        primaryAgent,
        agents: nextAgents,
      };
    }
  }
  return next;
}

export function normalizeAgentLocalCommandsForDraft(settings: AgentSettings) : any {
  const localSettings: any = settings.agentToolExecution?.local || emptySettings.agentToolExecution.local;
  const commands: any = Array.isArray(localSettings.commands)
    ? localSettings.commands
    : emptySettings.agentToolExecution.local.commands;
  return commands
    .map((item?: any, index?: any) : any => {
      void index;
      const commandId: any = String(item.commandId || "").trim();
      const command: any = String(item.command || "").trim();
      const variables: any = Array.isArray(item.variables) ? item.variables : [];
      const rawArgs: any = Array.isArray(item.args) ? item.args.map((arg?: any) : any => String(arg)) : [];
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
    .filter((item?: any) : any => item.commandId && item.command);
}
