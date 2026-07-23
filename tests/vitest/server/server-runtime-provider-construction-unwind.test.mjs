import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  createAgentMemory: vi.fn(),
  createAgentRuntimeProvider: vi.fn(),
  createAgentWorkspace: vi.fn(),
  createContributionRegistry: vi.fn(),
  createContextRuntime: vi.fn(),
  createExecutiveReportStore: vi.fn(),
  createMaintenanceAgentService: vi.fn(),
  createMaintenanceWorkQueueProvider: vi.fn(),
  createOperationPermissionPlatform: vi.fn(),
  createOperationPermissionStore: vi.fn(),
  createReadinessBaselineProvider: vi.fn(),
  createSampleCapabilityPackStore: vi.fn(),
  createSecurityAlertStore: vi.fn(),
  createStrategyManagementProvider: vi.fn(),
  createToolSkillManagementProvider: vi.fn(),
  createUpstreamGatewayRegistry: vi.fn(),
  createUpstreamManifestObserver: vi.fn(),
  createUpstreamManifestSnapshotCommitter: vi.fn(),
  createUpstreamPublishingApplication: vi.fn(),
  createWorkspaceAssetRegistry: vi.fn(),
  createWorkspaceGovernanceRegistry: vi.fn()
}));

vi.mock("#lico/settings", () => ({ loadSettings: vi.fn() }));
vi.mock("#lico/agents/agent-configs/config-registry", () => ({ getAgentConfigRegistry: vi.fn() }));
vi.mock("#lico/agents/agent-runtime-provider", () => ({
  createAgentRuntimeProvider: factories.createAgentRuntimeProvider
}));
vi.mock("#lico/agents/upstream-gateway/index", () => ({
  createUpstreamGatewayRegistry: factories.createUpstreamGatewayRegistry,
  createUpstreamManifestObserver: factories.createUpstreamManifestObserver,
  createUpstreamManifestSnapshotCommitter: factories.createUpstreamManifestSnapshotCommitter,
  createUpstreamPublishingApplication: factories.createUpstreamPublishingApplication
}));
vi.mock("#lico/agents/workspace-governance/index", () => ({
  createWorkspaceGovernanceRegistry: factories.createWorkspaceGovernanceRegistry
}));
vi.mock("#lico/agents/workspace-contribution", () => ({
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION: Object.freeze({ machineId: "fixture" }),
  createContributionRegistry: factories.createContributionRegistry
}));
vi.mock("#lico/agents/workspace-asset-registry/index", () => ({
  createWorkspaceAssetRegistry: factories.createWorkspaceAssetRegistry
}));
vi.mock("#lico/capabilities/skills/tool-skill-management-provider", () => ({
  createToolSkillManagementProvider: factories.createToolSkillManagementProvider
}));
vi.mock("#lico/capabilities/operation-permission-core/index", () => ({
  createOperationPermissionPlatform: factories.createOperationPermissionPlatform
}));
vi.mock("#lico/capabilities/operation-permission-core/store", () => ({
  createOperationPermissionStore: factories.createOperationPermissionStore
}));
vi.mock("#lico/foundation/observability/executive-report", () => ({
  buildExecutiveReport: vi.fn(),
  createExecutiveReportStore: factories.createExecutiveReportStore
}));
vi.mock("#lico/foundation/observability/readiness-baseline/baseline-provider", () => ({
  createReadinessBaselineProvider: factories.createReadinessBaselineProvider
}));
vi.mock("#lico/foundation/observability/sample-capability-pack", () => ({
  createSampleCapabilityPackStore: factories.createSampleCapabilityPackStore
}));
vi.mock("#lico/foundation/security/security-alerts", () => ({
  createSecurityAlertStore: factories.createSecurityAlertStore
}));
vi.mock("#lico/agents/agent-memory/index", () => ({
  createAgentMemory: factories.createAgentMemory
}));
vi.mock("#lico/server-runtime/state/interface/index", () => ({
  createContextRuntime: factories.createContextRuntime
}));
vi.mock("#lico/agents/maintenance/index", () => ({
  createMaintenanceAgentService: factories.createMaintenanceAgentService
}));
vi.mock("#lico/server-runtime/composition/maintenance-work-queue-provider", () => ({
  createMaintenanceWorkQueueProvider: factories.createMaintenanceWorkQueueProvider
}));
vi.mock("#lico/agents/agent-workspace/index", () => ({
  createAgentWorkspace: factories.createAgentWorkspace
}));
vi.mock("#lico/server-runtime/composition/strategy-management-provider", () => ({
  createStrategyManagementProvider: factories.createStrategyManagementProvider
}));

import {
  createServerConsoleOperationProviders,
  createServerRuntimeProviders
} from "../../../packages/server-runtime/src/composition/server-runtime-providers.mjs";

function closeable(name, closeOrder, { closeFailure = null } = {}) {
  let closed = false;
  return {
    isClosed: vi.fn(() => closed),
    close: vi.fn(async () => {
      await Promise.resolve();
      closeOrder.push(name);
      if (closeFailure) throw closeFailure;
      closed = true;
    })
  };
}

function runtimeInput(activeFeatures = []) {
  const active = new Set(activeFeatures);
  return {
    userDataPath: "<user-data>",
    runtime: {},
    jobManager: {},
    protocolEventBus: {},
    getDiscoveryState: () => ({}),
    getListenUrl: () => "",
    getControllers: () => null,
    operationAuditStore: {},
    operationLockManager: { acquire: vi.fn() },
    operationConcurrencyScope: "fixture",
    runtimeLogger: {},
    securityPermissions: {},
    activeFeatureIds: [...active],
    isFeatureActive: (featureId) => active.has(featureId),
    isAnyFeatureActive: (...featureIds) => featureIds.some((featureId) => active.has(featureId))
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  factories.createAgentMemory.mockReturnValue({});
  factories.createAgentRuntimeProvider.mockReturnValue({});
  factories.createAgentWorkspace.mockReturnValue({});
  factories.createContributionRegistry.mockReturnValue({});
  factories.createContextRuntime.mockReturnValue({});
  factories.createExecutiveReportStore.mockReturnValue({ list: vi.fn(), generate: vi.fn() });
  factories.createMaintenanceAgentService.mockReturnValue({ close: vi.fn() });
  factories.createMaintenanceWorkQueueProvider.mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    close: vi.fn()
  });
  factories.createOperationPermissionPlatform.mockReturnValue({});
  factories.createOperationPermissionStore.mockReturnValue({ close: vi.fn(), isClosed: vi.fn(() => false) });
  factories.createReadinessBaselineProvider.mockReturnValue({});
  factories.createSampleCapabilityPackStore.mockReturnValue({});
  factories.createSecurityAlertStore.mockReturnValue({ close: vi.fn() });
  factories.createStrategyManagementProvider.mockReturnValue({});
  factories.createToolSkillManagementProvider.mockReturnValue({});
  factories.createUpstreamGatewayRegistry.mockReturnValue({});
  factories.createUpstreamManifestObserver.mockReturnValue({ start: vi.fn(async () => {}), close: vi.fn() });
  factories.createUpstreamManifestSnapshotCommitter.mockReturnValue({});
  factories.createUpstreamPublishingApplication.mockReturnValue({ execute: vi.fn() });
  factories.createWorkspaceAssetRegistry.mockReturnValue({});
  factories.createWorkspaceGovernanceRegistry.mockReturnValue({});
});

describe("server runtime provider construction unwind", () => {
  const storageProvider = Object.freeze({
    getDurableManifestWriterPort: () => Object.freeze({ commitManifestSet: vi.fn() }),
    getDurableManifestReaderPort: () => Object.freeze({ getSnapshot: vi.fn() }),
    getDurableManifestCandidateAuthorityPort: () => Object.freeze({
      getCandidateSnapshot: vi.fn(),
      acknowledgePublished: vi.fn()
    })
  });

  it("awaits every earlier console-provider closer in reverse order and preserves the construction error", async () => {
    const closeOrder = [];
    const constructionFailure = new Error("security alert construction failed");
    const upstream = closeable("upstream", closeOrder);
    const workspaceAsset = closeable("workspace-asset", closeOrder, {
      closeFailure: new Error("workspace asset close failed")
    });
    factories.createUpstreamGatewayRegistry.mockReturnValue(upstream);
    factories.createWorkspaceAssetRegistry.mockReturnValue(workspaceAsset);
    factories.createSecurityAlertStore.mockImplementation(() => {
      throw constructionFailure;
    });

    const failure = await createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider
    }).catch((error) => error);

    expect(failure).toBe(constructionFailure);
    expect(closeOrder).toEqual(["workspace-asset", "upstream"]);
    expect(workspaceAsset.close).toHaveBeenCalledOnce();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("shares one successful console-provider close barrier and closes owned resources once", async () => {
    const closeOrder = [];
    const upstream = closeable("upstream", closeOrder);
    const workspaceAsset = closeable("workspace-asset", closeOrder);
    const securityAlert = closeable("security-alert", closeOrder);
    factories.createUpstreamGatewayRegistry.mockReturnValue(upstream);
    factories.createWorkspaceAssetRegistry.mockReturnValue(workspaceAsset);
    factories.createSecurityAlertStore.mockReturnValue(securityAlert);
    const providers = await createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider
    });

    const firstClose = providers.close();
    const secondClose = providers.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    await providers.close();
    expect(closeOrder).toEqual(["security-alert", "workspace-asset", "upstream"]);
    expect(securityAlert.close).toHaveBeenCalledOnce();
    expect(workspaceAsset.close).toHaveBeenCalledOnce();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("retries one transient published-manifest bootstrap rejection", async () => {
    const observer = {
      start: vi.fn(async () => ({ outcome: "rejected", setRevision: -1 })),
      scan: vi.fn(async () => ({ outcome: "accepted", setRevision: 0 })),
      close: vi.fn(async () => {})
    };
    factories.createUpstreamManifestObserver.mockReturnValue(observer);

    const providers = await createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider
    });

    expect(observer.start).toHaveBeenCalledOnce();
    expect(observer.scan).toHaveBeenCalledOnce();
    await providers.close();
    expect(observer.close).toHaveBeenCalledOnce();
  });

  it("fails closed and releases the observer after bounded manifest bootstrap rejection", async () => {
    const observer = {
      start: vi.fn(async () => ({ outcome: "rejected", setRevision: -1 })),
      scan: vi.fn(async () => ({ outcome: "rejected", setRevision: -1 })),
      close: vi.fn(async () => {})
    };
    factories.createUpstreamManifestObserver.mockReturnValue(observer);

    await expect(createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider
    })).rejects.toMatchObject({ code: "upstream_manifest_bootstrap_unavailable" });

    expect(observer.start).toHaveBeenCalledOnce();
    expect(observer.scan).toHaveBeenCalledTimes(2);
    expect(observer.close).toHaveBeenCalledOnce();
  });

  it("closes the dedicated maintenance store when the maintenance service factory fails", async () => {
    const closeOrder = [];
    const constructionFailure = new Error("maintenance service construction failed");
    const agentMemory = closeable("agent-memory", closeOrder);
    const contextRuntime = closeable("context-runtime", closeOrder);
    const operationPermissionStore = closeable("operation-permission", closeOrder);
    const maintenanceWorkQueue = closeable("maintenance-work-queue", closeOrder);
    maintenanceWorkQueue.start = vi.fn();
    maintenanceWorkQueue.stop = vi.fn(async () => {
      closeOrder.push("maintenance-work-queue-stop");
    });
    factories.createAgentMemory.mockReturnValue(agentMemory);
    factories.createContextRuntime.mockReturnValue(contextRuntime);
    factories.createOperationPermissionStore.mockReturnValue(operationPermissionStore);
    factories.createMaintenanceWorkQueueProvider.mockReturnValue(maintenanceWorkQueue);
    factories.createMaintenanceAgentService.mockImplementation(() => {
      throw constructionFailure;
    });

    const failure = await createServerRuntimeProviders(runtimeInput([
      "maintenance-agent-runbooks"
    ])).catch((error) => error);

    expect(failure).toBe(constructionFailure);
    expect(closeOrder).toEqual([
      "maintenance-work-queue",
      "operation-permission",
      "context-runtime",
      "agent-memory"
    ]);
    expect(operationPermissionStore.close).toHaveBeenCalledOnce();
  });

  it("unwinds workspace and maintenance owners before their dependencies after a later provider failure", async () => {
    const closeOrder = [];
    const constructionFailure = new Error("strategy construction failed");
    const agentMemory = closeable("agent-memory", closeOrder);
    const contextRuntime = closeable("context-runtime", closeOrder);
    const operationPermissionStore = closeable("operation-permission", closeOrder);
    const maintenanceWorkQueue = closeable("maintenance-work-queue", closeOrder);
    maintenanceWorkQueue.start = vi.fn();
    maintenanceWorkQueue.stop = vi.fn(async () => {
      closeOrder.push("maintenance-work-queue-stop");
    });
    const maintenanceAgent = closeable("maintenance", closeOrder, {
      closeFailure: new Error("maintenance close failed")
    });
    maintenanceAgent.start = vi.fn(async () => {});
    const agentWorkspace = closeable("agent-workspace", closeOrder, {
      closeFailure: new Error("workspace close failed")
    });
    factories.createAgentMemory.mockReturnValue(agentMemory);
    factories.createContextRuntime.mockReturnValue(contextRuntime);
    factories.createOperationPermissionStore.mockReturnValue(operationPermissionStore);
    factories.createMaintenanceWorkQueueProvider.mockReturnValue(maintenanceWorkQueue);
    operationPermissionStore.isClosed.mockImplementation(() => {
      throw new Error("operation permission state check failed");
    });
    factories.createMaintenanceAgentService.mockReturnValue(maintenanceAgent);
    factories.createAgentWorkspace.mockReturnValue(agentWorkspace);
    factories.createStrategyManagementProvider.mockImplementation(() => {
      throw constructionFailure;
    });

    const failure = await createServerRuntimeProviders(runtimeInput([
      "maintenance-agent-runbooks",
      "agent-workspace-core",
      "strategy-management"
    ])).catch((error) => error);

    expect(failure).toBe(constructionFailure);
    expect(closeOrder).toEqual([
      "agent-workspace",
      "maintenance-work-queue-stop",
      "maintenance",
      "maintenance-work-queue",
      "operation-permission",
      "context-runtime",
      "agent-memory"
    ]);
    expect(agentWorkspace.close).toHaveBeenCalledOnce();
    expect(maintenanceAgent.close).toHaveBeenCalledOnce();
    expect(operationPermissionStore.close).toHaveBeenCalledOnce();
  });
});
