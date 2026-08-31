import path from "node:path";

import { createUpstreamConfigFileLoader } from "./upstream-config-file.ts";
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
import { broadcastAudienceCatalogInvalidation } from "#meshrix/protocols/mcp/adapter/http-mcp-adapter";
import { broadcastConfiguredMcpNotification } from "#meshrix/protocols/mcp/adapter/mcp-notification-bus";
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

export async function createServerOperationPermissionPlatform({
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
}: Record<string, any>) : Promise<any> {
  const operationDispatcher: any = bindOperationDispatcher({
    lockManager: operationLockManager,
    concurrencyScope: operationConcurrencyScope
  });
  return await createOperationPermissionPlatform({
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
  tagStore = securityPermissions?.tagManagementStore || null,
  secretKeyProvider = null
}: Record<string, any>) : any {
  return createUpstreamGatewayRegistry({
    userDataPath,
    securityPermissions,
    artifactTransitPort,
    tagStore,
    secretKeyProvider,
    publishSkillHubUpdate(event?: any) : any {
      return broadcastConfiguredMcpNotification({
        jsonrpc: "2.0",
        method: "notifications/meshrix/skill_hub/catalog_changed",
        params: event
      }, {
        includePrivate: true,
        coalesceKey: "skill-hub.catalog.changed"
      });
    }
  });
}

export async function createServerConsoleOperationProviders({
  userDataPath,
  securityPermissions,
  operationProofSubstrate,
  storageProvider,
  uploadSessionStore,
  uploadCustodyReadPort,
  operationAuditStore,
  getListenUrl = () : any => "",
  getAgentWorkspace = () : any => null,
  secretKeyProvider = null
}: Record<string, any>) : Promise<any> {
  let contributionRegistry: any = null;
  const ownedResources: any[] = [];
  try {
    if (typeof uploadSessionStore?.resolveUploadSessionFiles !== "function") {
      throw new TypeError("Server operation providers require the bound upload session store.");
    }
    const artifactTransitPort: any = await createArtifactTransitProvider({
      userDataPath,
      uploadSessionStore,
      uploadCustodyReadPort,
      workspaceFileStore: createWorkspaceArtifactFileStore({ getAgentWorkspace }),
      getListenUrl
    });
    ownedResources.push(artifactTransitPort);
    const upstreamGatewayRegistry: any = createServerUpstreamGatewayRegistry({
      userDataPath,
      securityPermissions,
      artifactTransitPort,
      tagStore: securityPermissions?.tagManagementStore || null,
      secretKeyProvider
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
      async onError(event?: any) : Promise<any> {
        try {
          await operationAuditStore?.append?.({
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
    const upstreamConfigFileLoader: any = createUpstreamConfigFileLoader({
      userDataPath,
      publishingApplication: upstreamPublishingApplication,
      localSecretKeyProvider: secretKeyProvider,
      onError: (error?: any) : any => {
        if (error) {
          console.error(`[upstream-config] ${error?.message || error}`);
        }
      }
    });
    ownedResources.push(upstreamConfigFileLoader);
    await upstreamConfigFileLoader.start();
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
      getContributionRegistry() : any {
        if (!contributionRegistry) {
          contributionRegistry = createContributionRegistry({
            userDataPath,
            excludedContributionTypes: ["skill"],
            lifecycleDefinition: CORE_WORKSPACE_CONTRIBUTION_LIFECYCLE_DEFINITION
          });
          ownedResources.push(contributionRegistry);
        }
        return contributionRegistry;
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
          getGrants: async () : Promise<any> => {
            const platform: any = getOperationPermissionPlatform?.();
            const [grants, apiKeyGrants]: any[] = await Promise.all([
              typeof platform?.store?.listGrants === "function"
                ? platform.store.listGrants({ includeRevoked: false })
                : [],
              typeof platform?.apiKeyDistributionProvider?.listAudienceGrants === "function"
                ? platform.apiKeyDistributionProvider.listAudienceGrants()
                : []
            ]);
            return [...(grants || []), ...(apiKeyGrants || [])];
          },
          getTagStore: () : any => securityPermissions?.tagManagementStore || null,
          getPolicyRevision: () : any => Number(securityPermissions?.getGovernancePolicyRevision?.()?.revision || 0) || 0,
          getTagRevision: () : any => Number(securityPermissions?.tagManagementStore?.getPolicyRevision?.()?.revision || 0) || 0,
          protocolEventBus,
          onAudiencePublished({ projection, previousProjection }: Record<string, any>) : any {
            return broadcastAudienceCatalogInvalidation({
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
          const currentFacts: any = manifestSnapshotCommitter?.getPublicationFacts?.() || null;
          const affectedPartitions: readonly any[] = Object.freeze(
            [...new Set<any>((Array.isArray(result?.affectedPartitions) ? result.affectedPartitions : [])
              .map((value?: any) : any => String(value || "").trim())
              .filter(Boolean))].sort()
          );
          const publicationFacts: Readonly<Record<string, any>> | null = currentFacts && result
            ? Object.freeze({
                sourceRevision: currentFacts.sourceRevision,
                catalogRevision: currentFacts.catalogRevision,
                audienceRevision: result.audienceRevision,
                affectedPartitions
              })
            : null;
          if (result?.emitted === true && (
            !Number.isSafeInteger(publicationFacts?.sourceRevision) ||
            !String(publicationFacts?.catalogRevision || "").trim() ||
            !Number.isSafeInteger(publicationFacts?.audienceRevision)
          )) {
            const error: Error & Record<string, any> = new Error(
              "Published upstream audience facts were incomplete."
            );
            error.code = "upstream_audience_publication_facts_invalid";
            throw error;
          }
          if ([
            "grant_token_rotated",
            "grant_revoked",
            "grant_deleted",
            "api_key_rotate",
            "api_key_revoke"
          ].includes(event?.reasonCode)) {
            disconnectMcpSseConnectionsByGrant(event.grantId);
          }
          return Object.freeze({
            ...(result || {}),
            publicationFacts
          });
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
          contributionRegistry = null;
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
    contributionRegistry = null;
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
  return createConsoleDomainServices({
    userDataPath,
    uploadSessionStore,
    consoleOperationProviders,
    settingsPort
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
    const needsContextRuntime: any = isFeatureActive("context-runtime-core");
    const needsAgentMemory: any = isFeatureActive("agent-memory") || needsContextRuntime;
    const agentMemory: any = await createProvider(
      needsAgentMemory,
      "#meshrix/agents/agent-memory/index",
      "createAgentMemory",
      [{ userDataPath }]
    );
    ownedResources.push(agentMemory);
    const contextRuntime: any = await createProvider(
      needsContextRuntime,
      "#meshrix/server-runtime/state/interface/index",
      "createContextRuntime",
      [{
        userDataPath,
        agentMemory
      }]
    );
    ownedResources.push(contextRuntime);
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
      agentWorkspace,
      strategyManagementProvider,
      modelDecisionRuntime: null
    });
  } catch (error: any) {
    await closeOwnedResourcesInReverse(ownedResources);
    throw error;
  }
}
