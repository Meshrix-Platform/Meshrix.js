import path from "node:path";

import { loadSettings } from "#lico/settings";
import { getAgentConfigRegistry } from "#lico/agents/agent-configs/config-registry";
import { createAgentRuntimeProvider } from "#lico/agents/agent-runtime-provider";
import {
  createUpstreamGatewayRegistry,
  createUpstreamManifestObserver,
  createUpstreamPublishingApplication,
  createUpstreamManifestSnapshotCommitter
} from "#lico/agents/upstream-gateway/index";
import { createWorkspaceGovernanceRegistry } from "#lico/agents/workspace-governance/index";
import {
  CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION,
  createContributionRegistry
} from "#lico/agents/workspace-contribution";
import { createWorkspaceAssetRegistry } from "#lico/agents/workspace-asset-registry/index";
import { createToolSkillManagementProvider } from "#lico/capabilities/skills/tool-skill-management-provider";
import { createOperationPermissionPlatform } from "#lico/capabilities/operation-permission-core/index";
import { createOperationPermissionStore } from "#lico/capabilities/operation-permission-core/store";
import { broadcastAudienceCatalogInvalidation } from "#lico/protocols/mcp/adapter/http-mcp-adapter";
import { disconnectMcpSseConnectionsByGrant } from "../state/sse-connection-state.mjs";
import {
  buildExecutiveReport,
  createExecutiveReportStore
} from "#lico/foundation/observability/executive-report";
import { createReadinessBaselineProvider } from "#lico/foundation/observability/readiness-baseline/baseline-provider";
import { createSampleCapabilityPackStore } from "#lico/foundation/observability/sample-capability-pack";
import { createSecurityAlertStore } from "#lico/foundation/security/security-alerts";
import { bindOperationDispatcher } from "./dispatch-operation.mjs";
import {
  appendUploadSessionChunk,
  buildCheckpointReceiptFromUploadSession,
  createOrResumeUploadSession,
  deleteUploadSession,
  getUploadSession,
  resolveUploadSessionFiles
} from "../state/upload-session-store.mjs";
import { createArtifactTransitProvider } from "./artifact-transit-provider.mjs";

const UPSTREAM_MANIFEST_BOOTSTRAP_ATTEMPTS = 3;

async function createProvider(enabled, specifier, exportName, args = []) {
  if (!enabled) {
    return null;
  }
  const loaded = await import(specifier);
  const factory = loaded[exportName];
  if (typeof factory !== "function") {
    throw new Error(`Runtime provider ${specifier} does not export ${exportName}.`);
  }
  return factory(...args);
}

async function closeOwnedResourcesInReverse(resources = []) {
  const failures = [];
  const closedResources = new Set();
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const resource = resources[index];
    if (!resource || closedResources.has(resource) || typeof resource.close !== "function") {
      continue;
    }
    closedResources.add(resource);
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function startUpstreamManifestObserver(observer) {
  let outcome = await observer.start();
  for (
    let attempt = 1;
    attempt < UPSTREAM_MANIFEST_BOOTSTRAP_ATTEMPTS && outcome?.outcome === "rejected";
    attempt += 1
  ) {
    outcome = await observer.scan();
  }
  if (outcome?.outcome === "rejected") {
    const error = new Error("Published upstream manifest snapshot was unavailable during bootstrap.");
    error.code = "upstream_manifest_bootstrap_unavailable";
    throw error;
  }
  return outcome;
}

function maintenanceOwnershipResource(
  maintenanceAgent,
  maintenanceWorkQueue,
  operationPermissionStore
) {
  return {
    async close() {
      let failure = null;
      try {
        await maintenanceWorkQueue?.stop?.();
      } catch (error) {
        failure = error;
      }
      if (failure) throw failure;
      try {
        await maintenanceAgent?.close?.();
      } catch (error) {
        failure = error;
      }
      try {
        await maintenanceWorkQueue?.close?.();
      } catch (error) {
        failure ||= error;
      }
      let operationPermissionStoreClosed = false;
      try {
        operationPermissionStoreClosed =
          typeof operationPermissionStore?.isClosed === "function" &&
          operationPermissionStore.isClosed();
      } catch (error) {
        failure ||= error;
      }
      if (!operationPermissionStoreClosed) {
        try {
          await operationPermissionStore?.close?.();
        } catch (error) {
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
}) {
  const operationDispatcher = bindOperationDispatcher({
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
}) {
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
}) {
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
  operationAuditStore,
  getListenUrl = () => ""
}) {
  const contributionRegistries = new Map();
  const ownedResources = [];
  try {
    const uploadSessionReadPort = Object.freeze({ resolveUploadSessionFiles });
    const artifactTransitPort = await createArtifactTransitProvider({
      userDataPath,
      uploadSessionStore: uploadSessionReadPort,
      getListenUrl
    });
    ownedResources.push(artifactTransitPort);
    const upstreamGatewayRegistry = createServerUpstreamGatewayRegistry({
      userDataPath,
      securityPermissions,
      artifactTransitPort,
      tagStore: securityPermissions?.tagManagementStore || null
    });
    ownedResources.push(upstreamGatewayRegistry);
    let manifestSnapshotCommitter = null;
    let gatewayOnlySnapshot = null;
    let bootstrapReadPending = true;
    const manifestReaderPort = storageProvider?.getDurableManifestReaderPort?.();
    const manifestCandidateAuthorityPort = storageProvider?.getDurableManifestCandidateAuthorityPort?.();
    const durableManifestWriterPort = storageProvider?.getDurableManifestWriterPort?.();
    if (typeof manifestCandidateAuthorityPort?.getCandidateSnapshot !== "function" ||
        typeof manifestCandidateAuthorityPort?.acknowledgePublished !== "function") {
      throw new TypeError("Upstream manifest runtime requires durable candidate authority operations.");
    }
    const manifestCandidateReaderPort = Object.freeze({
      getSnapshot: manifestCandidateAuthorityPort.getCandidateSnapshot
    });
    const manifestRuntimeReaderPort = Object.freeze({
      async getSnapshot(input = {}) {
        if (!bootstrapReadPending) {
          return manifestCandidateAuthorityPort.getCandidateSnapshot(input);
        }
        const snapshot = await manifestReaderPort?.getSnapshot?.(input);
        if (!snapshot) {
          throw new TypeError("Upstream manifest runtime requires a published snapshot reader.");
        }
        bootstrapReadPending = false;
        return snapshot;
      }
    });
    const upstreamManifestObserver = createUpstreamManifestObserver({
      readerPort: manifestRuntimeReaderPort,
      async onSnapshot(snapshot) {
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
      onError(event) {
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
    const upstreamPublishingApplication = createUpstreamPublishingApplication({
      writerPort: {
        async commitManifestSet(input) {
          const outcome = await durableManifestWriterPort.commitManifestSet(input);
          if (!outcome.replayed) upstreamManifestObserver.invalidate();
          return outcome;
        }
      },
      readerPort: manifestCandidateReaderPort,
      publishedReaderPort: manifestReaderPort,
      getPublicationFacts: () => manifestSnapshotCommitter?.getPublicationFacts?.() || null,
      auditPort: {
        append(event) {
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
    const workspaceAssetRegistry = createWorkspaceAssetRegistry({ userDataPath });
    ownedResources.push(workspaceAssetRegistry);
    const workspaceGovernanceRegistry = createWorkspaceGovernanceRegistry({ userDataPath });
    ownedResources.push(workspaceGovernanceRegistry);
    const readinessBaselineProvider = createReadinessBaselineProvider({ userDataPath });
    ownedResources.push(readinessBaselineProvider);
    const executiveReportStore = createExecutiveReportStore({ userDataPath });
    ownedResources.push(executiveReportStore);
    const sampleCapabilityPackStore = createSampleCapabilityPackStore({ userDataPath });
    ownedResources.push(sampleCapabilityPackStore);
    const securityAlertStore = createSecurityAlertStore({ userDataPath });
    ownedResources.push(securityAlertStore);
    const executiveReportProvider = Object.freeze({
      preview: buildExecutiveReport,
      list: (input = {}) => executiveReportStore.list(input),
      generate: (input = {}) => executiveReportStore.generate(input)
    });
    let closePromise = null;

    return Object.freeze({
      getContributionRegistry(input = {}, context = {}) {
        const workspaceId = String(
          input.registryWorkspaceId ||
          input.contributionRegistryWorkspaceId ||
          context.contributionRegistryWorkspaceId ||
          input.workspaceId ||
          "default"
        ).trim();
        if (!contributionRegistries.has(workspaceId)) {
          const contributionRegistry = createContributionRegistry({
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
      } = {}) {
        if (typeof getBaseOperations !== "function" || typeof getOperationPermissionPlatform !== "function") {
          throw new TypeError("Upstream manifest snapshot commit binding requires operation sources.");
        }
        manifestSnapshotCommitter = createUpstreamManifestSnapshotCommitter({
          registry: upstreamGatewayRegistry,
          getBaseOperations,
          getOperationPermissionPlatform,
          getGrants: () => {
            const platform = getOperationPermissionPlatform?.();
            return typeof platform?.store?.listGrants === "function"
              ? platform.store.listGrants({ includeRevoked: false })
              : [];
          },
          getTagStore: () => securityPermissions?.tagManagementStore || null,
          getPolicyRevision: () => Number(securityPermissions?.getGovernancePolicyRevision?.()?.revision || 0) || 0,
          getTagRevision: () => Number(securityPermissions?.tagManagementStore?.getPolicyRevision?.()?.revision || 0) || 0,
          protocolEventBus,
          onAudiencePublished({ projection, previousProjection }) {
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
        const refreshAudience = async (event = {}) => {
          const result = await manifestSnapshotCommitter?.refreshAudienceProjection?.();
          if (["grant_token_rotated", "grant_revoked", "grant_deleted"].includes(event?.reasonCode)) {
            disconnectMcpSseConnectionsByGrant(event.grantId);
          }
          return result;
        };
        const unregisterOperationPermissionChange = getOperationPermissionPlatform()?.registerChangeHandler?.(
          refreshAudience
        );
        const unregisterTagChange = securityPermissions?.tagManagementStore?.registerChangeHandler?.(
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
      getUpstreamManifestSnapshotCommitter() {
        return manifestSnapshotCommitter;
      },
      operationProofSubstrate,
      workspaceAssetRegistry,
      workspaceGovernanceRegistry,
      readinessBaselineProvider,
      executiveReportProvider,
      sampleCapabilityPackStore,
      securityAlertStore,
      close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          contributionRegistries.clear();
          const failures = await closeOwnedResourcesInReverse(ownedResources);
          if (failures.length > 0) {
            throw new Error("Console operation providers did not shut down cleanly.");
          }
        })().catch((error) => {
          closePromise = null;
          throw error;
        });
        return closePromise;
      }
    });
  } catch (error) {
    contributionRegistries.clear();
    await closeOwnedResourcesInReverse(ownedResources);
    throw error;
  }
}

export function createServerConsoleDomainServices({
  userDataPath,
  createConsoleDomainServices,
  consoleOperationProviders,
  settingsPort
}) {
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
  const runtimeAgentConfigRegistry = () => getAgentConfigRegistry({
    rootPath: path.join(userDataPath, "agent-configs")
  });
  const loadAgentGatewayModule = () => import("#lico/agents/agent-gateway/index");
  const loadModelProbeModule = () => import("#lico/agents/agent-gateway/model-probe/index");
  const agentRuntimeProvider = createAgentRuntimeProvider({
    getAgentConfigRegistry: runtimeAgentConfigRegistry,
    loadAgentGatewayModule,
    loadModelProbeModule,
    loadRuntimeSettings: settingsPort.loadSettings
  });
  const uploadSessionStore = Object.freeze({
    appendUploadSessionChunk,
    buildCheckpointReceiptFromUploadSession,
    createOrResumeUploadSession,
    deleteUploadSession,
    getUploadSession,
    resolveUploadSessionFiles
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
  operationLockManager,
  operationConcurrencyScope,
  dataStructureSubstrate = null,
  runtimeLogger,
  securityPermissions,
  getJobWorkflowProvider = () => null,
  getOperationPermissionPlatform = () => null,
  controlledLocalDirectoryHostEnabled = false,
  activeFeatureIds = [],
  isFeatureActive,
  isAnyFeatureActive
}) {
  const ownedResources = [];
  try {
    const operationDispatcher = bindOperationDispatcher({
      lockManager: operationLockManager,
      concurrencyScope: operationConcurrencyScope
    });
    let strategyManagementProvider = null;
    const needsContextRuntime = isAnyFeatureActive(
      "context-runtime-core",
      "maintenance-agent-runbooks"
    );
    const needsAgentMemory = isFeatureActive("agent-memory") || needsContextRuntime;
    const agentMemory = await createProvider(
      needsAgentMemory,
      "#lico/agents/agent-memory/index",
      "createAgentMemory",
      [{ userDataPath }]
    );
    ownedResources.push(agentMemory);
    const callAgentGatewayIfAvailable = async (input = {}, options = {}) => {
      if (!isFeatureActive("agent-gateway")) {
        throw new Error("AgentGateway feature is not active in this feature edition.");
      }
      const { callAgentGateway } = await import("#lico/agents/agent-gateway/index");
      return callAgentGateway({
        ...options,
        input,
        userDataPath
      });
    };
    const contextRuntime = await createProvider(
      needsContextRuntime,
      "#lico/server-runtime/state/interface/index",
      "createContextRuntime",
      [{
        userDataPath,
        agentMemory,
        agentGatewayCall: async (input = {}) => callAgentGatewayIfAvailable(input, {
          settings: await loadSettings(userDataPath),
          contextCompactionSource: "context-runtime"
        })
      }]
    );
    ownedResources.push(contextRuntime);
    const maintenanceAgentEnabled = isFeatureActive("maintenance-agent-runbooks");
    const maintenanceOperationPermissionStore = maintenanceAgentEnabled
      ? createOperationPermissionStore({ userDataPath })
      : null;
    if (maintenanceOperationPermissionStore) {
      ownedResources.push(maintenanceOperationPermissionStore);
    }
    let maintenanceAgent = null;
    const maintenanceWorkQueue = await createProvider(
      maintenanceAgentEnabled,
      "#lico/server-runtime/composition/maintenance-work-queue-provider",
      "createMaintenanceWorkQueueProvider",
      maintenanceAgentEnabled
        ? [{
            queueApplicationPort,
            getMaintenanceAgent: () => maintenanceAgent,
            capabilitySelected: true,
            autoStart: false,
            consumerEnabled: process.env.LICO_MAINTENANCE_WORKER_EXTERNAL !== "1"
          }]
        : []
    );
    if (maintenanceWorkQueue) {
      ownedResources.push(maintenanceWorkQueue);
    }
    maintenanceAgent = await createProvider(
      maintenanceAgentEnabled,
      "#lico/agents/maintenance/index",
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
            operationConcurrencyScope,
            operationPermissionStore: maintenanceOperationPermissionStore,
            workQueuePort: maintenanceWorkQueue,
            schedulerEnabled: process.env.LICO_MAINTENANCE_WORKER_EXTERNAL !== "1",
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
    const agentWorkspace = await createProvider(
      isFeatureActive("agent-workspace-core"),
      "#lico/agents/agent-workspace/index",
      "createAgentWorkspace",
      [{
        userDataPath,
        merkleState: dataStructureSubstrate?.merkleStateSubstrate || null,
        checkpointTreeApi: dataStructureSubstrate?.checkpointTreeProjection || null,
        controlledLocalDirectoryHostEnabled
      }]
    );
    ownedResources.push(agentWorkspace);
    const needsStrategyManagement = isFeatureActive("strategy-management");
    strategyManagementProvider = await createProvider(
      needsStrategyManagement,
      "#lico/server-runtime/composition/strategy-management-provider",
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
  } catch (error) {
    await closeOwnedResourcesInReverse(ownedResources);
    throw error;
  }
}
