import { buildClientConnectionList } from "@lico/protocols/http/client-connection-list";
import { modelLibraryAgentReadiness } from "@lico/agents/agent-gateway/policy-validation";

function stringValue(value) {
  return String(value || "").trim();
}

function agentSelectorUid(entry = {}) {
  return stringValue(entry.uid || entry.instanceId || entry.alias);
}

function agentSelectorLabel(entry = {}, agentUid = "") {
  const name = stringValue(entry.label || entry.agentName || entry.alias || agentUid);
  const model = stringValue(entry.model || entry.engine);
  return model && model !== name ? `${name} · ${model}` : name;
}

function agentSelectorModuleIds(entry = {}) {
  const access = entry?.moduleAccess && typeof entry.moduleAccess === "object"
    ? entry.moduleAccess
    : {};
  if (access.mode !== "selected") {
    return ["*"];
  }
  return Array.isArray(access.moduleIds)
    ? access.moduleIds.map((item) => stringValue(item)).filter(Boolean)
    : [];
}

function buildAgentSelector(settings = {}) {
  const options = [];
  const seen = new Set();
  for (const entry of Array.isArray(settings.modelLibraryAgents) ? settings.modelLibraryAgents : []) {
    const agentUid = agentSelectorUid(entry);
    if (!agentUid || seen.has(agentUid)) {
      continue;
    }
    seen.add(agentUid);
    const readiness = modelLibraryAgentReadiness(entry, {
      allowRedactedCredential: true
    });
    const state = {
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

function clientRegistryRegistrations(clientRegistryService = null, input = {}) {
  return typeof clientRegistryService?.listClientRegistrations === "function"
    ? clientRegistryService.listClientRegistrations(input)
    : { summary: {}, items: [] };
}

export async function buildAgentSettingsConsoleProjection({
  userDataPath,
  getAgentConfigRegistry,
  settingsPort
} = {}) {
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
  const settings = await settingsPort.loadSettings(userDataPath, { redactSecrets: true });
  const agentConfigRegistry = getAgentConfigRegistry();
  if (!agentConfigRegistry || typeof agentConfigRegistry.refresh !== "function") {
    throw new TypeError("Agent settings projection received an invalid AgentConfig registry port.");
  }
  const agentConfigState = await agentConfigRegistry.refresh();
  const projectedSettings = settings;
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

export async function buildRuntimeInfoSettings({ userDataPath, settingsPort } = {}) {
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
} = {}) {
  if (!jobWorkflowProvider || typeof jobWorkflowProvider.listJobs !== "function") {
    return { summary: {}, items: [] };
  }
  return jobWorkflowProvider.listJobs({ limit });
}

export async function buildConsoleClientConnections({
  clientRegistryService = null,
  offlineAfterSeconds = 0,
  toolSkillManagementProvider = null,
  buildOperationPermissionClientConnectionRows = null
} = {}) {
  const clientRegistrations = await Promise.resolve(clientRegistryRegistrations(clientRegistryService, {
    offlineAfterSeconds
  }));
  const additionalConnectionRows =
    typeof buildOperationPermissionClientConnectionRows === "function"
      ? await buildOperationPermissionClientConnectionRows(toolSkillManagementProvider, { offlineAfterSeconds })
      : [];
  return buildClientConnectionList(clientRegistrations, additionalConnectionRows);
}

export async function buildMaintenanceAgentConsoleSummary({ maintenanceAgent = null } = {}) {
  return maintenanceAgent && typeof maintenanceAgent.getConsoleSummary === "function"
    ? maintenanceAgent.getConsoleSummary()
    : null;
}
