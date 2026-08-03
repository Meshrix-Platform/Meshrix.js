import { beforeEach, describe, expect, it, vi } from "vitest";

const factories: any = vi.hoisted(() : any => ({
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

vi.mock("#meshrix/settings", () : any => ({ loadSettings: vi.fn() }));
vi.mock("#meshrix/agents/agent-configs/config-registry", () : any => ({ getAgentConfigRegistry: vi.fn() }));
vi.mock("#meshrix/agents/agent-runtime-provider", () : any => ({
  createAgentRuntimeProvider: factories.createAgentRuntimeProvider
}));
vi.mock("#meshrix/agents/upstream-gateway/index", () : any => ({
  createUpstreamGatewayRegistry: factories.createUpstreamGatewayRegistry,
  createUpstreamManifestObserver: factories.createUpstreamManifestObserver,
  createUpstreamManifestSnapshotCommitter: factories.createUpstreamManifestSnapshotCommitter,
  createUpstreamPublishingApplication: factories.createUpstreamPublishingApplication
}));
vi.mock("#meshrix/agents/workspace-governance/index", () : any => ({
  createWorkspaceGovernanceRegistry: factories.createWorkspaceGovernanceRegistry
}));
vi.mock("#meshrix/agents/workspace-contribution", () : any => ({
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION: Object.freeze({ machineId: "fixture" }),
  createContributionRegistry: factories.createContributionRegistry
}));
vi.mock("#meshrix/agents/workspace-asset-registry/index", () : any => ({
  createWorkspaceAssetRegistry: factories.createWorkspaceAssetRegistry
}));
vi.mock("#meshrix/capabilities/skills/tool-skill-management-provider", () : any => ({
  createToolSkillManagementProvider: factories.createToolSkillManagementProvider
}));
vi.mock("#meshrix/capabilities/operation-permission-core/index", () : any => ({
  createOperationPermissionPlatform: factories.createOperationPermissionPlatform
}));
vi.mock("#meshrix/capabilities/operation-permission-core/store", () : any => ({
  createOperationPermissionStore: factories.createOperationPermissionStore
}));
vi.mock("#meshrix/foundation/observability/executive-report", () : any => ({
  buildExecutiveReport: vi.fn(),
  createExecutiveReportStore: factories.createExecutiveReportStore
}));
vi.mock("#meshrix/foundation/observability/readiness-baseline/baseline-provider", () : any => ({
  createReadinessBaselineProvider: factories.createReadinessBaselineProvider
}));
vi.mock("#meshrix/foundation/observability/sample-capability-pack", () : any => ({
  createSampleCapabilityPackStore: factories.createSampleCapabilityPackStore
}));
vi.mock("@meshrix/foundation/security/security-alerts", () : any => ({
  createSecurityAlertStore: factories.createSecurityAlertStore
}));
vi.mock("#meshrix/agents/agent-memory/index", () : any => ({
  createAgentMemory: factories.createAgentMemory
}));
vi.mock("#meshrix/server-runtime/state/interface/index", () : any => ({
  createContextRuntime: factories.createContextRuntime
}));
vi.mock("#meshrix/agents/maintenance/index", () : any => ({
  createMaintenanceAgentService: factories.createMaintenanceAgentService
}));
vi.mock("#meshrix/server-runtime/composition/maintenance-work-queue-provider", () : any => ({
  createMaintenanceWorkQueueProvider: factories.createMaintenanceWorkQueueProvider
}));
vi.mock("#meshrix/agents/agent-workspace/index", () : any => ({
  createAgentWorkspace: factories.createAgentWorkspace
}));
vi.mock("#meshrix/server-runtime/composition/strategy-management-provider", () : any => ({
  createStrategyManagementProvider: factories.createStrategyManagementProvider
}));

import {
  createServerConsoleOperationProviders,
  createServerRuntimeProviders
} from "../../../packages/server-runtime/src/composition/server-runtime-providers.ts";

function closeable(name?: any, closeOrder?: any, { closeFailure = null }: Record<string, any> = {}) : any {
  let closed: any = false;
  return {
    isClosed: vi.fn(() : any => closed),
    close: vi.fn(async () : Promise<any> => {
      await Promise.resolve();
      closeOrder.push(name);
      if (closeFailure) throw closeFailure;
      closed = true;
    })
  };
}

function runtimeInput(activeFeatures: any = []) : any {
  const active: any = new Set<any>(activeFeatures);
  return {
    userDataPath: "<user-data>",
    runtime: {},
    jobManager: {},
    protocolEventBus: {},
    getDiscoveryState: () : any => ({}),
    getListenUrl: () : any => "",
    getControllers: () : any => null,
    operationAuditStore: {},
    operationLockManager: { acquire: vi.fn() },
    operationConcurrencyScope: "fixture",
    runtimeLogger: {},
    securityPermissions: {},
    activeFeatureIds: [...active],
    isFeatureActive: (featureId?: any) : any => active.has(featureId),
    isAnyFeatureActive: (...featureIds: any[]) : any => featureIds.some((featureId?: any) : any => active.has(featureId))
  };
}

beforeEach(() : any => {
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
  factories.createOperationPermissionStore.mockReturnValue({ close: vi.fn(), isClosed: vi.fn(() : any => false) });
  factories.createReadinessBaselineProvider.mockReturnValue({});
  factories.createSampleCapabilityPackStore.mockReturnValue({});
  factories.createSecurityAlertStore.mockReturnValue({ close: vi.fn() });
  factories.createStrategyManagementProvider.mockReturnValue({});
  factories.createToolSkillManagementProvider.mockReturnValue({});
  factories.createUpstreamGatewayRegistry.mockReturnValue({});
  factories.createUpstreamManifestObserver.mockReturnValue({ start: vi.fn(async () : Promise<any> => {}), close: vi.fn() });
  factories.createUpstreamManifestSnapshotCommitter.mockReturnValue({});
  factories.createUpstreamPublishingApplication.mockReturnValue({ execute: vi.fn() });
  factories.createWorkspaceAssetRegistry.mockReturnValue({});
  factories.createWorkspaceGovernanceRegistry.mockReturnValue({});
});

describe("server runtime provider construction unwind", () : any => {
  const uploadSessionStore: Readonly<Record<string, any>> = Object.freeze({
    resolveUploadSessionFiles: vi.fn(async () : Promise<any> => [])
  });
  const storageProvider: Readonly<Record<string, any>> = Object.freeze({
    getDurableManifestWriterPort: () : any => Object.freeze({ commitManifestSet: vi.fn() }),
    getDurableManifestReaderPort: () : any => Object.freeze({ getSnapshot: vi.fn() }),
    getDurableManifestCandidateAuthorityPort: () : any => Object.freeze({
      getCandidateSnapshot: vi.fn(),
      acknowledgePublished: vi.fn()
    })
  });
  const uploadCustodyReadPort: Readonly<Record<string, any>> = Object.freeze({
    open: vi.fn(async () : Promise<any> => {
      throw new Error("unexpected upload custody access in provider construction fixture");
    })
  });

  it("awaits every earlier console-provider closer in reverse order and preserves the construction error", async () : Promise<any> => {
    const closeOrder: any[] = [];
    const constructionFailure: any = new Error("security alert construction failed");
    const upstream: any = closeable("upstream", closeOrder);
    const workspaceAsset: any = closeable("workspace-asset", closeOrder, {
      closeFailure: new Error("workspace asset close failed")
    });
    factories.createUpstreamGatewayRegistry.mockReturnValue(upstream);
    factories.createWorkspaceAssetRegistry.mockReturnValue(workspaceAsset);
    factories.createSecurityAlertStore.mockImplementation(() : any => {
      throw constructionFailure;
    });

    const failure: any = await createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider,
      uploadSessionStore,
      uploadCustodyReadPort
    }).catch((error?: any) : any => error);

    expect(failure).toBe(constructionFailure);
    expect(closeOrder).toEqual(["workspace-asset", "upstream"]);
    expect(workspaceAsset.close).toHaveBeenCalledOnce();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("shares one successful console-provider close barrier and closes owned resources once", async () : Promise<any> => {
    const closeOrder: any[] = [];
    const upstream: any = closeable("upstream", closeOrder);
    const workspaceAsset: any = closeable("workspace-asset", closeOrder);
    const securityAlert: any = closeable("security-alert", closeOrder);
    factories.createUpstreamGatewayRegistry.mockReturnValue(upstream);
    factories.createWorkspaceAssetRegistry.mockReturnValue(workspaceAsset);
    factories.createSecurityAlertStore.mockReturnValue(securityAlert);
    const providers: any = await createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider,
      uploadSessionStore,
      uploadCustodyReadPort
    });

    const firstClose: any = providers.close();
    const secondClose: any = providers.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    await providers.close();
    expect(closeOrder).toEqual(["security-alert", "workspace-asset", "upstream"]);
    expect(securityAlert.close).toHaveBeenCalledOnce();
    expect(workspaceAsset.close).toHaveBeenCalledOnce();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("retries one transient published-manifest bootstrap rejection", async () : Promise<any> => {
    const observer: Record<string, any> = {
      start: vi.fn(async () : Promise<any> => ({ outcome: "rejected", setRevision: -1 })),
      scan: vi.fn(async () : Promise<any> => ({ outcome: "accepted", setRevision: 0 })),
      close: vi.fn(async () : Promise<any> => {})
    };
    factories.createUpstreamManifestObserver.mockReturnValue(observer);

    const providers: any = await createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider,
      uploadSessionStore,
      uploadCustodyReadPort
    });

    expect(observer.start).toHaveBeenCalledOnce();
    expect(observer.scan).toHaveBeenCalledOnce();
    await providers.close();
    expect(observer.close).toHaveBeenCalledOnce();
  });

  it("fails closed and releases the observer after bounded manifest bootstrap rejection", async () : Promise<any> => {
    const observer: Record<string, any> = {
      start: vi.fn(async () : Promise<any> => ({ outcome: "rejected", setRevision: -1 })),
      scan: vi.fn(async () : Promise<any> => ({ outcome: "rejected", setRevision: -1 })),
      close: vi.fn(async () : Promise<any> => {})
    };
    factories.createUpstreamManifestObserver.mockReturnValue(observer);

    await expect(createServerConsoleOperationProviders({
      userDataPath: "<user-data>",
      securityPermissions: {},
      operationProofSubstrate: {},
      storageProvider,
      uploadSessionStore,
      uploadCustodyReadPort
    })).rejects.toMatchObject({ code: "upstream_manifest_bootstrap_unavailable" });

    expect(observer.start).toHaveBeenCalledOnce();
    expect(observer.scan).toHaveBeenCalledTimes(2);
    expect(observer.close).toHaveBeenCalledOnce();
  });

  it("closes the dedicated maintenance store when the maintenance service factory fails", async () : Promise<any> => {
    const closeOrder: any[] = [];
    const constructionFailure: any = new Error("maintenance service construction failed");
    const agentMemory: any = closeable("agent-memory", closeOrder);
    const contextRuntime: any = closeable("context-runtime", closeOrder);
    const operationPermissionStore: any = closeable("operation-permission", closeOrder);
    const maintenanceWorkQueue: any = closeable("maintenance-work-queue", closeOrder);
    maintenanceWorkQueue.start = vi.fn();
    maintenanceWorkQueue.stop = vi.fn(async () : Promise<any> => {
      closeOrder.push("maintenance-work-queue-stop");
    });
    factories.createAgentMemory.mockReturnValue(agentMemory);
    factories.createContextRuntime.mockReturnValue(contextRuntime);
    factories.createOperationPermissionStore.mockReturnValue(operationPermissionStore);
    factories.createMaintenanceWorkQueueProvider.mockReturnValue(maintenanceWorkQueue);
    factories.createMaintenanceAgentService.mockImplementation(() : any => {
      throw constructionFailure;
    });

    const failure: any = await createServerRuntimeProviders(runtimeInput([
      "maintenance-agent-runbooks"
    ])).catch((error?: any) : any => error);

    expect(failure).toBe(constructionFailure);
    expect(closeOrder).toEqual([
      "maintenance-work-queue",
      "operation-permission",
      "context-runtime",
      "agent-memory"
    ]);
    expect(operationPermissionStore.close).toHaveBeenCalledOnce();
  });

  it("unwinds workspace and maintenance owners before their dependencies after a later provider failure", async () : Promise<any> => {
    const closeOrder: any[] = [];
    const constructionFailure: any = new Error("strategy construction failed");
    const agentMemory: any = closeable("agent-memory", closeOrder);
    const contextRuntime: any = closeable("context-runtime", closeOrder);
    const operationPermissionStore: any = closeable("operation-permission", closeOrder);
    const maintenanceWorkQueue: any = closeable("maintenance-work-queue", closeOrder);
    maintenanceWorkQueue.start = vi.fn();
    maintenanceWorkQueue.stop = vi.fn(async () : Promise<any> => {
      closeOrder.push("maintenance-work-queue-stop");
    });
    const maintenanceAgent: any = closeable("maintenance", closeOrder, {
      closeFailure: new Error("maintenance close failed")
    });
    maintenanceAgent.start = vi.fn(async () : Promise<any> => {});
    const agentWorkspace: any = closeable("agent-workspace", closeOrder, {
      closeFailure: new Error("workspace close failed")
    });
    factories.createAgentMemory.mockReturnValue(agentMemory);
    factories.createContextRuntime.mockReturnValue(contextRuntime);
    factories.createOperationPermissionStore.mockReturnValue(operationPermissionStore);
    factories.createMaintenanceWorkQueueProvider.mockReturnValue(maintenanceWorkQueue);
    operationPermissionStore.isClosed.mockImplementation(() : any => {
      throw new Error("operation permission state check failed");
    });
    factories.createMaintenanceAgentService.mockReturnValue(maintenanceAgent);
    factories.createAgentWorkspace.mockReturnValue(agentWorkspace);
    factories.createStrategyManagementProvider.mockImplementation(() : any => {
      throw constructionFailure;
    });

    const failure: any = await createServerRuntimeProviders(runtimeInput([
      "maintenance-agent-runbooks",
      "agent-workspace-core",
      "strategy-management"
    ])).catch((error?: any) : any => error);

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
