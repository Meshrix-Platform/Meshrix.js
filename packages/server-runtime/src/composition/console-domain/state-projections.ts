import { buildClientConnectionList } from "@meshrix/protocols/http/client-connection-list";

function clientRegistryRegistrations(clientRegistryService: any = null, input: Record<string, any> = {}) : any {
  return typeof clientRegistryService?.listClientRegistrations === "function"
    ? clientRegistryService.listClientRegistrations(input)
    : { summary: {}, items: [] };
}

export async function buildSettingsConsoleProjection({
  userDataPath,
  settingsPort
}: Record<string, any> = {}) : Promise<any> {
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.getSettingsPath !== "function"
  ) {
    throw new TypeError("Agent settings projection requires an explicit settings port.");
  }
  const settings: any = await settingsPort.loadSettings(userDataPath, { redactSecrets: true });
  return {
    settings: {
      path: settingsPort.getSettingsPath(userDataPath),
      value: settings
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
