import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { createJobsController } from "#meshrix/protocols/http/controllers/jobs-controller";
import { createSystemController } from "#meshrix/protocols/http/controllers/system-controller";
import { requirePlatformInterface } from "./platform-registry.ts";
import { createBatchDeletionCoordinator } from "../jobs/batch-deletion-coordinator.ts";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.ts";
import { createWorkQueueObservationProjection } from "./queue-observation-projection.ts";
import { createJobManager } from "../jobs/jobs/job-manager.ts";
import { assertBoundUploadSessionStore } from "../state/upload-session-store.ts";
import { createServerCompositionRoot, ensureConsoleOwner } from "./composition-root.ts";
import {
  loadDiscoveryConfig,
  resolveDiscoveryState,
  saveDiscoveryConfig
} from "./discovery-config.ts";
import { loadOrCreateMcpIdentity } from "./mcp-identity-provider.ts";
import {
  createPluginContributionController
} from "./plugin-contribution-controller.ts";
import { createPluginWorkspaceAccess } from "./plugin-workspace-access.ts";
import { createQueuedJobWorkflowProvider } from "./queued-job-workflow-provider.ts";
import {
  createServerConsoleDomainServices,
  createServerConsoleOperationProviders,
  createServerOperationPermissionPlatform,
  createServerToolSkillManagementProvider
} from "./server-runtime-providers.ts";

const API_KEY_AUDIENCE_MAX_RISK: Readonly<Record<string, string>> = Object.freeze({
  low: "read_only",
  medium: "safe_write",
  high: "repair_write"
});

function apiKeyAudienceEvaluationInput(authorization: any): any {
  const policy: any = authorization?.policy || {};
  const resources: any = policy.resources || {};
  const subjectId: any = String(authorization?.workloadPrincipalId || "");
  if (authorization?.credentialKind !== "scoped_api_key" || !authorization?.keyId ||
      !authorization?.policyFingerprint || !subjectId || !authorization?.organizationNodeId) {
    throw Object.assign(new Error("API Key authorization context is unavailable."), {
      code: "api_key_authority_unavailable",
      statusCode: 503
    });
  }
  const restriction: any = Object.freeze({
    credentialKind: "scoped_api_key",
    credentialId: String(authorization.keyId),
    policyFingerprint: String(authorization.policyFingerprint),
    toolsets: Object.freeze([...(policy.toolsetIds || [])]),
    scopes: Object.freeze([...(policy.scopeIds || [])]),
    capabilities: Object.freeze([...(policy.capabilityIds || [])]),
    dynamicCapabilities: Object.freeze([...(policy.capabilityIds || [])]),
    maxRisk: API_KEY_AUDIENCE_MAX_RISK[String(policy.maximumRisk || "")] || "read_only",
    allowedServiceIds: Object.freeze([...(policy.serviceIds || [])]),
    allowedSecretBindings: Object.freeze([...(resources.secretBindingIds || [])])
  });
  return Object.freeze({
    restriction,
    subject: Object.freeze({
      type: "scoped-api-key",
      subjectId,
      organizationNodeId: String(authorization.organizationNodeId),
      scopes: restriction.scopes,
      capabilities: restriction.capabilities,
      maxRisk: restriction.maxRisk
    })
  });
}

function writeInitialOwnerCredentials({ userDataPath, initialOwner, runtimeLogger }: Record<string, any>) : any {
  if (!initialOwner.created) return "";
  const credentialsPath: any = path.join(userDataPath, "auth", "initial-credentials.txt");
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const content: any = [
    "Meshrix.js Console Initial Credentials",
    "=====================================",
    `Username : ${initialOwner.username}`,
    `Password : ${initialOwner.password}`,
    "",
    "This file is created only once. After your first successful login it will be",
    "automatically deleted. Keep it confidential; it will not be shown again.",
    "Change/reset: npm run server:auth -- set-password --username owner --generate-password",
    "",
    `Generated : ${new Date().toISOString()}`
  ].join("\n");
  fs.writeFileSync(credentialsPath, content, { mode: 0o600 });
  runtimeLogger.warn("server.initialOwner.credentials_file", {
    created: true,
    storageClass: "private-runtime-data",
    message: "Initial owner credentials have been written to a secured file."
  });
  console.log("初始 owner 已创建；凭据仅写入受保护的运行时数据目录。此信息不再输出到标准输出。");
  return credentialsPath;
}

export function createHttpApplicationAssemblyCloser({
  getJobWorkflowProvider,
  jobManager,
  ownsJobManager,
  uploadWorkspaceMaterializationProvider,
  maintenanceAgent,
  agentWorkspace,
  integrationTaskSupervisor,
  consoleOperationProviders,
  unregisterPluginListeners = () : any => {},
  operationPermissionPlatform,
  compositionRoot
}: Record<string, any>) : any {
  let closePromise: any = null;
  return function close() : any {
    if (closePromise) return closePromise;
    closePromise = (async () : Promise<any> => {
      const ownerFailures: any[] = [];
      const closeOwner: any = async (closeOwnerResource?: any) : Promise<any> => {
        try {
          await closeOwnerResource();
        } catch {
          ownerFailures.push(true);
        }
      };
      // The Core-owned supervisor has an internal hard deadline and absorbs
      // adapter close failures. A third-party integration may never veto Core
      // dependency shutdown.
      await integrationTaskSupervisor?.shutdown?.().catch(() : any => {});
      const jobWorkflowProvider: any = getJobWorkflowProvider();
      if (jobWorkflowProvider !== jobManager && typeof jobWorkflowProvider?.close === "function") {
        await closeOwner(() : any => jobWorkflowProvider.close());
      }
      if (ownsJobManager) await closeOwner(() : any => jobManager.close());
      if (typeof uploadWorkspaceMaterializationProvider?.close === "function") {
        await closeOwner(() : any => uploadWorkspaceMaterializationProvider.close());
      }
      if (typeof maintenanceAgent?.close === "function") {
        await closeOwner(() : any => maintenanceAgent.close());
      }
      if (typeof agentWorkspace?.close === "function") {
        await closeOwner(() : any => agentWorkspace.close());
      }
      await closeOwner(() : any => unregisterPluginListeners());
      await closeOwner(() : any => consoleOperationProviders.close());
      await closeOwner(() : any => operationPermissionPlatform.close());
      if (ownerFailures.length > 0) {
        const error: Error & Record<string, any> = new Error("Server task owners did not shut down cleanly.");
        error.code = "http_shutdown_dependencies";
        throw error;
      }
      try {
        await compositionRoot.close();
      } catch {
        const error: Error & Record<string, any> = new Error("Server composition did not shut down cleanly.");
        error.code = "http_shutdown_resources";
        throw error;
      }
    })().catch((error?: any) : any => {
      closePromise = null;
      throw error;
    });
    return closePromise;
  };
}

export function registerPluginOwnerGrantLifecycle({
  runtime,
  pluginContributions,
  operationPermissionPlatform
}: Record<string, any> = {}) : any {
  for (const plugin of runtime.plugins.loadedPlugins) {
    const generationDigest: any = runtime.getPluginArtifactGenerationDigest(plugin.id);
    if (!generationDigest) throw new Error("Plugin grant owner artifact generation is unavailable.");
    operationPermissionPlatform.registerPluginGrantOwner({ pluginId: plugin.id, generationDigest });
  }
  return runtime.onPluginLifecycleTransition({
    prepare({ pluginId, operation, idempotencyKey, artifactGenerationDigest }: Record<string, any>) : any {
      if (!/^[a-f0-9]{64}$/u.test(String(artifactGenerationDigest || ""))) {
        throw new Error("Plugin lifecycle grant owner generation is unavailable.");
      }
      const previousOperations: any = pluginContributions.currentActiveOperations();
      const ownerRevocationKey: any = `plugin-lifecycle:${createHash("sha256")
        .update(JSON.stringify([pluginId, artifactGenerationDigest, operation, idempotencyKey]))
        .digest("hex")}`;
      return Object.freeze({
        commit() : any {
          operationPermissionPlatform.refreshOperations(pluginContributions.currentActiveOperations());
        },
        rollback() : any {
          operationPermissionPlatform.refreshOperations(previousOperations);
        },
        async commitIrreversible() : Promise<any> {
          let cursor: any = "";
          const observedCursors: any = new Set<any>();
          while (true) {
            const receipt: any = await operationPermissionPlatform.revokeGrantsByPluginOwner({
              pluginId,
              generationDigest: artifactGenerationDigest,
              idempotencyKey: ownerRevocationKey,
              cursor,
              batchSize: 256
            });
            if (receipt?.ok !== true || typeof receipt.complete !== "boolean" ||
                typeof receipt.cursor !== "string" || receipt.cursor.length > 256) {
              throw new Error("Plugin-owner grant revocation returned an invalid receipt.");
            }
            if (receipt.complete) return;
            if (!receipt.cursor || observedCursors.has(receipt.cursor)) {
              throw new Error("Plugin-owner grant revocation did not make progress.");
            }
            observedCursors.add(receipt.cursor);
            cursor = receipt.cursor;
          }
        }
      });
    }
  });
}

export function registerPluginContributionLifecycle({
  runtime,
  pluginContributions,
  platformRegistry,
  operationPermissionPlatform
}: Record<string, any> = {}) : any {
  return runtime.onPluginContributionChange(async ({ pluginId, contributions }: Record<string, any>) : Promise<any> => {
    const change: any = pluginContributions.preparePluginContributionReplacement(pluginId, contributions);
    try {
      change.commit();
      pluginContributions.refreshStateMachines(platformRegistry, pluginId);
      operationPermissionPlatform.refreshOperations(pluginContributions.currentActiveOperations());
    } catch (error: any) {
      pluginContributions.deactivatePlugin(pluginId);
      platformRegistry.unregisterOwner(pluginId);
      operationPermissionPlatform.refreshOperations(pluginContributions.currentActiveOperations());
      throw error;
    }
  });
}

export async function createHttpApplicationAssembly({
  userDataPath,
  distPath,
  incomingJobManager = null,
  runtimeOptions = {},
  operationLockManager: injectedOperationLockManager = null,
  operationConcurrencyScope: requestedOperationConcurrencyScope = "",
  registerPluginRuntimeMeasurementSource = null,
  pluginHostPorts = {},
  serverWorkspaceRoot,
  serverLabel = "",
  runtimeLogger,
  createConsoleDomainServices,
  proxyApiRequest,
  registerStartupCleanup = () : any => {}
}: Record<string, any>) : Promise<any> {
  const compositionRoot: any = await createServerCompositionRoot({
    userDataPath,
    runtimeOptions,
    runtimeLogger,
    operationLockManager: injectedOperationLockManager,
    operationConcurrencyScope: requestedOperationConcurrencyScope,
    registerPluginRuntimeMeasurementSource,
    pluginHostPorts
  });
  registerStartupCleanup({ close: () : any => compositionRoot.close() });
  const mcpIdentity: any = await loadOrCreateMcpIdentity(userDataPath);
  const {
    featureRuntime,
    allApiOperationCount,
    activeApiOperations,
    getActiveApiOperations,
    pluginContributions,
    publicFeatures,
    isFeatureActive,
    isAnyFeatureActive,
    platformRegistry,
    coreProvider,
    runtime,
    moduleManagement,
    externalGatewayManagement,
    dataStructureSubstrate,
    consoleAuth,
    securityPermissions,
    deferredProtectedSinkAuthorityPort,
    sandboxExecution,
    opaqueArtifactCustody,
    uploadNoRunCustody,
    uploadSessionStore,
    processIdentity,
    pluginInvocationAuthorizationAuthority,
    operationAuditStore,
    operationLockManager,
    operationConcurrencyScope,
    protocolEventBus,
    queueApplicationPort,
    storageProvider,
    clientRegistryService,
    devopsProvider,
    integrationTaskSupervisor,
    loadSettings,
    saveSettings,
    normalizeSettings,
    getSettingsPath
  } = compositionRoot;
  if (incomingJobManager) {
    try {
      assertBoundUploadSessionStore(
        incomingJobManager.uploadSessionStore,
        { userDataPath }
      );
      if (incomingJobManager.storageProvider !== storageProvider) {
        const error: Error & Record<string, any> = new TypeError(
          "Injected job manager requires this composition root's storage provider."
        );
        error.code = "upload_session_storage_provider_unavailable";
        throw error;
      }
    } catch (error: any) {
      await compositionRoot.close().catch(() : any => {});
      throw error;
    }
  }
  runtimeLogger.info("features.resolved", {
    edition: featureRuntime.edition,
    activeFeatureCount: featureRuntime.activeFeatureIds.length,
    disabledFeatureCount: featureRuntime.disabledFeatureIds.length,
    activeOperationCount: getActiveApiOperations().length,
    disabledOperationCount: allApiOperationCount - getActiveApiOperations().length
  });

  const initialOwner: any = await ensureConsoleOwner({ consoleAuth });
  const initialCredentialsPath: any = writeInitialOwnerCredentials({
    userDataPath,
    initialOwner,
    runtimeLogger
  });
  const jobManager: any = incomingJobManager || createJobManager({
    userDataPath,
    runtimeOptions: runtime.runtimeOptions,
    getRuntimeOptions: () : any => runtime.runtimeOptions,
    protocolEventBus,
    storageProvider,
    uploadSessionStore,
    logger: runtimeLogger
  });
  const ownsJobManager: any = !incomingJobManager;
  if (ownsJobManager) {
    registerStartupCleanup({
      close: () : any => jobManager.close(),
      blocksDependencyShutdown: true
    });
  }

  const registeredCoreProvider: any = requirePlatformInterface(platformRegistry, "core.provider").value || coreProvider;
  const registeredStorageProvider: any = requirePlatformInterface(platformRegistry, "storage.provider").value || storageProvider;
  const registeredDevopsProvider: any = requirePlatformInterface(platformRegistry, "devops.provider").value || devopsProvider;
  const registeredOperationProofSubstrate: any =
    requirePlatformInterface(platformRegistry, "operation-proof-substrate.provider")?.value ||
    compositionRoot.operationProofSubstrate ||
    null;
  let agentWorkspaceRef: any = null;
  const consoleOperationProviders: any = await createServerConsoleOperationProviders({
    userDataPath,
    securityPermissions,
    operationProofSubstrate: registeredOperationProofSubstrate,
    storageProvider: registeredStorageProvider,
    uploadSessionStore,
    uploadCustodyReadPort: uploadNoRunCustody.readPort,
    operationAuditStore,
    getListenUrl: () : any => listenUrl,
    getAgentWorkspace: () : any => agentWorkspaceRef
  });
  registerStartupCleanup({ close: () : any => consoleOperationProviders.close() });
  const settingsPort: Readonly<Record<string, any>> = Object.freeze({
    loadSettings,
    saveSettings,
    normalizeSettings,
    getSettingsPath
  });
  const discoveryPort: Readonly<Record<string, any>> = Object.freeze({
    saveDiscoveryConfig
  });
  const consoleDomainServices: any = createServerConsoleDomainServices({
    userDataPath,
    createConsoleDomainServices,
    consoleOperationProviders,
    settingsPort,
    uploadSessionStore
  });
  let jobWorkflowProvider: any = null;
  registerStartupCleanup({
    close: () : any => jobWorkflowProvider !== jobManager && typeof jobWorkflowProvider?.close === "function"
      ? jobWorkflowProvider.close()
      : undefined,
    blocksDependencyShutdown: true
  });
  const workQueueObservation: any = createWorkQueueObservationProjection({
    getJobWorkflowProvider: () : any => jobWorkflowProvider
  });
  let discoveryState: any = await loadDiscoveryConfig(userDataPath);
  let listenUrl: any = "";
  let controllersRef: any = null;
  let operationPermissionPlatformRef: any = null;
  let toolSkillManagementProviderRef: any = null;
  const runtimeProviders: any = await compositionRoot.createBoundRuntimeProviders({
    userDataPath,
    runtime,
    jobManager,
    protocolEventBus,
    queueApplicationPort,
    getDiscoveryState: () : any => discoveryState,
    getListenUrl: () : any => listenUrl,
    getControllers: () : any => controllersRef,
    operationAuditStore,
    operationProofSubstrate: registeredOperationProofSubstrate,
    operationLockManager,
    operationConcurrencyScope,
    dataStructureSubstrate,
    runtimeLogger,
    securityPermissions,
    getJobWorkflowProvider: () : any => jobWorkflowProvider,
    getOperationPermissionPlatform: () : any => operationPermissionPlatformRef,
    getToolSkillManagementProvider: () : any => toolSkillManagementProviderRef,
    controlledLocalDirectoryHostEnabled: [...pluginContributions.operations.values()].some((record?: any) : any =>
      (record?.implementation?.hostPathInputPreprocessing || [])
        .some((declaration?: any) : any => declaration.kind === "local-directory-selection")),
    activeFeatureIds: featureRuntime.activeFeatureIds,
    isFeatureActive,
    isAnyFeatureActive
  });
  const {
    contextRuntime,
    maintenanceAgent,
    agentWorkspace,
    strategyManagementProvider,
    modelDecisionRuntime
  } = runtimeProviders;
  agentWorkspaceRef = agentWorkspace;
  registerStartupCleanup({
    close: async () : Promise<any> => {
      await maintenanceAgent?.close?.();
      await agentWorkspace?.close?.();
    },
    blocksDependencyShutdown: true
  });
  jobWorkflowProvider = await createQueuedJobWorkflowProvider({
    jobManager,
    queueApplicationPort,
    autoStart: process.env.MESHRIX_IMPORT_WORKER_EXTERNAL !== "1",
    consumerEnabled: process.env.MESHRIX_IMPORT_WORKER_EXTERNAL !== "1",
    logger: runtimeLogger
  });
  const deletionCoordinator: any = createBatchDeletionCoordinator({
    userDataPath,
    jobManager: jobWorkflowProvider,
    storageProvider: registeredStorageProvider
  });
  const uploadWorkspaceMaterializationProvider: any =
    await compositionRoot.createBoundUploadWorkspaceMaterializationProvider({
      userDataPath,
      queueApplicationPort,
      uploadSessionStore: consoleDomainServices.uploadSessionStore,
      uploadCustodyReadPort: uploadNoRunCustody.readPort,
      deferredProtectedSinkAuthorityPort,
      resolveOperation(operationId?: any) : any {
        return getActiveApiOperations().find(
          (operation?: any) : any => operation.id === operationId
        ) || null;
      },
      operationAuditStore,
      operationProofSubstrate: registeredOperationProofSubstrate
    });
  registerStartupCleanup({ close: () : any => uploadWorkspaceMaterializationProvider.close() });
  queueApplicationPort.start();

  const jobsController: any = createJobsController({
    userDataPath,
    jobWorkflowProvider,
    storageProvider: registeredStorageProvider,
    deletionCoordinator,
    getDiscoveryState: () : any => discoveryState,
    proxyApiRequest,
    protocolEventBus,
    loadNormalizedDocumentStore: consoleDomainServices.loadNormalizedDocumentStore,
    uploadSessionStore: consoleDomainServices.uploadSessionStore,
    uploadWorkspaceMaterializationProvider,
    resolveArchiveBatchIdentity
  });
  const systemController: any = createSystemController({
    userDataPath,
    distPath,
    runtime,
    moduleManagement,
    externalGatewayManagement,
    jobWorkflowProvider,
    storageProvider: registeredStorageProvider,
    clientRegistryService,
    serverLabel,
    getDiscoveryState: () : any => discoveryState,
    setDiscoveryState: (value?: any) : any => {
      discoveryState = value;
    },
    getListenUrl: () : any => listenUrl,
    coreProvider: registeredCoreProvider,
    getControllers: () : any => controllersRef,
    getFeatureEntries: publicFeatures,
    isFeatureActive,
    protocolEventBus,
    consoleAuth,
    securityPermissions,
    processIdentity,
    operationAuditStore,
    maintenanceAgent,
    agentWorkspace,
    contextRuntime,
    modelDecisionRuntime,
    strategyManagementProvider,
    workQueueObservation,
    checkpointTreeApi: dataStructureSubstrate.checkpointTreeProjection,
    operationProofSubstrate: registeredOperationProofSubstrate,
    devopsProvider: registeredDevopsProvider,
    settingsPort,
    discoveryPort,
    getIntegrationTaskSupervisorSnapshot: () : any => integrationTaskSupervisor.snapshot(),
    getOperationPermissionPlatform: () : any => operationPermissionPlatformRef,
    getToolSkillManagementProvider: () : any => toolSkillManagementProviderRef,
    consoleDomainServices,
    workspaceRoot: serverWorkspaceRoot
  });
  const controllers: Record<string, any> = { jobs: jobsController, system: systemController };
  controllersRef = controllers;
  const operationPermissionPlatform: any = createServerOperationPermissionPlatform({
    userDataPath,
    operations: getActiveApiOperations(),
    featureRuntime: publicFeatures(),
    controllers,
    operationAuditStore,
    operationLockManager,
    operationConcurrencyScope,
    protocolEventBus,
    consoleAuth,
    securityPermissions,
    proofSubstrate: registeredOperationProofSubstrate,
    logger: runtimeLogger
  });
  operationPermissionPlatformRef = operationPermissionPlatform;
  await consoleOperationProviders.bindUpstreamManifestSnapshotCommit({
    getBaseOperations: getActiveApiOperations,
    getOperationPermissionPlatform: () : any => operationPermissionPlatformRef,
    protocolEventBus
  });
  const pluginLifecycleUnsubscribers: any[] = [];
  let pluginListenersRegistered: any = true;
  const unregisterPluginListeners: any = () : any => {
    if (!pluginListenersRegistered) return;
    pluginListenersRegistered = false;
    let firstError: any = null;
    for (const unsubscribe of [...pluginLifecycleUnsubscribers].reverse()) {
      try {
        unsubscribe();
      } catch (error: any) {
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  };
  registerStartupCleanup({
    close: async () : Promise<any> => {
      try {
        unregisterPluginListeners();
      } finally {
        await operationPermissionPlatform.close();
      }
    },
    blocksDependencyShutdown: true
  });
  pluginLifecycleUnsubscribers.push(registerPluginOwnerGrantLifecycle({
    runtime,
    pluginContributions,
    operationPermissionPlatform
  }));
  pluginLifecycleUnsubscribers.push(registerPluginContributionLifecycle({
    runtime,
    pluginContributions,
    platformRegistry,
    operationPermissionPlatform
  }));
  const toolSkillManagementProvider: any = createServerToolSkillManagementProvider({
    operationPermissionPlatform,
    userDataPath,
    securityPermissions,
    evaluateToolAudience: (input?: any) : any => {
      const apiKeyAuthorization: any = input?.apiKeyAuthorization ||
        (input?.authorization?.credentialKind === "scoped_api_key"
          ? input.authorization.apiKeyAuthorization
          : null);
      if (!apiKeyAuthorization) {
        return consoleOperationProviders.upstreamGatewayRegistry.evaluateProjectedOperationAudience(input);
      }
      const evaluation: any = apiKeyAudienceEvaluationInput(apiKeyAuthorization);
      return consoleOperationProviders.upstreamGatewayRegistry.evaluateProjectedOperationAudience({
        ...input,
        grant: null,
        restriction: evaluation.restriction,
        subject: evaluation.subject
      });
    },
    resolveAudiencePartitionKeys: (grantId?: any) : any =>
      consoleOperationProviders.getUpstreamManifestSnapshotCommitter()
        ?.getAudiencePartitionKeysForGrant(grantId) || [],
    resolveAudienceCatalogFacts: (grantId?: any) : any =>
      consoleOperationProviders.getUpstreamManifestSnapshotCommitter()
        ?.getAudienceCatalogFactsForGrant(grantId) || null,
    logger: runtimeLogger
  });
  toolSkillManagementProviderRef = toolSkillManagementProvider;
  controllers.plugin = createPluginContributionController({
    registry: pluginContributions,
    invocationAuthorizationAuthority: pluginInvocationAuthorizationAuthority,
    hostPorts: {
      workspaceAccess: createPluginWorkspaceAccess({ workspaceRoot: serverWorkspaceRoot }),
      securityPermissions,
      securityAlertStore: consoleOperationProviders.securityAlertStore,
      processIdentity,
      operationPermissionPlatform,
      operationPermissionGrant: operationPermissionPlatform,
      externalService: consoleOperationProviders.upstreamGatewayRegistry,
      delegatedMcpGrantBroker: toolSkillManagementProvider,
      agentWorkspace,
      sandboxExecution,
      opaqueArtifactCustody
    }
  });

  async function activateListeningEndpoint({ resolvedListenUrl, discoveryOptions = {} }: Record<string, any>) : Promise<any> {
    listenUrl = resolvedListenUrl;
    discoveryState = await resolveDiscoveryState(userDataPath, {
      listenUrl,
      serverLabel,
      serverId: mcpIdentity.keyId,
      overrides: discoveryOptions
    });
    discoveryState = { ...discoveryState, mcpIdentity };
    await saveDiscoveryConfig(userDataPath, discoveryState, {
      listenUrl,
      serverLabel,
      serverId: mcpIdentity.keyId
    });
    return discoveryState;
  }

  function createRequestHandler({
    handlerFactory,
    ingressContract,
    lifecycle,
    loginRateLimiter,
    rateLimits,
    subjectRateLimiter,
    tenantRateLimiter,
    ipRateLimiter
  }: Record<string, any>) : any {
    if (typeof handlerFactory !== "function") {
      throw new TypeError("HTTP application assembly requires a request handler factory.");
    }
    return handlerFactory({
      activeApiOperations,
      getActiveApiOperations,
      consoleAuth,
      controllers,
      distPath,
      getDiscoveryState: () : any => discoveryState,
      getListenUrl: () : any => listenUrl,
      getOperationPermissionPlatform: () : any => operationPermissionPlatformRef,
      ingressContract,
      lifecycle,
      loginRateLimiter,
      operationAuditStore,
      operationConcurrencyScope,
      pluginContributions,
      proxyApiRequest,
      rateLimits,
      registeredCoreProvider,
      runtimeLogger,
      securityPermissions,
      subjectRateLimiter,
      tenantRateLimiter,
      toolSkillManagementProvider,
      upstreamGatewayRegistryForMcp: consoleOperationProviders.upstreamGatewayRegistry,
      ipRateLimiter
    });
  }

  function startupLifecycleContext() : any {
    return {
      controllers,
      registeredCoreProvider,
      runtimeLogger,
      protocolEventBus,
      discoveryState,
      listenUrl,
      isFeatureActive,
      exposedMaintenanceAgent: maintenanceAgent,
      deletionCoordinator,
      featureRuntime
    };
  }

  function startOptionalIntegrations() : any {
    try {
      return integrationTaskSupervisor?.start?.({ coreReady: true }) || null;
    } catch {
      runtimeLogger.warn("integration.supervisor.start_rejected", {
        code: "integration_supervisor_start_rejected"
      });
      return null;
    }
  }

  const close: any = createHttpApplicationAssemblyCloser({
    getJobWorkflowProvider: () : any => jobWorkflowProvider,
    jobManager,
    ownsJobManager,
    uploadWorkspaceMaterializationProvider,
    maintenanceAgent,
    agentWorkspace,
    integrationTaskSupervisor,
    consoleOperationProviders,
    unregisterPluginListeners,
    operationPermissionPlatform,
    compositionRoot
  });

  return Object.freeze({
    activeApiOperations,
    compositionRoot,
    consoleAuth,
    consoleOperationProviders,
    controllers,
    deletionCoordinator,
    featureRuntime,
    getDiscoveryState: () : any => discoveryState,
    getListenUrl: () : any => listenUrl,
    initialOwner,
    initialCredentialsPath,
    isFeatureActive,
    jobManager,
    jobWorkflowProvider,
    maintenanceAgent,
    agentWorkspace,
    operationAuditStore,
    operationConcurrencyScope,
    operationPermissionPlatform,
    ownsJobManager,
    protocolEventBus,
    registeredCoreProvider,
    integrationTaskSupervisor,
    securityAlertStore: consoleOperationProviders.securityAlertStore,
    securityPermissions,
    toolSkillManagementProvider,
    upstreamGatewayRegistryForMcp: consoleOperationProviders.upstreamGatewayRegistry,
    activateListeningEndpoint,
    close,
    createRequestHandler,
    startOptionalIntegrations,
    startupLifecycleContext
  });
}
