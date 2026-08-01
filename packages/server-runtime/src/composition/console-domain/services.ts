import { executeConsoleDomainOperation } from "./operation-executor.ts";
import {
  buildAgentSettingsConsoleProjection as buildAgentSettingsConsoleProjectionBase,
  buildConsoleClientConnections,
  buildConsoleJobsSummary,
  buildMaintenanceAgentConsoleSummary,
  buildRuntimeInfoSettings
} from "./state-projections.ts";
import { buildRuntimeConsoleSummary } from "./runtime-summary.ts";
import { buildOperationPermissionClientConnectionRows } from "./operation-permission-client-connections.ts";
import * as appearancePresetCatalog from "./appearance-presets/appearance-preset-store.ts";

const CONSOLE_OPERATION_PROVIDER_METHODS: readonly any[] = Object.freeze([
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

function assertConsoleOperationProviders(providers?: any) : any {
  for (const [name, method] of CONSOLE_OPERATION_PROVIDER_METHODS) {
    const provider: any = providers?.[name];
    const available: any = method === null ? typeof provider === "function" : typeof provider?.[method] === "function";
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
}: Record<string, any> = {}) : any {
  const runtimeDataPath: any = String(userDataPath || "").trim();
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
    buildAgentSettingsConsoleProjection: (input: Record<string, any> = {}) : any =>
      buildAgentSettingsConsoleProjectionBase({
        ...input,
        getAgentConfigRegistry,
        settingsPort
      }),
    buildConsoleClientConnections,
    buildConsoleJobsSummary,
    buildMaintenanceAgentConsoleSummary,
    buildRuntimeInfoSettings: (input: Record<string, any> = {}) : any =>
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
