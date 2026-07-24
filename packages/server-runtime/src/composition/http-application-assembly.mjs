import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { createJobsController } from "#meshrix/protocols/http/controllers/jobs-controller";
import { createUploadWorkspaceMaterializationProvider } from "./upload-workspace-materialization-provider.mjs";
import { createSystemController } from "#meshrix/protocols/http/controllers/system-controller";
import { requirePlatformInterface } from "./platform-registry.mjs";
import { createBatchDeletionCoordinator } from "../jobs/batch-deletion-coordinator.mjs";
import { resolveArchiveBatchIdentity } from "../jobs/archive-batch-id.mjs";
import { createWorkQueueObservationProjection } from "./queue-observation-projection.mjs";
import { createJobManager } from "../jobs/jobs/job-manager.mjs";
import { createServerCompositionRoot, ensureConsoleOwner } from "./composition-root.mjs";
import {
  loadDiscoveryConfig,
  resolveDiscoveryState,
  saveDiscoveryConfig
} from "./discovery-config.mjs";
import { loadOrCreateMcpIdentity } from "./mcp-identity-provider.mjs";
import {
  createPluginContributionController
} from "./plugin-contribution-controller.mjs";
import { createPluginWorkspaceAccess } from "./plugin-workspace-access.mjs";
import { createQueuedJobWorkflowProvider } from "./queued-job-workflow-provider.mjs";
import {
  createServerConsoleDomainServices,
  createServerConsoleOperationProviders,
  createServerOperationPermissionPlatform,
  createServerRuntimeProviders,
  createServerToolSkillManagementProvider
} from "./server-runtime-providers.mjs";

function writeInitialOwnerCredentials({ userDataPath, initialOwner, runtimeLogger }) {
  if (!initialOwner.created) return "";
  const credentialsPath = path.join(userDataPath, "auth", "initial-credentials.txt");
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  const content = [
    "Meshrix Console Initial Credentials",
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
    credentialsPath,
    message: "Initial owner credentials have been written to a secured file."
  });
  console.log("初始 owner 已创建，请参考日志中的初始化文件路径与重置命令。此信息不再输出到标准输出。");
  return credentialsPath;
}

export function createHttpApplicationAssemblyCloser({
  getJobWorkflowProvider,
  jobManager,
  ownsJobManager,
  uploadWorkspaceMaterializationProvider,
  maintenanceAgent,
  agentWorkspace,
  consoleOperationProviders,
  unregisterPluginListeners = () => {},
  operationPermissionPlatform,
  compositionRoot
}) {
  let closePromise = null;
  return function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const ownerFailures = [];
      const closeOwner = async (closeOwnerResource) => {
        try {
          await closeOwnerResource();
        } catch {
          ownerFailures.push(true);
        }
      };
      const jobWorkflowProvider = getJobWorkflowProvider();
      if (jobWorkflowProvider !== jobManager && typeof jobWorkflowProvider?.close === "function") {
        await closeOwner(() => jobWorkflowProvider.close());
      }
      if (ownsJobManager) await closeOwner(() => jobManager.close());
      if (typeof uploadWorkspaceMaterializationProvider?.close === "function") {
        await closeOwner(() => uploadWorkspaceMaterializationProvider.close());
      }
      if (typeof maintenanceAgent?.close === "function") {
        await closeOwner(() => maintenanceAgent.close());
      }
      if (typeof agentWorkspace?.close === "function") {
        await closeOwner(() => agentWorkspace.close());
      }
      await closeOwner(() => unregisterPluginListeners());
      await closeOwner(() => consoleOperationProviders.close());
      await closeOwner(() => operationPermissionPlatform.close());
      if (ownerFailures.length > 0) {
        const error = new Error("Server task owners did not shut down cleanly.");
        error.code = "http_shutdown_dependencies";
        throw error;
      }
      try {
        await compositionRoot.close();
      } catch {
        const error = new Error("Server composition did not shut down cleanly.");
        error.code = "http_shutdown_resources";
        throw error;
      }
    })().catch((error) => {
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
} = {}) {
  for (const plugin of runtime.plugins.loadedPlugins) {
    const generationDigest = runtime.getPluginArtifactGenerationDigest(plugin.id);
    if (!generationDigest) throw new Error("Plugin grant owner artifact generation is unavailable.");
    operationPermissionPlatform.registerPluginGrantOwner({ pluginId: plugin.id, generationDigest });
  }
  return runtime.onPluginLifecycleTransition({
    prepare({ pluginId, operation, idempotencyKey, artifactGenerationDigest }) {
      if (!/^[a-f0-9]{64}$/u.test(String(artifactGenerationDigest || ""))) {
        throw new Error("Plugin lifecycle grant owner generation is unavailable.");
      }
      const previousOperations = pluginContributions.currentActiveOperations();
      const ownerRevocationKey = `plugin-lifecycle:${createHash("sha256")
        .update(JSON.stringify([pluginId, artifactGenerationDigest, operation, idempotencyKey]))
        .digest("hex")}`;
      return Object.freeze({
        commit() {
          operationPermissionPlatform.refreshOperations(pluginContributions.currentActiveOperations());
        },
        rollback() {
          operationPermissionPlatform.refreshOperations(previousOperations);
        },
        async commitIrreversible() {
          let cursor = "";
          const observedCursors = new Set();
          while (true) {
            const receipt = await operationPermissionPlatform.revokeGrantsByPluginOwner({
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
} = {}) {
  return runtime.onPluginContributionChange(async ({ pluginId, contributions }) => {
    const change = pluginContributions.preparePluginContributionReplacement(pluginId, contributions);
    try {
      change.commit();
      pluginContributions.refreshStateMachines(platformRegistry, pluginId);
      operationPermissionPlatform.refreshOperations(pluginContributions.currentActiveOperations());
    } catch (error) {
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
  registerStartupCleanup = () => {}
}) {
  const compositionRoot = await createServerCompositionRoot({
    userDataPath,
    runtimeOptions,
    runtimeLogger,
    operationLockManager: injectedOperationLockManager,
    operationConcurrencyScope: requestedOperationConcurrencyScope,
    registerPluginRuntimeMeasurementSource,
    pluginHostPorts
  });
  registerStartupCleanup({ close: () => compositionRoot.close() });
  const mcpIdentity = await loadOrCreateMcpIdentity(userDataPath);
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
    sandboxExecution,
    opaqueArtifactCustody,
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
    loadSettings,
    saveSettings,
    normalizeSettings,
    getSettingsPath
  } = compositionRoot;
  runtimeLogger.info("features.resolved", {
    edition: featureRuntime.edition,
    activeFeatureCount: featureRuntime.activeFeatureIds.length,
    disabledFeatureCount: featureRuntime.disabledFeatureIds.length,
    activeOperationCount: getActiveApiOperations().length,
    disabledOperationCount: allApiOperationCount - getActiveApiOperations().length
  });

  const initialOwner = await ensureConsoleOwner({ consoleAuth });
  const initialCredentialsPath = writeInitialOwnerCredentials({
    userDataPath,
    initialOwner,
    runtimeLogger
  });
  const jobManager = incomingJobManager || createJobManager({
    userDataPath,
    runtimeOptions: runtime.runtimeOptions,
    getRuntimeOptions: () => runtime.runtimeOptions,
    protocolEventBus,
    logger: runtimeLogger
  });
  const ownsJobManager = !incomingJobManager;
  if (ownsJobManager) {
    registerStartupCleanup({
      close: () => jobManager.close(),
      blocksDependencyShutdown: true
    });
  }

  const registeredCoreProvider = requirePlatformInterface(platformRegistry, "core.provider").value || coreProvider;
  const registeredStorageProvider = requirePlatformInterface(platformRegistry, "storage.provider").value || storageProvider;
  const registeredDevopsProvider = requirePlatformInterface(platformRegistry, "devops.provider").value || devopsProvider;
  const registeredOperationProofSubstrate =
    requirePlatformInterface(platformRegistry, "operation-proof-substrate.provider")?.value ||
    compositionRoot.operationProofSubstrate ||
    null;
  const consoleOperationProviders = await createServerConsoleOperationProviders({
    userDataPath,
    securityPermissions,
    operationProofSubstrate: registeredOperationProofSubstrate,
    storageProvider: registeredStorageProvider,
    operationAuditStore,
    getListenUrl: () => listenUrl
  });
  registerStartupCleanup({ close: () => consoleOperationProviders.close() });
  const settingsPort = Object.freeze({
    loadSettings,
    saveSettings,
    normalizeSettings,
    getSettingsPath
  });
  const discoveryPort = Object.freeze({
    saveDiscoveryConfig
  });
  const consoleDomainServices = createServerConsoleDomainServices({
    userDataPath,
    createConsoleDomainServices,
    consoleOperationProviders,
    settingsPort
  });
  let jobWorkflowProvider = null;
  registerStartupCleanup({
    close: () => jobWorkflowProvider !== jobManager && typeof jobWorkflowProvider?.close === "function"
      ? jobWorkflowProvider.close()
      : undefined,
    blocksDependencyShutdown: true
  });
  const workQueueObservation = createWorkQueueObservationProjection({
    getJobWorkflowProvider: () => jobWorkflowProvider
  });
  let discoveryState = await loadDiscoveryConfig(userDataPath);
  let listenUrl = "";
  let controllersRef = null;
  let operationPermissionPlatformRef = null;
  let toolSkillManagementProviderRef = null;
  const runtimeProviders = await createServerRuntimeProviders({
    userDataPath,
    runtime,
    jobManager,
    protocolEventBus,
    queueApplicationPort,
    getDiscoveryState: () => discoveryState,
    getListenUrl: () => listenUrl,
    getControllers: () => controllersRef,
    operationAuditStore,
    operationLockManager,
    operationConcurrencyScope,
    dataStructureSubstrate,
    runtimeLogger,
    securityPermissions,
    getJobWorkflowProvider: () => jobWorkflowProvider,
    getOperationPermissionPlatform: () => operationPermissionPlatformRef,
    getToolSkillManagementProvider: () => toolSkillManagementProviderRef,
    controlledLocalDirectoryHostEnabled: [...pluginContributions.operations.values()].some((record) =>
      (record?.implementation?.hostPathInputPreprocessing || [])
        .some((declaration) => declaration.kind === "local-directory-selection")),
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
  registerStartupCleanup({
    close: async () => {
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
  const deletionCoordinator = createBatchDeletionCoordinator({
    userDataPath,
    jobManager: jobWorkflowProvider,
    storageProvider: registeredStorageProvider
  });
  const uploadWorkspaceMaterializationProvider = await createUploadWorkspaceMaterializationProvider({
    userDataPath,
    queueApplicationPort,
    agentWorkspace,
    uploadSessionStore: consoleDomainServices.uploadSessionStore,
    operationAuditStore,
    operationProofSubstrate: registeredOperationProofSubstrate
  });
  registerStartupCleanup({ close: () => uploadWorkspaceMaterializationProvider.close() });
  queueApplicationPort.start();

  const jobsController = createJobsController({
    userDataPath,
    jobWorkflowProvider,
    storageProvider: registeredStorageProvider,
    deletionCoordinator,
    getDiscoveryState: () => discoveryState,
    proxyApiRequest,
    protocolEventBus,
    loadNormalizedDocumentStore: consoleDomainServices.loadNormalizedDocumentStore,
    uploadSessionStore: consoleDomainServices.uploadSessionStore,
    uploadWorkspaceMaterializationProvider,
    resolveArchiveBatchIdentity
  });
  const systemController = createSystemController({
    userDataPath,
    distPath,
    runtime,
    moduleManagement,
    externalGatewayManagement,
    jobWorkflowProvider,
    storageProvider: registeredStorageProvider,
    clientRegistryService,
    serverLabel,
    getDiscoveryState: () => discoveryState,
    setDiscoveryState: (value) => {
      discoveryState = value;
    },
    getListenUrl: () => listenUrl,
    coreProvider: registeredCoreProvider,
    getControllers: () => controllersRef,
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
    getOperationPermissionPlatform: () => operationPermissionPlatformRef,
    getToolSkillManagementProvider: () => toolSkillManagementProviderRef,
    consoleDomainServices,
    workspaceRoot: serverWorkspaceRoot
  });
  const controllers = { jobs: jobsController, system: systemController };
  controllersRef = controllers;
  const operationPermissionPlatform = createServerOperationPermissionPlatform({
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
    getOperationPermissionPlatform: () => operationPermissionPlatformRef,
    protocolEventBus
  });
  const pluginLifecycleUnsubscribers = [];
  let pluginListenersRegistered = true;
  const unregisterPluginListeners = () => {
    if (!pluginListenersRegistered) return;
    pluginListenersRegistered = false;
    let firstError = null;
    for (const unsubscribe of [...pluginLifecycleUnsubscribers].reverse()) {
      try {
        unsubscribe();
      } catch (error) {
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  };
  registerStartupCleanup({
    close: async () => {
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
  const toolSkillManagementProvider = createServerToolSkillManagementProvider({
    operationPermissionPlatform,
    userDataPath,
    securityPermissions,
    evaluateToolAudience: (input) =>
      consoleOperationProviders.upstreamGatewayRegistry.evaluateProjectedOperationAudience(input),
    resolveAudiencePartitionKeys: (grantId) =>
      consoleOperationProviders.getUpstreamManifestSnapshotCommitter()
        ?.getAudiencePartitionKeysForGrant(grantId) || [],
    resolveAudienceCatalogFacts: (grantId) =>
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

  async function activateListeningEndpoint({ resolvedListenUrl, discoveryOptions = {} }) {
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
    lifecycle,
    loginRateLimiter,
    rateLimits,
    subjectRateLimiter,
    tenantRateLimiter,
    ipRateLimiter
  }) {
    if (typeof handlerFactory !== "function") {
      throw new TypeError("HTTP application assembly requires a request handler factory.");
    }
    return handlerFactory({
      activeApiOperations,
      getActiveApiOperations,
      consoleAuth,
      controllers,
      distPath,
      getDiscoveryState: () => discoveryState,
      getListenUrl: () => listenUrl,
      getOperationPermissionPlatform: () => operationPermissionPlatformRef,
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

  function startupLifecycleContext() {
    return {
      activeApiOperations,
      controllers,
      registeredCoreProvider,
      operationAuditStore,
      operationConcurrencyScope,
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

  const close = createHttpApplicationAssemblyCloser({
    getJobWorkflowProvider: () => jobWorkflowProvider,
    jobManager,
    ownsJobManager,
    uploadWorkspaceMaterializationProvider,
    maintenanceAgent,
    agentWorkspace,
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
    getDiscoveryState: () => discoveryState,
    getListenUrl: () => listenUrl,
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
    securityAlertStore: consoleOperationProviders.securityAlertStore,
    securityPermissions,
    toolSkillManagementProvider,
    upstreamGatewayRegistryForMcp: consoleOperationProviders.upstreamGatewayRegistry,
    activateListeningEndpoint,
    close,
    createRequestHandler,
    startupLifecycleContext
  });
}
