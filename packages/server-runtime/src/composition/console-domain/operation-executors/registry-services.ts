
export function contributionRegistryFor(input: Record<string, any> = {}, context: Record<string, any> = {}) : any {
  if (typeof context.getContributionRegistry !== "function") {
    throw new Error("Contribution registry provider is not configured.");
  }
  return context.getContributionRegistry(input, context);
}

export function upstreamGatewayRegistryFor(context: Record<string, any> = {}) : any {
  if (!context.upstreamGatewayRegistry) {
    throw new Error("Upstream gateway registry provider is not configured.");
  }
  return context.upstreamGatewayRegistry;
}

export function operationProofSubstrateFor(context: Record<string, any> = {}) : any {
  if (!context.operationProofSubstrate?.beginLifecycle) {
    throw new Error("Operation Proof Substrate provider is not configured.");
  }
  return context.operationProofSubstrate;
}

export function workspaceAssetRegistryFor(context: Record<string, any> = {}) : any {
  if (!context.workspaceAssetRegistry) {
    throw new Error("Workspace asset registry provider is not configured.");
  }
  return context.workspaceAssetRegistry;
}

export function workspaceGovernanceRegistryFor(context: Record<string, any> = {}) : any {
  if (!context.workspaceGovernanceRegistry) {
    throw new Error("Workspace governance registry provider is not configured.");
  }
  return context.workspaceGovernanceRegistry;
}

export function readinessBaselineProviderFor(context: Record<string, any> = {}) : any {
  if (typeof context.readinessBaselineProvider?.status !== "function") {
    throw new Error("Readiness baseline provider is not configured.");
  }
  return context.readinessBaselineProvider;
}

export function executiveReportProviderFor(context: Record<string, any> = {}) : any {
  const provider: any = context.executiveReportProvider;
  if (
    typeof provider?.preview !== "function" ||
    typeof provider?.list !== "function" ||
    typeof provider?.generate !== "function"
  ) {
    throw new Error("Executive report provider is not configured.");
  }
  return provider;
}

export function sampleCapabilityPackStoreFor(context: Record<string, any> = {}) : any {
  const store: any = context.sampleCapabilityPackStore;
  if (
    typeof store?.list !== "function" ||
    typeof store?.get !== "function" ||
    typeof store?.materialize !== "function"
  ) {
    throw new Error("Sample capability pack provider is not configured.");
  }
  return store;
}

export function securityAlertStoreFor(context: Record<string, any> = {}) : any {
  const store: any = context.securityAlertStore;
  if (
    typeof store?.listAlerts !== "function" ||
    typeof store?.acknowledgeAlert !== "function" ||
    typeof store?.exportRedacted !== "function" ||
    typeof store?.pruneAlerts !== "function"
  ) {
    throw new Error("Security alert store provider is not configured.");
  }
  return store;
}
