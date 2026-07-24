import { describe, expect, it } from "vitest";

import { createConsoleDomainServices } from "../../../packages/server-runtime/src/composition/console-domain/services.mjs";

function basePorts() {
  return {
    userDataPath: "<user-data>",
    getAgentConfigRegistry: () => ({}),
    agentRuntimeProvider: { callAgentGateway() {} },
    uploadSessionStore: { resolveUploadSessionFiles() {} },
    settingsPort: {
      loadSettings() {},
      saveSettings() {},
      normalizeSettings() {},
      getSettingsPath() {}
    }
  };
}

function operationProviders() {
  return {
    getContributionRegistry() {},
    upstreamGatewayRegistry: { listServices() {} },
    upstreamPublishingApplication: { execute() {} },
    operationProofSubstrate: { beginLifecycle() {} },
    workspaceAssetRegistry: { recordAssetMutation() {} },
    workspaceGovernanceRegistry: { evaluate() {} },
    readinessBaselineProvider: { status() {} },
    executiveReportProvider: { preview() {} },
    sampleCapabilityPackStore: { list() {} },
    securityAlertStore: { listAlerts() {} }
  };
}

describe("console domain service ports", () => {
  it("fails closed when a stateful operation provider is not composed", () => {
    expect(() => createConsoleDomainServices(basePorts()))
      .toThrow("explicit getContributionRegistry port");
  });

  it("exposes only explicitly supplied operation providers", () => {
    const providers = operationProviders();
    const services = createConsoleDomainServices({
      ...basePorts(),
      consoleOperationProviders: providers
    });

    expect(services.consoleOperationProviders).toMatchObject(providers);
    expect(Object.isFrozen(services.consoleOperationProviders)).toBe(true);
  });
});
