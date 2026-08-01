import path from "node:path";

import { loadSettings } from "#meshrix/settings";
import { getAgentConfigRegistry } from "#meshrix/agents/agent-configs/config-registry";
import { createAgentRuntimeProvider } from "#meshrix/agents/agent-runtime-provider";
import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestObserver,
  createUpstreamPublishingApplication,
  createUpstreamManifestSnapshotCommitter
} from "#meshrix/agents/upstream-gateway/index";
import { createWorkspaceGovernanceRegistry } from "#meshrix/agents/workspace-governance/index";
import {
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION,
  createContributionRegistry
} from "#meshrix/agents/workspace-contribution";
import { createWorkspaceAssetRegistry } from "#meshrix/agents/workspace-asset-registry/index";
import { createToolSkillManagementProvider } from "#meshrix/capabilities/skills/tool-skill-management-provider";
import { createOperationPermissionPlatform } from "#meshrix/capabilities/operation-permission-core/index";
import { createOperationPermissionStore } from "#meshrix/capabilities/operation-permission-core/store";
import { broadcastAudienceCatalogInvalidation } from "#meshrix/protocols/mcp/adapter/http-mcp-adapter";
import { disconnectMcpSseConnectionsByGrant } from "../state/sse-connection-state.ts";
import {
  buildExecutiveReport,
  createExecutiveReportStore
} from "#meshrix/foundation/observability/executive-report";
import { createReadinessBaselineProvider } from "#meshrix/foundation/observability/readiness-baseline/baseline-provider";
import { createSampleCapabilityPackStore } from "#meshrix/foundation/observability/sample-capability-pack";
import { createSecurityAlertStore } from "#meshrix/foundation/security/security-alerts";
import { bindOperationDispatcher } from "./dispatch-operation.ts";
import { createArtifactTransitProvider, createWorkspaceArtifactFileStore } from "./artifact-transit-provider.ts";

const UPSTREAM_MANIFEST_BOOTSTRAP_ATTEMPTS: any = 3;

async function createProvider(enabled?: any, specifier?: any, exportName?: any, args: any = []) : Promise<any> {
  if (!enabled) {
    return null;
  }
  const loaded: any = await import(specifier);
  const factory: any = loaded[exportName];
  if (typeof factory !== "function") {
    throw new Error(`Runtime provider ${specifier} does not export ${exportName}.`);
  }
  return factory(...args);
}

async function closeOwnedResourcesInReverse(resources: any = []) : Promise<any> {
  const failures: any[] = [];
  const closedResources: any = new Set<any>();
  for (let index: any = resources.length - 1; index >= 0; index -= 1) {
    const resource: any = resources[index];
    if (!resource || closedResources.has(resource) || typeof resource.close !== "function") {
      continue;
    }
    closedResources.add(resource);
    try {
      await resource.close();
    } catch (error: any) {
      failures.push(error);
    }
  }
  return failures;
}

async function startUpstreamManifestObserver(observer?: any) : Promise<any> {
  let outcome: any = await observer.start();
  for (
    let attempt: any = 1;
    attempt < UPSTREAM_MANIFEST_BOOTSTRAP_ATTEMPTS && outcome?.outcome === "rejected";
    attempt += 1
  ) {
    outcome = await observer.scan();
  }
  if (outcome?.outcome === "rejected") {
    const error: Error & Record<string, any> = new Error("Published upstream manifest snapshot was unavailable during bootstrap.");
    error.code = "upstream_manifest_bootstrap_unavailable";
    throw error;
  }
  return outcome;
}

function maintenanceOwnershipResource(
  maintenanceAgent?: any,
  maintenanceWorkQueue?: any,
  operationPermissionStore?: any
) : any {
  return {
    async close() : Promise<any> {
      let failure: any = null;
      try {
        await maintenanceWorkQueue?.stop?.();
      } catch (error: any) {
        failure = error;
      }
      if (failure) throw failure;
      try {
        await maintenanceAgent?.close?.();
      } catch (error: any) {
        failure = error;
      }
      try {
        await maintenanceWorkQueue?.close?.();
      } catch (error: any) {
        failure ||= error;
      }
      let operationPermissionStoreClosed: any = false;
      try {
        operationPermissionStoreClosed =
          typeof operationPermissionStore?.isClosed === "function" &&
          operationPermissionStore.isClosed();
      } catch (error: any) {
        failure ||= error;
      }
      if (!operationPermissionStoreClosed) {
        try {
          await operationPermissionStore?.close?.();
        } catch (error: any) {
          failure ||= error;
        }
      }
      if (failure) throw failure;
    }
  };
}

export function createServerOperationPermissionPlatform({
  userDataPath,
  operations,
  featureRuntime,
  controllers,
  operationAuditStore,
  operationLockManager,
  operationConcurrencyScope,
  protocolEventBus,
  consoleAuth,
  securityPermissions,
  proofSubstrate = null,
  logger
}: Record<string, any>) : any {
  const operationDispatcher: any = bindOperationDispatcher({
    lockManager: operationLockManager,
    concurrencyScope: operationConcurrencyScope
  });
  return createOperationPermissionPlatform({
    userDataPath,
    operations,
    operationDispatcher,
    featureRuntime,
    controllers,
    operationAuditStore,
    operationConcurrencyScope,
    protocolEventBus,
    consoleAuth,
    securityPermissions,
    proofSubstrate,
    logger
  });
}

export function createServerToolSkillManagementProvider({
  operationPermissionPlatform,
  userDataPath,
  securityPermissions,
  evaluateToolAudience = null,
  resolveAudiencePartitionKeys = null,
  resolveAudienceCatalogFacts = null,
  logger
}: Record<string, any>) : any {
  return createToolSkillManagementProvider({
    operationPermissionPlatform,
    userDataPath,
    securityPermissions,
    evaluateToolAudience,
    resolveAudiencePartitionKeys,
    resolveAudienceCatalogFacts,
    logger
  });
}

export function createServerUpstreamGatewayRegistry({
  userDataPath,
  securityPermissions,
  artifactTransitPort = null,
  tagStore = securityPermissions?.tagManagementStore || null
}: Record<string, any>) : any {
  return createUpstreamGatewayRegistry({
    userDataPath,
    securityPermissions,
    artifactTransitPort,
    tagStore
  });
}

export async function createServerConsoleOperationProviders({
  userDataPath,
  securityPermissions,
  operationProofSubstrate,
  storageProvider,
  uploadSessionStore,
  operationAuditStore,
  getListenUrl = () : any => "",
  getAgentWorkspace = () : any => null
}: Record<string, any>) : Promise<any> {
  const contributionRegistries: any = new Map<any, any>();
  const ownedResources: any[] = [];
  try {
    if (typeof uploadSessionStore?.resolveUploadSessionFiles !== "function") {
      throw new TypeError("Server operation providers require the bound upload session store.");
    }
    const uploadSessionReadPort: Readonly<Record<string, any>> = Object.freeze({
      resolveUploadSessionFiles(_userDataPath?: any, sessionId?: any, options: Record<string, any> = {}) : any {
        return uploadSessionStore.resolveUploadSessionFiles(sessionId, options);
      }
    });
    const artifactTransitPort: any = await createArtifactTransitProvider({
      userDataPath,
      uploadSessionStore: uploadSessionReadPort,
      workspaceFileStore: createWorkspaceArtifactFileStore({ getAgentWorkspace }),
      getListenUrl
    });
    ownedResources.push(artifactTransitPort);
    const upstreamGatewayRegistry: any = createServerUpstreamGatewayRegistry({
      userDataPath,
      securityPermissions,
      artifactTransitPort,
      tagStore: securityPermissions?.tagManagementStore || null
    });
    ownedResources.push(upstreamGatewayRegistry);
    let manifestSnapshotCommitter: any = null;
    let gatewayOnlySnapshot: any = null;
    let bootstrapReadPending: any = true;
    const manifestReaderPort: any = storageProvider?.getDurableManifestReaderPort?.();
    const manifestCandidateAuthorityPort: any = storageProvider?.getDurableManifestCandidateAuthorityPort?.();
    const durableManifestWriterPort: any = storageProvider?.getDurableManifestWriterPort?.();
    if (typeof manifestCandidateAuthorityPort?.getCandidateSnapshot !== "function" ||
        typeof manifestCandidateAuthorityPort?.acknowledgePublished !== "function") {
      throw new TypeError("Upstream manifest runtime requires durable candidate authority operations.");
    }
    const manifestCandidateReaderPort: Readonly<Record<string, any>> = Object.freeze({
      getSnapshot: manifestCandidateAuthorityPort.getCandidateSnapshot
    });
    const manifestRuntimeReaderPort: Readonly<Record<string, any>> = Object.freeze({
      async getSnapshot(input: Record<string, any> = {}) : Promise<any> {
        if (!bootstrapReadPending) {
          return manifestCandidateAuthorityPort.getCandidateSnapshot(input);
        }
        const snapshot: any = await manifestReaderPort?.getSnapshot?.(input);
        if (!snapshot) {
          throw new TypeError("Upstream manifest runtime requires a published snapshot reader.");
        }
        bootstrapReadPending = false;
        return snapshot;
      }
    });
    const upstreamManifestObserver: any = createUpstreamManifestObserver({
      readerPort: manifestRuntimeReaderPort,
      async onSnapshot(snapshot?: any) : Promise<any> {
        if (manifestSnapshotCommitter) {
          await manifestSnapshotCommitter.commitManifestSnapshot(snapshot);
          await manifestCandidateAuthorityPort.acknowledgePublished({
            setRevision: snapshot.setRevision,
            setDigest: snapshot.setDigest
          });
          return;
        }
        upstreamGatewayRegistry.replaceFromManifestSnapshot(snapshot);
        gatewayOnlySnapshot = snapshot;
      },
      onError(event?: any) : any {
        try {
          operationAuditStore?.append?.({
            operationId: "external_services.observe",
            transport: "application",
            risk: "read_only",
            readOnly: true,
            status: "rejected",
            input: {
              reasonCode: String(event?.reasonCode || "manifest_candidate_rejected"),
              errorCode: String(event?.errorCode || "manifest_observation_failed")
            }
          });
        } catch {
          // Observation NACK audit must not interrupt retry scheduling.
        }
      }
    });
    ownedResources.push(upstreamManifestObserver);
    await startUpstreamManifestObserver(upstreamManifestObserver);
    const upstreamPublishingApplication: any = createUpstreamPublishingApplication({
      writerPort: {
        async commitManifestSet(input?: any) : Promise<any> {
          const outcome: any = await durableManifestWriterPort.commitManifestSet(input);
          if (!outcome.replayed) upstreamManifestObserver.invalidate();
          return outcome;
        }
      },
      readerPort: manifestCandidateReaderPort,
      publishedReaderPort: manifestReaderPort,
      getPublicationFacts: () : any => manifestSnapshotCommitter?.getPublicationFacts?.() || null,
      auditPort: {
        append(event?: any) : any {
          if (typeof operationAuditStore?.append !== "function") {
            throw new Error("Upstream publishing audit authority is unavailable.");
          }
          return operationAuditStore.append({
            operationId: "external_services.publish",
            transport: "application",
            risk: "safe_write",
            readOnly: false,
            status: "accepted",
            input: event
          });
        }
      }
    });
    const workspaceAssetRegistry: any = createWorkspaceAssetRegistry({ userDataPath });
    ownedResources.push(workspaceAssetRegistry);
    const workspaceGovernanceRegistry: any = createWorkspaceGovernanceRegistry({ userDataPath });
    ownedResources.push(workspaceGovernanceRegistry);
    const readinessBaselineProvider: any = createReadinessBaselineProvider({ userDataPath });
    ownedResources.push(readinessBaselineProvider);
    const executiveReportStore: any = createExecutiveReportStore({ userDataPath });
    ownedResources.push(executiveReportStore);
    const sampleCapabilityPackStore: any = createSampleCapabilityPackStore({ userDataPath });
    ownedResources.push(sampleCapabilityPackStore);
    const securityAlertStore: any = createSecurityAlertStore({ userDataPath });
    ownedResources.push(securityAlertStore);
    const executiveReportProvider: Readonly<Record<string, any>> = Object.freeze({
      preview: buildExecutiveReport,
      list: (input: Record<string, any> = {}) : any => executiveReportStore.list(input),
      generate: (input: Record<string, any> = {}) : any => executiveReportStore.generate(input)
    });
    let closePromise: any = null;

    return Object.freeze({
      getContributionRegistry(input: Record<string, any> = {}, context: Record<string, any> = {}) : any {
        const workspaceId: any = String(
          input.registryWorkspaceId ||
          input.contributionRegistryWorkspaceId ||
          context.contributionRegistryWorkspaceId ||
          input.workspaceId ||
          "default"
        ).trim();
        if (!contributionRegistries.has(workspaceId)) {
          const contributionRegistry: any = createContributionRegistry({
            workspaceId,
            userDataPath,
            excludedContributionTypes: ["skill"],
            lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
          });
          contributionRegistries.set(workspaceId, contributionRegistry);
          ownedResources.push(contributionRegistry);
        }
        return contributionRegistries.get(workspaceId);
      },
      upstreamGatewayRegistry,
      artifactTransitPort,
      upstreamPublishingApplication,
      async bindUpstreamManifestSnapshotCommit({
        getBaseOperations,
        getOperationPermissionPlatform,
        protocolEventBus = null
      }: Record<string, any> = {}) : Promise<any> {
        if (typeof getBaseOperations !== "function" || typeof getOperationPermissionPlatform !== "function") {
          throw new TypeError("Upstream manifest snapshot commit binding requires operation sources.");
        }
        manifestSnapshotCommitter = createUpstreamManifestSnapshotCommitter({
          registry: upstreamGatewayRegistry,
          getBaseOperations,
          getOperationPermissionPlatform,
          getGrants: () : any => {
            const platform: any = getOperationPermissionPlatform?.();
            return typeof platform?.store?.listGrants === "function"
              ? platform.store.listGrants({ includeRevoked: false })
              : [];
          },
          getTagStore: () : any => securityPermissions?.tagManagementStore || null,
          getPolicyRevision: () : any => Number(securityPermissions?.getGovernancePolicyRevision?.()?.revision || 0) || 0,
          getTagRevision: () : any => Number(securityPermissions?.tagManagementStore?.getPolicyRevision?.()?.revision || 0) || 0,
          protocolEventBus,
          onAudiencePublished({ projection, previousProjection }: Record<string, any>) : any {
            broadcastAudienceCatalogInvalidation({
              sourceRevision: projection.sourceRevision,
              catalogRevision: projection.catalogRevision || projection.catalogFingerprint,
              audienceRevision: projection.audienceRevision,
              affectedPartitions: projection.affectedPartitions,
              partitions: projection.partitions,
              previousPartitions: previousProjection?.partitions || null,
              reasonCode: "upstream_audiences_published"
            });
          }
        });
        const refreshAudience: any = async (event: Record<string, any> = {}) : Promise<any> => {
          const result: any = await manifestSnapshotCommitter?.refreshAudienceProjection?.();
          if (["grant_token_rotated", "grant_revoked", "grant_deleted"].includes(event?.reasonCode)) {
            disconnectMcpSseConnectionsByGrant(event.grantId);
          }
          return result;
        };
        const unregisterOperationPermissionChange: any = getOperationPermissionPlatform()?.registerChangeHandler?.(
          refreshAudience
        );
        const unregisterTagChange: any = securityPermissions?.tagManagementStore?.registerChangeHandler?.(
          refreshAudience
        );
        if (typeof unregisterOperationPermissionChange === "function") {
          ownedResources.push({ close: unregisterOperationPermissionChange });
        }
        if (typeof unregisterTagChange === "function") {
          ownedResources.push({ close: unregisterTagChange });
        }
        if (!gatewayOnlySnapshot) {
          throw new Error("Published upstream manifest snapshot was not available for commit binding.");
        }
        await manifestSnapshotCommitter.commitManifestSnapshot(gatewayOnlySnapshot);
        // A newer candidate is independent of the published bootstrap. Rejection
        // leaves the paired published snapshot authoritative and retryable.
        await upstreamManifestObserver.scan();
        return manifestSnapshotCommitter;
      },
      getUpstreamManifestSnapshotCommitter() : any {
        return manifestSnapshotCommitter;
      },
      operationProofSubstrate,
      workspaceAssetRegistry,
      workspaceGovernanceRegistry,
      readinessBaselineProvider,
      executiveReportProvider,
      sampleCapabilityPackStore,
      securityAlertStore,
      close() : any {
        if (closePromise) return closePromise;
        closePromise = (async () : Promise<any> => {
          contributionRegistries.clear();
          const failures: any = await closeOwnedResourcesInReverse(ownedResources);
          if (failures.length > 0) {
            throw new Error("Console operation providers did not shut down cleanly.");
          }
        })().catch((error?: any) : any => {
          closePromise = null;
          throw error;
        });
        return closePromise;
      }
    });
  } catch (error: any) {
    contributionRegistries.clear();
    await closeOwnedResourcesInReverse(ownedResources);
    throw error;
  }
}

export function createServerConsoleDomainServices({
  userDataPath,
  createConsoleDomainServices,
  consoleOperationProviders,
  settingsPort,
  uploadSessionStore
}: Record<string, any>) : any {
  if (typeof createConsoleDomainServices !== "function") {
    throw new TypeError("Server composition requires a console domain service adapter factory.");
  }
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.saveSettings !== "function" ||
    typeof settingsPort.normalizeSettings !== "function" ||
    typeof settingsPort.getSettingsPath !== "function"
  ) {
    throw new TypeError("Server composition requires an explicit settings port.");
  }
  if (
    !uploadSessionStore ||
    typeof uploadSessionStore.createOrResumeUploadSession !== "function" ||
    typeof uploadSessionStore.appendUploadSessionChunk !== "function" ||
    typeof uploadSessionStore.getUploadSession !== "function" ||
    typeof uploadSessionStore.resolveUploadSessionFiles !== "function" ||
    typeof uploadSessionStore.buildCheckpointReceiptFromUploadSession !== "function" ||
    typeof uploadSessionStore.deleteUploadSession !== "function"
  ) {
    throw new TypeError("Server composition requires the bound upload session store.");
  }
  const runtimeAgentConfigRegistry: any = () : any => getAgentConfigRegistry({
    rootPath: path.join(userDataPath, "agent-configs")
  });
  const loadAgentGatewayModule: any = () : any => import("#meshrix/agents/agent-gateway/index");
  const loadModelProbeModule: any = () : any => import("#meshrix/agents/agent-gateway/model-probe/index");
  const agentRuntimeProvider: any = createAgentRuntimeProvider({
    getAgentConfigRegistry: runtimeAgentConfigRegistry,
    loadAgentGatewayModule,
    loadModelProbeModule,
    loadRuntimeSettings: settingsPort.loadSettings
  });
  return createConsoleDomainServices({
    userDataPath,
    getAgentConfigRegistry: runtimeAgentConfigRegistry,
    agentRuntimeProvider,
    uploadSessionStore,
    consoleOperationProviders,
    settingsPort,
    loadAgentGatewayModule,
    loadModelProbeModule
  });
}

export async function createServerRuntimeProviders({
  userDataPath,
  runtime,
  jobManager,
  protocolEventBus,
  queueApplicationPort,
  getDiscoveryState,
  getListenUrl,
  getControllers,
  operationAuditStore,
  operationProofSubstrate,
  operationLockManager,
  operationConcurrencyScope,
  dataStructureSubstrate = null,
  runtimeLogger,
  securityPermissions,
  getJobWorkflowProvider = () : any => null,
  getOperationPermissionPlatform = () : any => null,
  materializationRootAuthority = null,
  controlledLocalDirectoryHostEnabled = false,
  activeFeatureIds = [],
  isFeatureActive,
  isAnyFeatureActive
}: Record<string, any>) : Promise<any> {
  const ownedResources: any[] = [];
  try {
    const operationDispatcher: any = bindOperationDispatcher({
      lockManager: operationLockManager,
      concurrencyScope: operationConcurrencyScope
    });
    let strategyManagementProvider: any = null;
    const needsContextRuntime: any = isAnyFeatureActive(
      "context-runtime-core",
      "maintenance-agent-runbooks"
    );
    const needsAgentMemory: any = isFeatureActive("agent-memory") || needsContextRuntime;
    const agentMemory: any = await createProvider(
      needsAgentMemory,
      "#meshrix/agents/agent-memory/index",
      "createAgentMemory",
      [{ userDataPath }]
    );
    ownedResources.push(agentMemory);
    const callAgentGatewayIfAvailable: any = async (input: Record<string, any> = {}, options: Record<string, any> = {}) : Promise<any> => {
      if (!isFeatureActive("agent-gateway")) {
        throw new Error("AgentGateway feature is not active in this feature edition.");
      }
      const { callAgentGateway } = await import("#meshrix/agents/agent-gateway/index");
      return callAgentGateway({
        ...options,
        input,
        userDataPath
      });
    };
    const contextRuntime: any = await createProvider(
      needsContextRuntime,
      "#meshrix/server-runtime/state/interface/index",
      "createContextRuntime",
      [{
        userDataPath,
        agentMemory,
        agentGatewayCall: async (input: Record<string, any> = {}) : Promise<any> => callAgentGatewayIfAvailable(input, {
          settings: await loadSettings(userDataPath),
          contextCompactionSource: "context-runtime"
        })
      }]
    );
    ownedResources.push(contextRuntime);
    const maintenanceAgentEnabled: any = isFeatureActive("maintenance-agent-runbooks");
    const maintenanceOperationPermissionStore: any = maintenanceAgentEnabled
      ? createOperationPermissionStore({
          userDataPath,
          securityPermissions,
          governancePolicyRevisionProvider: () : any =>
            securityPermissions?.getGovernancePolicyRevision?.()
        })
      : null;
    if (maintenanceOperationPermissionStore) {
      ownedResources.push(maintenanceOperationPermissionStore);
    }
    let maintenanceAgent: any = null;
    const maintenanceWorkQueue: any = await createProvider(
      maintenanceAgentEnabled,
      "#meshrix/server-runtime/composition/maintenance-work-queue-provider",
      "createMaintenanceWorkQueueProvider",
      maintenanceAgentEnabled
        ? [{
            queueApplicationPort,
            getMaintenanceAgent: () : any => maintenanceAgent,
            capabilitySelected: true,
            autoStart: false,
            consumerEnabled: process.env.MESHRIX_MAINTENANCE_WORKER_EXTERNAL !== "1"
          }]
        : []
    );
    if (maintenanceWorkQueue) {
      ownedResources.push(maintenanceWorkQueue);
    }
    maintenanceAgent = await createProvider(
      maintenanceAgentEnabled,
      "#meshrix/agents/maintenance/index",
      "createMaintenanceAgentService",
      maintenanceAgentEnabled
        ? [{
            userDataPath,
            runtime,
            jobManager,
            protocolEventBus,
            getDiscoveryState,
            getListenUrl,
            contextRuntime,
            loadRuntimeSettings: loadSettings,
            getControllers,
            operationDispatcher,
            operationAuditStore,
            operationProofSubstrate,
            operationConcurrencyScope,
            operationPermissionStore: maintenanceOperationPermissionStore,
            getGovernancePolicyRevision: () : any =>
              securityPermissions?.getGovernancePolicyRevision?.(),
            workQueuePort: maintenanceWorkQueue,
            schedulerEnabled: process.env.MESHRIX_MAINTENANCE_WORKER_EXTERNAL !== "1",
            logger: runtimeLogger
          }]
        : []
    );
    if (maintenanceAgent) {
      ownedResources.pop();
      ownedResources.pop();
      ownedResources.push(maintenanceOwnershipResource(
        maintenanceAgent,
        maintenanceWorkQueue,
        maintenanceOperationPermissionStore
      ));
      await maintenanceAgent.start();
      maintenanceWorkQueue.start();
    }
    const agentWorkspace: any = await createProvider(
      isFeatureActive("agent-workspace-core"),
      "#meshrix/agents/agent-workspace/index",
      "createAgentWorkspace",
      [{
        userDataPath,
        merkleState: dataStructureSubstrate?.merkleStateSubstrate || null,
        checkpointTreeApi: dataStructureSubstrate?.checkpointTreeProjection || null,
        materializationRootAuthority,
        controlledLocalDirectoryHostEnabled
      }]
    );
    ownedResources.push(agentWorkspace);
    const needsStrategyManagement: any = isFeatureActive("strategy-management");
    strategyManagementProvider = await createProvider(
      needsStrategyManagement,
      "#meshrix/server-runtime/composition/strategy-management-provider",
      "createStrategyManagementProvider",
      [{
        getOperationPermissionPlatform
      }]
    );
    ownedResources.push(strategyManagementProvider);
    return Object.freeze({
      contextRuntime,
      maintenanceAgent,
      maintenanceWorkQueue,
      agentWorkspace,
      strategyManagementProvider,
      modelDecisionRuntime: null
    });
  } catch (error: any) {
    await closeOwnedResourcesInReverse(ownedResources);
    throw error;
  }
}
