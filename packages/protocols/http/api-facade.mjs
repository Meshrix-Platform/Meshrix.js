import { buildBootstrapPayload } from "./bootstrap-payload.mjs";
import { createReadinessBaselineProvider } from "@lico/foundation/observability/readiness-baseline/baseline-provider";
export { buildClientConnectionList } from "./client-connection-list.mjs";

function emptyAgentSettingsProjection() {
  return {
    settings: {
      path: "",
      value: {}
    },
    agentSelector: {
      schemaVersion: "v0.0.1:schema:definition-1",
      source: "agent-configs",
      updatedAt: new Date().toISOString(),
      options: []
    },
    agentConfigs: {
      generation: "",
      revision: 0,
      modelManifest: {},
      agentManifest: {}
    }
  };
}

function normalizeConsoleDomainServices(services = {}) {
  const source = services && typeof services === "object" ? services : {};
  return {
    buildOperationPermissionClientConnectionRows:
      typeof source.buildOperationPermissionClientConnectionRows === "function"
        ? source.buildOperationPermissionClientConnectionRows
        : () => [],
    buildAgentSettingsConsoleProjection:
      typeof source.buildAgentSettingsConsoleProjection === "function"
        ? source.buildAgentSettingsConsoleProjection
        : async () => emptyAgentSettingsProjection(),
    buildConsoleJobsSummary:
      typeof source.buildConsoleJobsSummary === "function"
        ? source.buildConsoleJobsSummary
        : async () => ({ summary: {}, items: [] }),
    buildConsoleClientConnections:
      typeof source.buildConsoleClientConnections === "function"
        ? source.buildConsoleClientConnections
        : async () => ({ summary: {}, items: [] }),
    buildMaintenanceAgentConsoleSummary:
      typeof source.buildMaintenanceAgentConsoleSummary === "function"
        ? source.buildMaintenanceAgentConsoleSummary
        : async () => null,
    buildRuntimeConsoleSummary:
      typeof source.buildRuntimeConsoleSummary === "function"
        ? source.buildRuntimeConsoleSummary
        : async () => null,
    buildRuntimeInfoSettings:
      typeof source.buildRuntimeInfoSettings === "function"
        ? source.buildRuntimeInfoSettings
        : async () => ({})
  };
}

function storageSummaryFrom(storageProvider = null) {
  return typeof storageProvider?.getStorageSummary === "function"
    ? storageProvider.getStorageSummary()
    : null;
}

const CONSOLE_STORAGE_FIELDS = Object.freeze([
  "databaseExists",
  "objectCount",
  "ownedObjectCount",
  "deletionOperationCount",
  "objectFileCount",
  "objectBytes"
]);
const CONSOLE_DISCOVERY_FIELDS = Object.freeze([
  "serverId",
  "serverLabel",
  "bootstrapBaseUrl",
  "advertisedBaseUrl",
  "activeServiceUrl",
  "forwardBaseUrl",
  "mode",
  "configVersion",
  "refreshIntervalSeconds",
  "checkInIntervalSeconds",
  "offlineAfterSeconds"
]);

function projectOwnedFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const projected = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      projected[field] = value[field];
    }
  }
  return projected;
}

export function buildConsoleStorageSummary(storageProvider = null) {
  return projectOwnedFields(storageSummaryFrom(storageProvider), CONSOLE_STORAGE_FIELDS);
}

export function buildConsoleDiscoveryConfig(discoveryState = null) {
  return projectOwnedFields(discoveryState, CONSOLE_DISCOVERY_FIELDS) || {};
}

const LOCAL_DIAGNOSTIC_FIELDS = new Set([
  "authPath",
  "codexHome",
  "dataDir",
  "distPath",
  "filePath",
  "files",
  "hostname",
  "modelListPath",
  "agentListPath",
  "path",
  "paths",
  "rootPath",
  "userDataPath"
]);
const PUBLIC_PROTOCOL_PATH_FIELDS = new Set([
  "routePath"
]);

function isLocalDiagnosticField(key = "") {
  if (PUBLIC_PROTOCOL_PATH_FIELDS.has(key)) {
    return false;
  }
  return LOCAL_DIAGNOSTIC_FIELDS.has(key) ||
    /(?:Path|Paths|Root|File|Files)$/u.test(String(key || ""));
}

function stripLocalDiagnosticFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripLocalDiagnosticFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (isLocalDiagnosticField(key)) {
      continue;
    }
    projected[key] = stripLocalDiagnosticFields(child);
  }
  return projected;
}

export async function buildConsoleState({
  userDataPath,
  distPath,
  runtime,
  moduleManagement = null,
  discoveryState,
  jobWorkflowProvider = null,
  storageProvider = null,
  clientRegistryService = null,
  serverUrl,
  securityPermissions = null,
  request = null,
  maintenanceAgent = null,
  features = null,
  toolSkillManagementProvider = null,
  consoleDomainServices = null
}) {
  const domainServices = normalizeConsoleDomainServices(consoleDomainServices);
  const publicDiscoveryState = buildConsoleDiscoveryConfig(discoveryState);
  const [
    agentSettingsProjection,
    jobs,
    clients,
    maintenanceAgentSummary
  ] = await Promise.all([
    domainServices.buildAgentSettingsConsoleProjection({ userDataPath }),
    domainServices.buildConsoleJobsSummary({
      jobWorkflowProvider,
      limit: 50
    }),
    domainServices.buildConsoleClientConnections({
      clientRegistryService,
      offlineAfterSeconds: publicDiscoveryState.offlineAfterSeconds,
      toolSkillManagementProvider,
      buildOperationPermissionClientConnectionRows: domainServices.buildOperationPermissionClientConnectionRows
    }),
    domainServices.buildMaintenanceAgentConsoleSummary({ maintenanceAgent })
  ]);
  const projectedSettings = agentSettingsProjection.settings.value;
  const runtimeSummary = await domainServices.buildRuntimeConsoleSummary({
    userDataPath,
    runtime,
    moduleManagement,
    settings: projectedSettings,
    features,
    listAvailableAnalysisModules: domainServices.listAvailableAnalysisModules
  });

  return stripLocalDiagnosticFields({
    server: {
      url: serverUrl,
      localDiagnostics: false
    },
    runtime: runtimeSummary,
    settings: agentSettingsProjection.settings,
    agentSelector: agentSettingsProjection.agentSelector,
    agentConfigs: agentSettingsProjection.agentConfigs,
    discovery: {
      value: publicDiscoveryState,
      bootstrap: buildBootstrapPayload(publicDiscoveryState)
    },
    auth: securityPermissions?.getConsoleSummary
      ? securityPermissions.getConsoleSummary(request)
      : null,
    maintenanceAgent: maintenanceAgentSummary,
    storage: buildConsoleStorageSummary(storageProvider),
    readinessBaseline: await createReadinessBaselineProvider({ userDataPath }).status(),
    jobs,
    clients,
    features
  });
}

export async function buildRuntimeInfo({
  userDataPath,
  distPath,
  runtime,
  moduleManagement = null,
  discoveryState,
  storageProvider = null,
  serverUrl,
  securityPermissions = null,
  request = null,
  features = null,
  consoleDomainServices = null
}) {
  const domainServices = normalizeConsoleDomainServices(consoleDomainServices);
  const publicDiscoveryState = buildConsoleDiscoveryConfig(discoveryState);
  const settings = await domainServices.buildRuntimeInfoSettings({ userDataPath });
  const runtimeSummary = await domainServices.buildRuntimeConsoleSummary({
    userDataPath,
    runtime,
    moduleManagement,
    settings,
    features,
    listAvailableAnalysisModules: domainServices.listAvailableAnalysisModules
  });
  return stripLocalDiagnosticFields({
    server: {
      url: serverUrl,
      localDiagnostics: false
    },
    runtime: runtimeSummary,
    auth: securityPermissions?.getConsoleSummary
      ? securityPermissions.getConsoleSummary(request)
      : null,
    storage: buildConsoleStorageSummary(storageProvider),
    readinessBaseline: await createReadinessBaselineProvider({ userDataPath }).status(),
    discovery: buildBootstrapPayload(publicDiscoveryState),
    features
  });
}
