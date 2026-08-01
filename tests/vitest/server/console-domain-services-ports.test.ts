import { describe, expect, it } from "vitest";

import { createConsoleDomainServices } from "../../../packages/server-runtime/src/composition/console-domain/services.ts";

function basePorts() : any {
  return {
    userDataPath: "<user-data>",
    getAgentConfigRegistry: () : any => ({}),
    agentRuntimeProvider: { callAgentGateway() : any {} },
    uploadSessionStore: { resolveUploadSessionFiles() : any {} },
    settingsPort: {
      loadSettings() : any {},
      saveSettings() : any {},
      normalizeSettings() : any {},
      getSettingsPath() : any {}
    }
  };
}

function operationProviders() : any {
  return {
    getContributionRegistry() : any {},
    upstreamGatewayRegistry: { listServices() : any {} },
    upstreamPublishingApplication: { execute() : any {} },
    operationProofSubstrate: { beginLifecycle() : any {} },
    workspaceAssetRegistry: { recordAssetMutation() : any {} },
    workspaceGovernanceRegistry: { evaluate() : any {} },
    readinessBaselineProvider: { status() : any {} },
    executiveReportProvider: { preview() : any {} },
    sampleCapabilityPackStore: { list() : any {} },
    securityAlertStore: { listAlerts() : any {} }
  };
}

describe("console domain service ports", () : any => {
  it("fails closed when a stateful operation provider is not composed", () : any => {
    expect(() : any => createConsoleDomainServices(basePorts()))
      .toThrow("explicit getContributionRegistry port");
  });

  it("exposes only explicitly supplied operation providers", () : any => {
    const providers: any = operationProviders();
    const services: any = createConsoleDomainServices({
      ...basePorts(),
      consoleOperationProviders: providers
    });

    expect(services.consoleOperationProviders).toMatchObject(providers);
    expect(Object.isFrozen(services.consoleOperationProviders)).toBe(true);
  });
});
