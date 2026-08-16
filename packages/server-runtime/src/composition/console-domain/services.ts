import { executeConsoleDomainOperation } from "./operation-executor.ts";
import {
  buildSettingsConsoleProjection as buildSettingsConsoleProjectionBase,
  buildConsoleClientConnections,
  buildConsoleJobsSummary,
  buildRuntimeInfoSettings
} from "./state-projections.ts";
import { buildRuntimeConsoleSummary } from "./runtime-summary.ts";
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
  uploadSessionStore,
  consoleOperationProviders = {},
  settingsPort,
}: Record<string, any> = {}) : any {
  const runtimeDataPath: any = String(userDataPath || "").trim();
  if (!runtimeDataPath) {
    throw new TypeError("Console domain services require an explicit userDataPath.");
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
    settingsPort,
    buildSettingsConsoleProjection: (input: Record<string, any> = {}) : any =>
      buildSettingsConsoleProjectionBase({
        ...input,
        settingsPort
      }),
    buildConsoleClientConnections,
    buildConsoleJobsSummary,
    buildRuntimeInfoSettings: (input: Record<string, any> = {}) : any =>
      buildRuntimeInfoSettings({
        ...input,
        settingsPort
      }),
    buildRuntimeConsoleSummary,
    executeConsoleDomainOperation,
    uploadSessionStore,
    appearancePresetCatalog,
    consoleOperationProviders: Object.freeze({ ...consoleOperationProviders })
  });
}
