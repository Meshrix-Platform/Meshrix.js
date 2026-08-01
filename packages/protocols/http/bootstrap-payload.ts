export function buildBootstrapPayload(discoveryState: Record<string, any> = {}) : any {
  return {
    ok: true,
    serverId: discoveryState.serverId,
    serverLabel: discoveryState.serverLabel,
    bootstrapBaseUrl: discoveryState.bootstrapBaseUrl,
    advertisedBaseUrl: discoveryState.advertisedBaseUrl,
    activeServiceUrl: discoveryState.activeServiceUrl,
    forwardBaseUrl: discoveryState.forwardBaseUrl,
    mode: discoveryState.mode,
    configVersion: discoveryState.configVersion,
    refreshIntervalSeconds: discoveryState.refreshIntervalSeconds,
    checkInIntervalSeconds: discoveryState.checkInIntervalSeconds,
    offlineAfterSeconds: discoveryState.offlineAfterSeconds,
    alignmentRequired:
      Boolean(discoveryState.activeServiceUrl) &&
      discoveryState.activeServiceUrl !== discoveryState.advertisedBaseUrl
  };
}
