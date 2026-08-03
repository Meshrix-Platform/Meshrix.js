import { buildClientConnectionList } from "@meshrix/protocols/http/client-connection-list";
import { modelLibraryAgentReadiness } from "@meshrix/agents/agent-gateway/policy-validation";

function stringValue(value?: any) : any {
  return String(value || "").trim();
}

function agentSelectorUid(entry: Record<string, any> = {}) : any {
  return stringValue(entry.uid || entry.instanceId || entry.alias);
}

function agentSelectorLabel(entry: Record<string, any> = {}, agentUid: any = "") : any {
  const name: any = stringValue(entry.label || entry.agentName || entry.alias || agentUid);
  const model: any = stringValue(entry.model || entry.engine);
  return model && model !== name ? `${name} · ${model}` : name;
}

function agentSelectorModuleIds(entry: Record<string, any> = {}) : any {
  const access: any = entry?.moduleAccess && typeof entry.moduleAccess === "object"
    ? entry.moduleAccess
    : {};
  if (access.mode !== "selected") {
    return ["*"];
  }
  return Array.isArray(access.moduleIds)
    ? access.moduleIds.map((item?: any) : any => stringValue(item)).filter(Boolean)
    : [];
}

function buildAgentSelector(settings: Record<string, any> = {}) : any {
  const options: any[] = [];
  const seen: any = new Set<any>();
  for (const entry of Array.isArray(settings.modelLibraryAgents) ? settings.modelLibraryAgents : []) {
    const agentUid: any = agentSelectorUid(entry);
    if (!agentUid || seen.has(agentUid)) {
      continue;
    }
    seen.add(agentUid);
    const readiness: any = modelLibraryAgentReadiness(entry, {
      allowRedactedCredential: true
    });
    const state: Record<string, any> = {
      status: readiness.status,
      selectable: readiness.ready,
      reason: readiness.reason
        ? "缺少或不支持模型、地址、超时或凭据配置。"
        : ""
    };
    options.push({
      agentUid,
      value: agentUid,
      label: agentSelectorLabel(entry, agentUid),
      provider: stringValue(entry.provider),
      model: stringValue(entry.model || entry.engine),
      moduleIds: agentSelectorModuleIds(entry),
      capabilities: state.selectable
        ? ["agent.invoke", "gateway.forward"]
        : [],
      status: state.status,
      selectable: state.selectable,
      reason: state.reason
    });
  }
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    source: "agent-configs",
    updatedAt: new Date().toISOString(),
    options
  };
}

function clientRegistryRegistrations(clientRegistryService: any = null, input: Record<string, any> = {}) : any {
  return typeof clientRegistryService?.listClientRegistrations === "function"
    ? clientRegistryService.listClientRegistrations(input)
    : { summary: {}, items: [] };
}

export async function buildAgentSettingsConsoleProjection({
  userDataPath,
  getAgentConfigRegistry,
  settingsPort
}: Record<string, any> = {}) : Promise<any> {
  if (typeof getAgentConfigRegistry !== "function") {
    throw new TypeError("Agent settings projection requires an AgentConfig registry port.");
  }
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.getSettingsPath !== "function"
  ) {
    throw new TypeError("Agent settings projection requires an explicit settings port.");
  }
  const settings: any = await settingsPort.loadSettings(userDataPath, { redactSecrets: true });
  const agentConfigRegistry: any = getAgentConfigRegistry();
  if (!agentConfigRegistry || typeof agentConfigRegistry.refresh !== "function") {
    throw new TypeError("Agent settings projection received an invalid AgentConfig registry port.");
  }
  const agentConfigState: any = await agentConfigRegistry.refresh();
  const projectedSettings: any = settings;
  return {
    settings: {
      path: settingsPort.getSettingsPath(userDataPath),
      value: projectedSettings
    },
    agentSelector: buildAgentSelector(projectedSettings),
    agentConfigs: {
      generation: agentConfigState.generation || "",
      revision: Number(agentConfigState.revision || 0),
      modelManifest: agentConfigState.modelManifest,
      agentManifest: agentConfigState.agentManifest
    }
  };
}

export async function buildRuntimeInfoSettings({ userDataPath, settingsPort }: Record<string, any> = {}) : Promise<any> {
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function"
  ) {
    throw new TypeError("Runtime info settings require an explicit settings port.");
  }
  return settingsPort.loadSettings(userDataPath, { redactSecrets: true });
}

export async function buildConsoleJobsSummary({
  jobWorkflowProvider = null,
  limit = 50
}: Record<string, any> = {}) : Promise<any> {
  if (!jobWorkflowProvider || typeof jobWorkflowProvider.listJobs !== "function") {
    return { summary: {}, items: [] };
  }
  return jobWorkflowProvider.listJobs({ limit });
}

export async function buildConsoleClientConnections({
  clientRegistryService = null,
  offlineAfterSeconds = 0
}: Record<string, any> = {}) : Promise<any> {
  const clientRegistrations: any = await Promise.resolve(clientRegistryRegistrations(clientRegistryService, {
    offlineAfterSeconds
  }));
  return buildClientConnectionList(clientRegistrations, []);
}

export async function buildMaintenanceAgentConsoleSummary({ maintenanceAgent = null }: Record<string, any> = {}) : Promise<any> {
  return maintenanceAgent && typeof maintenanceAgent.getConsoleSummary === "function"
    ? maintenanceAgent.getConsoleSummary()
    : null;
}
