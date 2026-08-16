import { buildBootstrapPayload } from "./bootstrap-payload.ts";
import { createReadinessBaselineProvider } from "@meshrix/foundation/observability/readiness-baseline/baseline-provider";
export { buildClientConnectionList } from "./client-connection-list.ts";

function emptySettingsProjection() : any {
  return {
    settings: {
      path: "",
      value: {}
    }
  };
}

function normalizeConsoleDomainServices(services: Record<string, any> = {}) : any {
  const source: any = services && typeof services === "object" ? services : {};
  return {
    buildSettingsConsoleProjection:
      typeof source.buildSettingsConsoleProjection === "function"
        ? source.buildSettingsConsoleProjection
        : async () : Promise<any> => emptySettingsProjection(),
    buildConsoleJobsSummary:
      typeof source.buildConsoleJobsSummary === "function"
        ? source.buildConsoleJobsSummary
        : async () : Promise<any> => ({ summary: {}, items: [] }),
    buildConsoleClientConnections:
      typeof source.buildConsoleClientConnections === "function"
        ? source.buildConsoleClientConnections
        : async () : Promise<any> => ({ summary: {}, items: [] }),
    buildRuntimeConsoleSummary:
      typeof source.buildRuntimeConsoleSummary === "function"
        ? source.buildRuntimeConsoleSummary
        : async () : Promise<any> => null,
    buildRuntimeInfoSettings:
      typeof source.buildRuntimeInfoSettings === "function"
        ? source.buildRuntimeInfoSettings
        : async () : Promise<any> => ({})
  };
}

function storageSummaryFrom(storageProvider: any = null) : any {
  return typeof storageProvider?.getStorageSummary === "function"
    ? storageProvider.getStorageSummary()
    : null;
}

const CONSOLE_STORAGE_FIELDS: readonly any[] = Object.freeze([
  "databaseExists",
  "objectCount",
  "ownedObjectCount",
  "deletionOperationCount",
  "objectFileCount",
  "objectBytes"
]);
const CONSOLE_DISCOVERY_FIELDS: readonly any[] = Object.freeze([
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

function projectOwnedFields(value?: any, fields?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const projected: Record<string, any> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      projected[field] = value[field];
    }
  }
  return projected;
}

export function buildConsoleStorageSummary(storageProvider: any = null) : any {
  return projectOwnedFields(storageSummaryFrom(storageProvider), CONSOLE_STORAGE_FIELDS);
}

export function buildConsoleDiscoveryConfig(discoveryState: any = null) : any {
  return projectOwnedFields(discoveryState, CONSOLE_DISCOVERY_FIELDS) || {};
}

const LOCAL_DIAGNOSTIC_FIELDS: any = new Set<any>([
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
const PUBLIC_PROTOCOL_PATH_FIELDS: any = new Set<any>([
  "routePath"
]);

function isLocalDiagnosticField(key: any = "") : any {
  if (PUBLIC_PROTOCOL_PATH_FIELDS.has(key)) {
    return false;
  }
  return LOCAL_DIAGNOSTIC_FIELDS.has(key) ||
    /(?:Path|Paths|Root|File|Files)$/u.test(String(key || ""));
}

function stripLocalDiagnosticFields(value?: any) : any {
  if (Array.isArray(value)) {
    return value.map(stripLocalDiagnosticFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const projected: Record<string, any> = {};
  for (const [key, child] of (Object.entries(value) as [string, any][])) {
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
  features = null,
  consoleDomainServices = null
}: Record<string, any>) : Promise<any> {
  const domainServices: any = normalizeConsoleDomainServices(consoleDomainServices);
  const publicDiscoveryState: any = buildConsoleDiscoveryConfig(discoveryState);
  const [
    settingsProjection,
    jobs,
    clients
  ] = await Promise.all([
    domainServices.buildSettingsConsoleProjection({ userDataPath }),
    domainServices.buildConsoleJobsSummary({
      jobWorkflowProvider,
      limit: 50
    }),
    domainServices.buildConsoleClientConnections({
      clientRegistryService,
      offlineAfterSeconds: publicDiscoveryState.offlineAfterSeconds
    })
  ]);
  const projectedSettings: any = settingsProjection.settings.value;
  const runtimeSummary: any = await domainServices.buildRuntimeConsoleSummary({
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
    settings: settingsProjection.settings,
    discovery: {
      value: publicDiscoveryState,
      bootstrap: buildBootstrapPayload(publicDiscoveryState)
    },
    auth: securityPermissions?.getConsoleSummary
      ? securityPermissions.getConsoleSummary(request)
      : null,
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
}: Record<string, any>) : Promise<any> {
  const domainServices: any = normalizeConsoleDomainServices(consoleDomainServices);
  const publicDiscoveryState: any = buildConsoleDiscoveryConfig(discoveryState);
  const settings: any = await domainServices.buildRuntimeInfoSettings({ userDataPath });
  const runtimeSummary: any = await domainServices.buildRuntimeConsoleSummary({
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
