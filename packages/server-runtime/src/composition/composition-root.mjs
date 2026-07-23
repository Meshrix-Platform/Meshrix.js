import path from "node:path";
import {
  applyPluginDeploymentFeatures,
  publicFeatureRuntime,
  resolveFeatureRuntimeFromEnv
} from "./features/feature-manifest.mjs";
import { createProtocolEventBus } from "#lico/protocols/pubsub/event-bus";
import { createCorePlatformProvider } from "#lico/server-runtime/composition/core-platform-provider";
import { registerCorePlatformServices } from "#lico/server-runtime/composition/core-platform-register";
import { createDataStructureSubstrate } from "#lico/foundation/checkpoint/tree/data-structure-substrate";
import { registerDataStructureSubstratePlatformServices } from "#lico/foundation/checkpoint/tree/data-structure-substrate-register";
import { assertPactiumFreshDataDir } from "#lico/foundation/checkpoint/tree/pactium-substrate-preflight";
import { createOperationProofSubstrate } from "#lico/foundation/proof/proof-substrate/index";
import { registerOperationProofSubstratePlatformServices } from "#lico/foundation/proof/proof-substrate/register";
import { createConsoleAuth } from "#lico/foundation/security/auth/console-auth";
import { createOperationAuditStore } from "#lico/foundation/security/operation-audit";
import { createProcessIdentityService } from "#lico/foundation/security/process-identity/index";
import { registerSecurityPlatformServices } from "#lico/foundation/security/register";
import { createSecurityPermissionsProvider } from "#lico/foundation/security/security-permissions-provider";
import {
  createModuleManagementProvider,
  setModuleManagementSettingsDeps
} from "#lico/foundation/module-system/module-management-provider";
import { createServerRuntime } from "../module-runtime/server-runtime.mjs";
import { registerModuleManagementPlatformServices } from "#lico/foundation/module-system/register";
import { SERVER_API_OPERATIONS } from "#lico/operation-registry";
import {
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
} from "#lico/settings";
import { registerStoragePlatformServices } from "#lico/foundation/storage/register";
import { createStorageProvider } from "#lico/foundation/storage/storage-provider";
import { createDevopsProvider } from "#lico/server-runtime/composition/devops-provider";
import { registerDevopsPlatformServices } from "#lico/server-runtime/composition/devops-register";
import { createPlatformRegistry } from "./platform-registry.mjs";
import {
  createPluginLifecycleStatePort,
  discoverPluginLifecycleStateIds
} from "@lico/foundation/module-system/plugin-lifecycle-state-port";
import {
  createPluginContributionRegistry
} from "./plugin-contribution-registry.mjs";
import { registerStateMachineDefinitions } from "./register-state-machines.mjs";
import {
  loadPluginRegistry,
  normalizeEnabledPluginIds
} from "#lico/foundation/module-system/plugin-registry";
import { bindServerMcpNotificationBus } from "./mcp-notification-bus-binding.mjs";
import { createConfiguredSandboxExecution } from "./execution-sandbox-provider.mjs";
import { createLocalCustodyKeyBroker } from "../execution-sandbox/custody-key-broker.mjs";
import { createOpaqueSandboxCustodyRuntime } from "../execution-sandbox/opaque-custody.mjs";
import { createQueueApplicationPort } from "./queue-application-port.mjs";
import { createPluginProtectedRecoveryAuthority } from "./protected-recovery-port.mjs";
import { createPluginOwnerProcessIdentityAuthority } from "./plugin-owner-process-identity-authority.mjs";
import { createPluginControlledExecutionAuthority } from "./plugin-controlled-execution-authority.mjs";
import { createPluginDownstreamClientAspectAuthority } from "./plugin-downstream-client-aspect-authority.mjs";
import { createPluginOutboundEgressAuthority } from "./plugin-outbound-egress-authority.mjs";
import { createPluginInvocationAuthorizationAuthority } from "./plugin-invocation-authorization-authority.mjs";
import { createPluginArtifactAuthority } from "../../../foundation/src/module-system/plugin-artifact-authority.mjs";
import {
  normalizePluginArtifactTrustedPublicKeys,
  samePluginArtifactTrust
} from "../../../foundation/src/module-system/plugin-artifact-trust.mjs";
import { pluginArtifactCoreContractDigest } from "./plugin-artifact-core-contract.mjs";
import { createPersistentExternalGatewayManagementProvider } from "./external-gateway-management-provider.mjs";

async function refreshAgentConfigRegistryIfNeeded({ enabled, userDataPath }) {
  if (!enabled) {
    return null;
  }
  const { getAgentConfigRegistry } = await import("#lico/agents/agent-configs/config-registry");
  return getAgentConfigRegistry({ rootPath: path.join(userDataPath, "agent-configs") }).refresh();
}

export class ServerCompositionCloseError extends Error {
  constructor() {
    super("Server composition resources did not shut down cleanly.");
    this.name = "ServerCompositionCloseError";
  }
}

async function runResourceClosers(closers, { surfaceFailure }) {
  let failed = false;
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  if (failed && surfaceFailure) throw new ServerCompositionCloseError();
}

function createCompositionCloser(closers) {
  let remaining = [...closers].reverse();
  let closePromise = null;
  return () => {
    if (remaining.length === 0) return Promise.resolve();
    closePromise ||= (async () => {
      const failed = [];
      for (const close of remaining) {
        try {
          await close();
        } catch {
          failed.push(close);
        }
      }
      remaining = failed;
      if (failed.length > 0) throw new ServerCompositionCloseError();
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  };
}

export async function createServerCompositionRoot({
  userDataPath,
  runtimeOptions = {},
  runtimeLogger,
  operationLockManager: injectedOperationLockManager = null,
  operationConcurrencyScope: requestedOperationConcurrencyScope = "",
  registerPluginRuntimeMeasurementSource = null,
  pluginHostPorts = {}
}) {
  if (typeof requestedOperationConcurrencyScope !== "string") {
    throw new TypeError("operationConcurrencyScope must be a string when provided.");
  }
  bindServerMcpNotificationBus();
  const configuredArtifactTrust = normalizePluginArtifactTrustedPublicKeys(
    runtimeOptions.pluginArtifactTrustedPublicKeys === undefined ? {} : runtimeOptions.pluginArtifactTrustedPublicKeys
  );
  const injectedArtifactTrust = normalizePluginArtifactTrustedPublicKeys(
    pluginHostPorts.pluginArtifactTrustedPublicKeys === undefined ? {} : pluginHostPorts.pluginArtifactTrustedPublicKeys
  );
  if (Object.keys(configuredArtifactTrust).length > 0 && Object.keys(injectedArtifactTrust).length > 0 &&
      !samePluginArtifactTrust(configuredArtifactTrust, injectedArtifactTrust)) {
    throw new Error("Configured plugin artifact trust conflicts with the injected Host trust authority.");
  }
  if (pluginHostPorts.artifactAuthority && Object.keys(configuredArtifactTrust).length > 0) {
    throw new Error("Configured plugin artifact trust cannot be combined with an injected artifact authority.");
  }
  const effectiveArtifactTrust = Object.keys(injectedArtifactTrust).length > 0
    ? injectedArtifactTrust
    : configuredArtifactTrust;
  const artifactAuthority = pluginHostPorts.artifactAuthority || await createPluginArtifactAuthority({
    artifactRoot: path.join(userDataPath, "plugin-artifacts"),
    trustedPublicKeys: effectiveArtifactTrust,
    artifactSigner: pluginHostPorts.pluginArtifactPublisherSigner || null,
    secretRef: pluginHostPorts.pluginArtifactPublisherSecretRef || "",
    coreContractDigest: pluginArtifactCoreContractDigest()
  });
  const retiredPluginIds = new Set();
  const persistedLifecyclePluginIds = await discoverPluginLifecycleStateIds({ userDataPath });
  for (const id of [...new Set([
    ...persistedLifecyclePluginIds,
    ...normalizeEnabledPluginIds(runtimeOptions.enabledPlugins),
    ...Object.keys(runtimeOptions.pluginConfigurations || {})
  ])]) {
    const lifecycleStatePort = await createPluginLifecycleStatePort({ userDataPath, pluginId: id });
    const artifactPort = artifactAuthority.forPlugin({ pluginId: id, lifecycleStatePort });
    await artifactPort.recoverRemoval();
    const [ledger, removalJournal] = await Promise.all([
      lifecycleStatePort.readRecord("ledger"),
      lifecycleStatePort.readRecord("artifact-removal-journal")
    ]);
    if (ledger?.state === "removal_pending" && ledger.operation === "uninstall" &&
        removalJournal?.phase === "completed" && removalJournal.pluginId === id) {
      await lifecycleStatePort.runExclusive(() => lifecycleStatePort.writeRecord("ledger", { ...ledger, state: "uninstalled" }));
      retiredPluginIds.add(id);
    } else if (ledger?.state === "uninstalled") {
      retiredPluginIds.add(id);
    }
  }
  if (retiredPluginIds.size > 0) {
    runtimeOptions = {
      ...runtimeOptions,
      enabledPlugins: normalizeEnabledPluginIds(runtimeOptions.enabledPlugins).filter((id) => !retiredPluginIds.has(id)),
      pluginConfigurations: Object.fromEntries(Object.entries(runtimeOptions.pluginConfigurations || {})
        .filter(([id]) => !retiredPluginIds.has(id)))
    };
  }
  const pluginCatalog = await loadPluginRegistry({
    artifactAuthority
  });
  const pluginConfigurations = runtimeOptions.pluginConfigurations ?? {};
  if (!pluginConfigurations || typeof pluginConfigurations !== "object" || Array.isArray(pluginConfigurations)) {
    throw new TypeError("runtime.pluginConfigurations must be an object when provided.");
  }
  const pluginInvocationAuthorizationAuthority = pluginHostPorts.pluginInvocationAuthorizationAuthority ||
    createPluginInvocationAuthorizationAuthority();
  const pluginOwnerProcessIdentityAuthority = pluginHostPorts.pluginOwnerProcessIdentityAuthority ||
    createPluginOwnerProcessIdentityAuthority({ invocationAuthorizationAuthority: pluginInvocationAuthorizationAuthority });
  const pluginControlledExecutionAuthority = pluginHostPorts.pluginControlledExecutionAuthority ||
    createPluginControlledExecutionAuthority({
      userDataPath,
      invocationAuthorizationAuthority: pluginInvocationAuthorizationAuthority
    });
  const pluginProtectedRecoveryAuthority = pluginHostPorts.pluginProtectedRecoveryAuthority ||
    createPluginProtectedRecoveryAuthority({ userDataPath });
  const pluginDownstreamClientAspectAuthority = pluginHostPorts.pluginDownstreamClientAspectAuthority ||
    createPluginDownstreamClientAspectAuthority();
  const pluginOutboundEgressAuthority = pluginHostPorts.pluginOutboundEgressAuthority ||
    createPluginOutboundEgressAuthority();
  const effectivePluginHostPorts = {
    ...pluginHostPorts,
    artifactAuthority,
    pluginInvocationAuthorizationAuthority,
    pluginOwnerProcessIdentityAuthority,
    pluginControlledExecutionAuthority,
    pluginProtectedRecoveryAuthority,
    pluginDownstreamClientAspectAuthority,
    pluginOutboundEgressAuthority
  };
  const pluginDeployment = pluginCatalog.resolveDeployment({
    enabledPluginIds: normalizeEnabledPluginIds(runtimeOptions.enabledPlugins),
    configuredPluginIds: Object.keys(pluginConfigurations),
    deploymentProfileId: runtimeOptions.deploymentProfileId
  });
  const lifecycleEffectivePlugins = [];
  const lifecycleEffectivePluginIds = new Set();
  for (const plugin of pluginDeployment.loadedPlugins) {
    const lifecycleStatePort = await createPluginLifecycleStatePort({ userDataPath, pluginId: plugin.id });
    const [ledger, artifactSnapshot] = await Promise.all([
      lifecycleStatePort.readRecord("ledger"),
      artifactAuthority.forPlugin({ pluginId: plugin.id, lifecycleStatePort }).loadSnapshot()
    ]);
    if (!ledger || !artifactSnapshot || ledger.pluginId !== plugin.id ||
        !Number.isSafeInteger(ledger.generation) || ledger.generation !== artifactSnapshot.generation) {
      throw new Error(`Plugin ${plugin.id} production lifecycle authority does not match its installed artifact.`);
    }
    const state = String(ledger.state);
    if (!new Set(["active", "removal_pending", "inactive", "uninstalled"]).has(state)) {
      throw new Error(`Plugin ${plugin.id} lifecycle ledger is invalid.`);
    }
    if (state === "active" && plugin.dependencies.every((dependencyId) => lifecycleEffectivePluginIds.has(dependencyId))) {
      lifecycleEffectivePlugins.push(plugin);
      lifecycleEffectivePluginIds.add(plugin.id);
    }
  }
  const lifecycleEffectiveDeployment = Object.freeze({
    ...pluginDeployment,
    loadedPlugins: Object.freeze(lifecycleEffectivePlugins)
  });
  const featureRuntime = applyPluginDeploymentFeatures(
    await resolveFeatureRuntimeFromEnv({ runtimeOptions }),
    lifecycleEffectiveDeployment
  );
  const platformRegistry = createPlatformRegistry({
    scope: path.resolve(userDataPath)
  });
  const activeFeatureIds = new Set(featureRuntime.activeFeatureIds);
  const pluginFeatureIds = new Map(pluginDeployment.loadedPlugins.map((plugin) => [
    plugin.id,
    Object.freeze([...new Set([plugin.id, ...(plugin.features || [])])])
  ]));
  const currentActiveFeatures = () => (featureRuntime.activeFeatures || [])
    .filter((feature) => activeFeatureIds.has(feature.featureId));
  const currentDisabledFeatures = () => [
    ...(featureRuntime.disabledFeatures || []).filter((feature) => !activeFeatureIds.has(feature.featureId)),
    ...(featureRuntime.activeFeatures || []).filter((feature) => !activeFeatureIds.has(feature.featureId))
  ];
  const lifecycleFeatureRuntime = Object.freeze({
    ...featureRuntime,
    get activeFeatureIds() { return Object.freeze([...activeFeatureIds]); },
    get disabledFeatureIds() {
      return Object.freeze([...new Set([
        ...(featureRuntime.activeFeatureIds || []),
        ...(featureRuntime.disabledFeatureIds || [])
      ])].filter((id) => !activeFeatureIds.has(id)));
    },
    get activeFeatures() { return Object.freeze(currentActiveFeatures()); },
    get disabledFeatures() { return Object.freeze(currentDisabledFeatures()); }
  });
  const runtimeOptionsWithFeatures = {
    ...runtimeOptions,
    featureRuntime: lifecycleFeatureRuntime,
    edition: featureRuntime.edition
  };
  const isFeatureActive = (featureId) =>
    activeFeatureIds.has(featureId);
  const isAnyFeatureActive = (...featureIds) =>
    featureIds.some((featureId) => isFeatureActive(featureId));

  assertPactiumFreshDataDir({ userDataPath });
  let runtime;
  try {
    runtime = await createServerRuntime({
    userDataPath,
    runtimeOptions: runtimeOptionsWithFeatures,
    pluginDeployment,
    operationLockManager: injectedOperationLockManager,
    registerPluginRuntimeMeasurementSource,
      pluginHostPorts: effectivePluginHostPorts
    });
  } catch (error) {
    if (!pluginHostPorts.pluginProtectedRecoveryAuthority) await pluginProtectedRecoveryAuthority.close();
    throw error;
  }
  const resourceClosers = [
    () => runtime.close(),
    ...(!pluginHostPorts.pluginInvocationAuthorizationAuthority ? [() => pluginInvocationAuthorizationAuthority.close()] : []),
    ...(!pluginHostPorts.pluginProtectedRecoveryAuthority ? [() => pluginProtectedRecoveryAuthority.close()] : [])
  ];
  try {
  const pluginContributions = createPluginContributionRegistry({
    manifests: pluginCatalog.listPlugins(),
    loadedPlugins: lifecycleEffectiveDeployment.loadedPlugins,
    contributions: runtime.createExecutionView().contributions,
    coreOperations: SERVER_API_OPERATIONS,
    activeFeatureIds
  });
  let consoleAuthRef = null;
  const unregisterPluginLifecycleListener = runtime.onPluginLifecycleTransition({
    prepare({ pluginId }) {
      const contributionChange = pluginContributions.preparePluginDeactivation(pluginId);
      const platformChange = platformRegistry.prepareUnregisterOwner(pluginId);
      const previousFeatureIds = [...activeFeatureIds];
      return Object.freeze({
        commit() {
          contributionChange.commit();
          platformChange.commit();
          for (const featureId of pluginFeatureIds.get(pluginId) || [pluginId]) activeFeatureIds.delete(featureId);
          consoleAuthRef?.refreshActiveFeatureIds([...activeFeatureIds]);
        },
        rollback() {
          contributionChange.rollback();
          platformChange.rollback();
          activeFeatureIds.clear();
          for (const featureId of previousFeatureIds) activeFeatureIds.add(featureId);
          consoleAuthRef?.refreshActiveFeatureIds(previousFeatureIds);
        }
      });
    }
  });
  resourceClosers.push(() => unregisterPluginLifecycleListener());
  const activeApiOperations = pluginContributions.activeOperations;
  const getActiveApiOperations = () => pluginContributions.currentActiveOperations();
  let sandboxExecution = null;
  const publicFeatures = () => {
    const { enabledPlugins: effectivePlugins, ...pluginRuntime } = pluginContributions.publicRuntime();
    return Object.freeze({
      ...publicFeatureRuntime(lifecycleFeatureRuntime, getActiveApiOperations()),
      plugins: Object.freeze({
        ...pluginRuntime,
        loadedPlugins: Object.freeze(pluginDeployment.loadedPlugins.map((plugin) => Object.freeze({
          id: plugin.id,
          version: plugin.version,
          features: Object.freeze([...(plugin.features || [])])
        }))),
        effectivePlugins
      }),
      ...(sandboxExecution?.publicAvailability?.() || { sandboxAvailable: false })
    });
  };
  // Register security providers (tag store adapter) before creating console auth,
  // so the authorization governance store can resolve the tag store provider
  // from the singleton registry at construction time.
  const { registerSecurityProviders } = await import("./register-security-providers.mjs");
  const registeredSecurityProvider = await registerSecurityProviders({ userDataPath });
  resourceClosers.push(() => registeredSecurityProvider?.close?.());
  const consoleAuth = createConsoleAuth({
    userDataPath,
    activeFeatureIds: [...activeFeatureIds],
    featureScopeGrants: Object.fromEntries(Object.entries(pluginConfigurations)
      .flatMap(([pluginId, configuration]) => Object.entries(configuration?.consoleRoleScopeGrants || {})
        .map(([featureId, grants]) => [featureId || pluginId, grants])))
  });
  consoleAuthRef = consoleAuth;
  resourceClosers.push(() => consoleAuth.close());
  const processIdentity = createProcessIdentityService({ dataDir: userDataPath });
  pluginOwnerProcessIdentityAuthority.bind(processIdentity);
  resourceClosers.push(() => processIdentity.close());
  if (!pluginHostPorts.pluginOwnerProcessIdentityAuthority) {
    resourceClosers.push(() => pluginOwnerProcessIdentityAuthority.close());
  }
  const securityPermissions = createSecurityPermissionsProvider({ consoleAuth, processIdentity });
  const externalGatewayManagement = await createPersistentExternalGatewayManagementProvider({ userDataPath });
  setModuleManagementSettingsDeps({ loadSettings, saveSettings });
  const moduleManagement = createModuleManagementProvider({
    runtime,
    userDataPath,
    activeFeatureIds
  });
  const dataStructureSubstrate = createDataStructureSubstrate({ userDataPath });
  resourceClosers.push(() => dataStructureSubstrate.close());
  const operationProofSubstrate = createOperationProofSubstrate({
    userDataPath,
    pactiumRuntime: dataStructureSubstrate.pactiumRuntime,
    runtimeOptions: runtimeOptionsWithFeatures
  });
  resourceClosers.push(() => operationProofSubstrate.close());
  const operationAuditStore = createOperationAuditStore({ userDataPath });
  resourceClosers.push(() => operationAuditStore.close());
  const operationLockManager = runtime.operationLockManager;
  const operationConcurrencyScope =
    requestedOperationConcurrencyScope.trim() ||
    String(operationLockManager?.namespace || "").trim() ||
    "server";
  const protocolEventBus = createProtocolEventBus({ userDataPath, logger: runtimeLogger });
  resourceClosers.push(() => protocolEventBus.close());
  const queueApplicationPort = await createQueueApplicationPort({
    userDataPath,
    logger: runtimeLogger
  });
  resourceClosers.push(() => queueApplicationPort.close());
  const coreProvider = createCorePlatformProvider({
    operations: activeApiOperations,
    getOperations: getActiveApiOperations,
    protocolEventBus,
    runtimeLogger,
    featureRuntime: lifecycleFeatureRuntime,
    operationLockManager,
    operationConcurrencyScope,
    operationProofSubstrate
  });
  const storageProvider = createStorageProvider({
    userDataPath,
    storageKernel: runtime.storageKernel,
    artifactClassifiers: dataStructureSubstrate.storageArtifactClassifiers
  });
  const custodyKeyBroker = createLocalCustodyKeyBroker({ userDataPath });
  resourceClosers.push(() => custodyKeyBroker.close());
  const opaqueCustodyRuntime = createOpaqueSandboxCustodyRuntime({
    userDataPath,
    storageKernel: runtime.storageKernel,
    storageProvider,
    keyBroker: custodyKeyBroker
  });
  const opaqueArtifactCustody = opaqueCustodyRuntime.custody;
  const persistedSettings = await loadSettings(userDataPath);
  sandboxExecution = await createConfiguredSandboxExecution({
    userDataPath,
    settings: persistedSettings.executionSandbox,
    opaqueArtifactCustody: opaqueCustodyRuntime.promotionAuthority,
    queueApplicationPort,
    audit: (entry) => operationAuditStore.append({
      operationId: "execution_sandbox.lifecycle",
      transport: "runtime",
      actor: { type: "system" },
      risk: "controlled_execution",
      readOnly: false,
      status: entry.status,
      input: entry
    })
  });
  pluginControlledExecutionAuthority.bind(sandboxExecution);
  if (!pluginHostPorts.pluginControlledExecutionAuthority) {
    resourceClosers.push(() => pluginControlledExecutionAuthority.close());
  }
  resourceClosers.push(() => sandboxExecution.close());
  const devopsProvider = createDevopsProvider({ userDataPath });

  registerCorePlatformServices(platformRegistry, {
    protocolEventBus,
    runtimeLogger,
    featureRuntime: lifecycleFeatureRuntime,
    operationLockManager,
    operationConcurrencyScope,
    operationProofSubstrate,
    sandboxExecution,
    opaqueArtifactCustody,
    coreProvider
  });
  registerSecurityPlatformServices(platformRegistry, {
    securityPermissions,
    consoleAuth,
    operationAuditStore,
    processIdentity
  });
  registerModuleManagementPlatformServices(platformRegistry, {
    moduleManagement,
    runtime,
    runtimeOptions: runtimeOptionsWithFeatures
  });
  registerDataStructureSubstratePlatformServices(platformRegistry, { dataStructureSubstrate });
  registerOperationProofSubstratePlatformServices(platformRegistry, { operationProofSubstrate });
  registerDevopsPlatformServices(platformRegistry, { userDataPath, devopsProvider });
  registerStoragePlatformServices(platformRegistry, {
    storageProvider,
    storageKernel: runtime.storageKernel,
    userDataPath
  });
  registerStateMachineDefinitions(platformRegistry, {
    integrityRegistryPath: path.resolve(
      String(runtimeOptions.cwd || process.cwd()),
      "tools/registry/state-machines/state-machine-integrity.registry.json"
    )
  });
  pluginContributions.registerStateMachines(platformRegistry);
  await refreshAgentConfigRegistryIfNeeded({
    enabled: isAnyFeatureActive("agent-gateway", "agent-management"),
    userDataPath
  });

  const close = createCompositionCloser(resourceClosers);

  return Object.freeze({
    userDataPath,
    runtimeOptions: runtimeOptionsWithFeatures,
    featureRuntime: lifecycleFeatureRuntime,
    allApiOperationCount: SERVER_API_OPERATIONS.length,
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
    operationProofSubstrate,
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
    registeredSecurityProvider,
    storageProvider,
    storageKernel: runtime.storageKernel,
    clientRegistryService: runtime.clientRegistryService,
    devopsProvider,
    loadSettings,
    saveSettings,
    normalizeSettings,
    getSettingsPath,
    close
  });
  } catch (error) {
    await runResourceClosers(resourceClosers, { surfaceFailure: false });
    throw error;
  }
}

export async function ensureConsoleOwner({ consoleAuth }) {
  return consoleAuth.ensureInitialOwner();
}
