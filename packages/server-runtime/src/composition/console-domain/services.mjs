import { executeConsoleDomainOperation } from "./operation-executor.mjs";
import {
  buildAgentSettingsConsoleProjection as buildAgentSettingsConsoleProjectionBase,
  buildConsoleClientConnections,
  buildConsoleJobsSummary,
  buildMaintenanceAgentConsoleSummary,
  buildRuntimeInfoSettings
} from "./state-projections.mjs";
import { buildRuntimeConsoleSummary } from "./runtime-summary.mjs";
import { buildOperationPermissionClientConnectionRows } from "./operation-permission-client-connections.mjs";
import * as appearancePresetCatalog from "./appearance-presets/appearance-preset-store.mjs";

const CONSOLE_OPERATION_PROVIDER_METHODS = Object.freeze([
  ["getContributionRegistry", null],
  ["upstreamGatewayRegistry", "listServices"],
  ["upstreamPublishingApplication", "execute"],
  ["operationProofSubstrate", "beginLifecycle"],
  ["workspaceAssetRegistry", "recordAssetMutation"],
  ["workspaceGovernanceRegistry", "evaluate"],
  ["readinessBaselineProvider", "status"],
  ["executiveReportProvider", "preview"],
  ["sampleCapabilityPackStore", "list"],
  ["securityAlertStore", "listAlerts"]
]);

function assertConsoleOperationProviders(providers) {
  for (const [name, method] of CONSOLE_OPERATION_PROVIDER_METHODS) {
    const provider = providers?.[name];
    const available = method === null ? typeof provider === "function" : typeof provider?.[method] === "function";
    if (!available) {
      throw new TypeError(`Console domain services require an explicit ${name} port.`);
    }
  }
}

export function createConsoleDomainServices({
  userDataPath,
  getAgentConfigRegistry,
  agentRuntimeProvider,
  uploadSessionStore,
  consoleOperationProviders = {},
  settingsPort,
  loadAgentGatewayModule,
  loadModelProbeModule
} = {}) {
  const runtimeDataPath = String(userDataPath || "").trim();
  if (!runtimeDataPath) {
    throw new TypeError("Console domain services require an explicit userDataPath.");
  }
  if (typeof getAgentConfigRegistry !== "function") {
    throw new TypeError("Console domain services require an AgentConfig registry port.");
  }
  if (!agentRuntimeProvider || typeof agentRuntimeProvider.callAgentGateway !== "function") {
    throw new TypeError("Console domain services require an AgentRuntime provider port.");
  }
  if (!uploadSessionStore || typeof uploadSessionStore.resolveUploadSessionFiles !== "function") {
    throw new TypeError("Console domain services require an upload session store port.");
  }
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.saveSettings !== "function" ||
    typeof settingsPort.normalizeSettings !== "function" ||
    typeof settingsPort.getSettingsPath !== "function"
  ) {
    throw new TypeError("Console domain services require an explicit settings port.");
  }
  assertConsoleOperationProviders(consoleOperationProviders);

  return Object.freeze({
    getAgentConfigRegistry,
    agentRuntimeProvider,
    settingsPort,
    buildAgentSettingsConsoleProjection: (input = {}) =>
      buildAgentSettingsConsoleProjectionBase({
        ...input,
        getAgentConfigRegistry,
        settingsPort
      }),
    buildConsoleClientConnections,
    buildConsoleJobsSummary,
    buildMaintenanceAgentConsoleSummary,
    buildRuntimeInfoSettings: (input = {}) =>
      buildRuntimeInfoSettings({
        ...input,
        settingsPort
      }),
    buildRuntimeConsoleSummary,
    executeConsoleDomainOperation,
    buildOperationPermissionClientConnectionRows,
    uploadSessionStore,
    appearancePresetCatalog,
    consoleOperationProviders: Object.freeze({ ...consoleOperationProviders }),
    loadAgentGatewayModule,
    loadModelProbeModule
  });
}
