import path from "node:path";
import {
  applyPluginDeploymentFeatures,
  publicFeatureRuntime,
  resolveFeatureRuntimeFromEnv
} from "./features/feature-manifest.ts";
import { createProtocolEventRuntime } from "#meshrix/server-runtime/events/protocol-event-runtime";
import { createProtocolEventBus } from "#meshrix/protocols/pubsub/event-bus";
import { createCorePlatformProvider } from "#meshrix/server-runtime/composition/core-platform-provider";
import { registerCorePlatformServices } from "#meshrix/server-runtime/composition/core-platform-register";
import { createDataStructureSubstrate } from "#meshrix/foundation/checkpoint/tree/data-structure-substrate";
import { registerDataStructureSubstratePlatformServices } from "#meshrix/foundation/checkpoint/tree/data-structure-substrate-register";
import { assertMeshrixPactiumDataDir } from "#meshrix/foundation/checkpoint/tree/pactium-runtime";
import { createOperationProofSubstrate } from "#meshrix/foundation/proof/proof-substrate/index";
import { registerOperationProofSubstratePlatformServices } from "#meshrix/foundation/proof/proof-substrate/register";
import { CONSOLE_ROLES, createConsoleAuth } from "#meshrix/foundation/security/auth/console-auth";
import { createOrganizationGovernanceService } from "@meshrix/foundation/security/authorization/organization-model";
import { createOperationAuditStore } from "#meshrix/foundation/security/operation-audit";
import { createProcessIdentityService } from "#meshrix/foundation/security/process-identity/index";
import { registerSecurityPlatformServices } from "#meshrix/foundation/security/register";
import { createSecurityPermissionsProvider } from "#meshrix/foundation/security/security-permissions-provider";
import {
  createModuleManagementProvider,
  setModuleManagementSettingsDeps
} from "#meshrix/foundation/module-system/module-management-provider";
import { createServerRuntime } from "../module-runtime/server-runtime.ts";
import { registerModuleManagementPlatformServices } from "#meshrix/foundation/module-system/register";
import { SERVER_API_OPERATIONS } from "#meshrix/operation-registry";
import {
  getSettingsPath,
  loadSettings,
  normalizeSettings,
  saveSettings
} from "#meshrix/settings";
import { registerStoragePlatformServices } from "#meshrix/foundation/storage/register";
import { createStorageProvider } from "#meshrix/foundation/storage/storage-provider";
import { createDevopsProvider } from "#meshrix/server-runtime/composition/devops-provider";
import { registerDevopsPlatformServices } from "#meshrix/server-runtime/composition/devops-register";
import { createPlatformRegistry } from "./platform-registry.ts";
import {
  createPluginLifecycleStatePort,
  discoverPluginLifecycleStateIds
} from "@meshrix/foundation/module-system/plugin-lifecycle-state-port";
import {
  createPluginContributionRegistry
} from "./plugin-contribution-registry.ts";
import {
  createBuiltInGatewayChannel,
  createGatewayChannelRouter
} from "./gateway-channel-router.ts";
import { registerStateMachineDefinitions } from "./register-state-machines.ts";
import {
  loadPluginRegistry,
  normalizeEnabledPluginIds
} from "#meshrix/foundation/module-system/plugin-registry";
import { bindServerMcpNotificationBus } from "./mcp-notification-bus-binding.ts";
import { createConfiguredSandboxExecution } from "./execution-sandbox-provider.ts";
import { createLocalCustodyKeyBroker } from "../execution-sandbox/custody-key-broker.ts";
import { createOpaqueSandboxCustodyRuntime } from "../execution-sandbox/opaque-custody.ts";
import { createUploadNoRunCustody } from "../jobs/upload-no-run-custody.ts";
import { createUploadSessionStore } from "../state/upload-session-store.ts";
import { createQueueApplicationPort } from "./queue-application-port.ts";
import { createPluginProtectedRecoveryAuthority } from "./protected-recovery-port.ts";
import { createPluginOwnerProcessIdentityAuthority } from "./plugin-owner-process-identity-authority.ts";
import { createPluginControlledExecutionAuthority } from "./plugin-controlled-execution-authority.ts";
import { createPluginDownstreamClientAspectAuthority } from "./plugin-downstream-client-aspect-authority.ts";
import { createPluginOutboundEgressAuthority } from "./plugin-outbound-egress-authority.ts";
import { createPluginInvocationAuthorizationAuthority } from "./plugin-invocation-authorization-authority.ts";
import { createPluginArtifactAuthority } from "#meshrix/foundation/module-system/plugin-artifact-authority";
import {
  normalizePluginArtifactTrustedPublicKeys,
  samePluginArtifactTrust
} from "#meshrix/foundation/module-system/plugin-artifact-trust";
import { pluginArtifactCoreContractDigest } from "./plugin-artifact-core-contract.ts";
import { createIntegrationTaskSupervisor } from "./integration-task-supervisor.ts";
import {
  claimAgentWorkspaceMaterializationRootPort,
  createAgentWorkspaceMaterializationRootAuthority
} from "#meshrix/agents/agent-workspace/agent-workspace-materialization-brand";

export class ServerCompositionCloseError extends Error {
  name: any;
  constructor() {
    super("Server composition resources did not shut down cleanly.");
    this.name = "ServerCompositionCloseError";
  }
}

async function runResourceClosers(closers: any, { surfaceFailure }: Record<string, any>) : Promise<any> {
  let failed: any = false;
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  if (failed && surfaceFailure) throw new ServerCompositionCloseError();
}

function createCompositionCloser(closers?: any) : any {
  let remaining: any = [...closers].reverse();
  let closePromise: any = null;
  return () : any => {
    if (remaining.length === 0) return Promise.resolve();
    closePromise ||= (async () : Promise<any> => {
      const failed: any[] = [];
      for (const close of remaining) {
        try {
          await close();
        } catch {
          failed.push(close);
        }
      }
      remaining = failed;
      if (failed.length > 0) throw new ServerCompositionCloseError();
    })().finally(() : any => {
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
}: Record<string, any>) : Promise<any> {
  if (typeof requestedOperationConcurrencyScope !== "string") {
    throw new TypeError("operationConcurrencyScope must be a string when provided.");
  }
  const workspaceMaterializationRootAuthority: any =
    createAgentWorkspaceMaterializationRootAuthority();
  let workspaceMaterializationPort: any = null;
  let runtimeProviderCompositionState: any = "available";
  let uploadMaterializationProviderCompositionState: any = "available";
  bindServerMcpNotificationBus();
  const configuredArtifactTrust: any = normalizePluginArtifactTrustedPublicKeys(
    runtimeOptions.pluginArtifactTrustedPublicKeys === undefined ? {} : runtimeOptions.pluginArtifactTrustedPublicKeys
  );
  const injectedArtifactTrust: any = normalizePluginArtifactTrustedPublicKeys(
    pluginHostPorts.pluginArtifactTrustedPublicKeys === undefined ? {} : pluginHostPorts.pluginArtifactTrustedPublicKeys
  );
  if (Object.keys(configuredArtifactTrust).length > 0 && Object.keys(injectedArtifactTrust).length > 0 &&
      !samePluginArtifactTrust(configuredArtifactTrust, injectedArtifactTrust)) {
    throw new Error("Configured plugin artifact trust conflicts with the injected Host trust authority.");
  }
  if (pluginHostPorts.artifactAuthority && Object.keys(configuredArtifactTrust).length > 0) {
    throw new Error("Configured plugin artifact trust cannot be combined with an injected artifact authority.");
  }
  const effectiveArtifactTrust: any = Object.keys(injectedArtifactTrust).length > 0
    ? injectedArtifactTrust
    : configuredArtifactTrust;
  const artifactAuthority: any = pluginHostPorts.artifactAuthority || await createPluginArtifactAuthority({
    artifactRoot: path.join(userDataPath, "plugin-artifacts"),
    trustedPublicKeys: effectiveArtifactTrust,
    artifactSigner: pluginHostPorts.pluginArtifactPublisherSigner || null,
    secretRef: pluginHostPorts.pluginArtifactPublisherSecretRef || "",
    coreContractDigest: pluginArtifactCoreContractDigest()
  });
  const retiredPluginIds: any = new Set<any>();
  const persistedLifecyclePluginIds: any = await discoverPluginLifecycleStateIds({ userDataPath });
  for (const id of [...new Set<any>([
    ...persistedLifecyclePluginIds,
    ...normalizeEnabledPluginIds(runtimeOptions.enabledPlugins),
    ...Object.keys(runtimeOptions.pluginConfigurations || {})
  ])]) {
    const lifecycleStatePort: any = await createPluginLifecycleStatePort({ userDataPath, pluginId: id });
    const artifactPort: any = artifactAuthority.forPlugin({ pluginId: id, lifecycleStatePort });
    await artifactPort.recoverRemoval();
    const [ledger, removalJournal] = await Promise.all([
      lifecycleStatePort.readRecord("ledger"),
      lifecycleStatePort.readRecord("artifact-removal-journal")
    ]);
    if (ledger?.state === "removal_pending" && ledger.operation === "uninstall" &&
        removalJournal?.phase === "completed" && removalJournal.pluginId === id) {
      await lifecycleStatePort.runExclusive(() : any => lifecycleStatePort.writeRecord("ledger", { ...ledger, state: "uninstalled" }));
      retiredPluginIds.add(id);
    } else if (ledger?.state === "uninstalled") {
      retiredPluginIds.add(id);
    }
  }
  if (retiredPluginIds.size > 0) {
    runtimeOptions = {
      ...runtimeOptions,
      enabledPlugins: normalizeEnabledPluginIds(runtimeOptions.enabledPlugins).filter((id?: any) : any => !retiredPluginIds.has(id)),
      pluginConfigurations: Object.fromEntries((Object.entries(runtimeOptions.pluginConfigurations || {}) as [string, any][])
        .filter(([id]: any[]) : any => !retiredPluginIds.has(id)))
    };
  }
  const pluginCatalog: any = await loadPluginRegistry({
    artifactAuthority
  });
  const pluginConfigurations: any = runtimeOptions.pluginConfigurations ?? {};
  if (!pluginConfigurations || typeof pluginConfigurations !== "object" || Array.isArray(pluginConfigurations)) {
    throw new TypeError("runtime.pluginConfigurations must be an object when provided.");
  }
  const pluginInvocationAuthorizationAuthority: any = pluginHostPorts.pluginInvocationAuthorizationAuthority ||
    createPluginInvocationAuthorizationAuthority();
  const pluginOwnerProcessIdentityAuthority: any = pluginHostPorts.pluginOwnerProcessIdentityAuthority ||
    createPluginOwnerProcessIdentityAuthority({ invocationAuthorizationAuthority: pluginInvocationAuthorizationAuthority });
  const pluginControlledExecutionAuthority: any = pluginHostPorts.pluginControlledExecutionAuthority ||
    createPluginControlledExecutionAuthority({
      userDataPath,
      invocationAuthorizationAuthority: pluginInvocationAuthorizationAuthority
    });
  const pluginProtectedRecoveryAuthority: any = pluginHostPorts.pluginProtectedRecoveryAuthority ||
    createPluginProtectedRecoveryAuthority({ userDataPath });
  const pluginDownstreamClientAspectAuthority: any = pluginHostPorts.pluginDownstreamClientAspectAuthority ||
    createPluginDownstreamClientAspectAuthority();
  const pluginOutboundEgressAuthority: any = pluginHostPorts.pluginOutboundEgressAuthority ||
    createPluginOutboundEgressAuthority();
  const effectivePluginHostPorts: Record<string, any> = {
    ...pluginHostPorts,
    artifactAuthority,
    pluginInvocationAuthorizationAuthority,
    pluginOwnerProcessIdentityAuthority,
    pluginControlledExecutionAuthority,
    pluginProtectedRecoveryAuthority,
    pluginDownstreamClientAspectAuthority,
    pluginOutboundEgressAuthority
  };
  const pluginDeployment: any = pluginCatalog.resolveDeployment({
    enabledPluginIds: normalizeEnabledPluginIds(runtimeOptions.enabledPlugins),
    configuredPluginIds: Object.keys(pluginConfigurations),
    deploymentProfileId: runtimeOptions.deploymentProfileId
  });
  const lifecycleEffectivePlugins: any[] = [];
  const lifecycleEffectivePluginIds: any = new Set<any>();
  for (const plugin of pluginDeployment.loadedPlugins) {
    const lifecycleStatePort: any = await createPluginLifecycleStatePort({ userDataPath, pluginId: plugin.id });
    const [ledger, artifactSnapshot] = await Promise.all([
      lifecycleStatePort.readRecord("ledger"),
      artifactAuthority.forPlugin({ pluginId: plugin.id, lifecycleStatePort }).loadSnapshot()
    ]);
    if (!ledger || !artifactSnapshot || ledger.pluginId !== plugin.id ||
        !Number.isSafeInteger(ledger.generation) || ledger.generation !== artifactSnapshot.generation) {
      throw new Error(`Plugin ${plugin.id} production lifecycle authority does not match its installed artifact.`);
    }
    const state: any = String(ledger.state);
    if (!new Set<any>(["active", "removal_pending", "inactive", "uninstalled"]).has(state)) {
      throw new Error(`Plugin ${plugin.id} lifecycle ledger is invalid.`);
    }
    if (state === "active" && plugin.dependencies.every((dependencyId?: any) : any => lifecycleEffectivePluginIds.has(dependencyId))) {
      lifecycleEffectivePlugins.push(plugin);
      lifecycleEffectivePluginIds.add(plugin.id);
    }
  }
  const lifecycleEffectiveDeployment: Readonly<Record<string, any>> = Object.freeze({
    ...pluginDeployment,
    loadedPlugins: Object.freeze(lifecycleEffectivePlugins)
  });
  const featureRuntime: any = applyPluginDeploymentFeatures(
    await resolveFeatureRuntimeFromEnv({ runtimeOptions }),
    lifecycleEffectiveDeployment
  );
  const platformRegistry: any = createPlatformRegistry({
    scope: path.resolve(userDataPath)
  });
  const activeFeatureIds: any = new Set<any>(featureRuntime.activeFeatureIds);
  const pluginFeatureIds: any = new Map<any, any>(pluginDeployment.loadedPlugins.map((plugin?: any) : any => [
    plugin.id,
    Object.freeze([...new Set<any>([plugin.id, ...(plugin.features || [])])])
  ]));
  const currentActiveFeatures: any = () : any => (featureRuntime.activeFeatures || [])
    .filter((feature?: any) : any => activeFeatureIds.has(feature.featureId));
  const currentDisabledFeatures: any = () : any => [
    ...(featureRuntime.disabledFeatures || []).filter((feature?: any) : any => !activeFeatureIds.has(feature.featureId)),
    ...(featureRuntime.activeFeatures || []).filter((feature?: any) : any => !activeFeatureIds.has(feature.featureId))
  ];
  const lifecycleFeatureRuntime: Readonly<Record<string, any>> = Object.freeze({
    ...featureRuntime,
    get activeFeatureIds() : any { return Object.freeze([...activeFeatureIds]); },
    get disabledFeatureIds() : any {
      return Object.freeze([...new Set<any>([
        ...(featureRuntime.activeFeatureIds || []),
        ...(featureRuntime.disabledFeatureIds || [])
      ])].filter((id?: any) : any => !activeFeatureIds.has(id)));
    },
    get activeFeatures() : any { return Object.freeze(currentActiveFeatures()); },
    get disabledFeatures() : any { return Object.freeze(currentDisabledFeatures()); }
  });
  const runtimeOptionsWithFeatures: Record<string, any> = {
    ...runtimeOptions,
    featureRuntime: lifecycleFeatureRuntime,
    edition: featureRuntime.edition
  };
  const isFeatureActive: any = (featureId?: any) : any =>
    activeFeatureIds.has(featureId);
  const isAnyFeatureActive: any = (...featureIds: any[]) : any =>
    featureIds.some((featureId?: any) : any => isFeatureActive(featureId));

  assertMeshrixPactiumDataDir(userDataPath);
  let runtime: any;
  try {
    runtime = await createServerRuntime({
    userDataPath,
    runtimeOptions: runtimeOptionsWithFeatures,
    pluginDeployment,
    operationLockManager: injectedOperationLockManager,
    registerPluginRuntimeMeasurementSource,
      pluginHostPorts: effectivePluginHostPorts
    });
  } catch (error: any) {
    if (!pluginHostPorts.pluginProtectedRecoveryAuthority) await pluginProtectedRecoveryAuthority.close();
    throw error;
  }
  const resourceClosers: any[] = [
    () : any => runtime.close(),
    ...(!pluginHostPorts.pluginInvocationAuthorizationAuthority ? [() : any => pluginInvocationAuthorizationAuthority.close()] : []),
    ...(!pluginHostPorts.pluginProtectedRecoveryAuthority ? [() : any => pluginProtectedRecoveryAuthority.close()] : [])
  ];
  const integrationTaskSupervisor: any = createIntegrationTaskSupervisor({
    ...(pluginHostPorts.integrationSupervisorOptions || {}),
    adapters: pluginHostPorts.integrationAdapters,
    logger: runtimeLogger
  });
  resourceClosers.push(() : any => integrationTaskSupervisor.shutdown());
  try {
  const pluginContributions: any = createPluginContributionRegistry({
    manifests: pluginCatalog.listPlugins(),
    loadedPlugins: lifecycleEffectiveDeployment.loadedPlugins,
    contributions: runtime.createExecutionView().contributions,
    coreOperations: SERVER_API_OPERATIONS,
    activeFeatureIds
  });
  const gatewayChannelRouter: any = createGatewayChannelRouter({
    downstream: createBuiltInGatewayChannel("downstream"),
    upstream: createBuiltInGatewayChannel("upstream")
  });
  function synchronizePluginGatewayChannels(pluginId: string): void {
    gatewayChannelRouter.removeContribution(pluginId);
    const records: any[] = [...pluginContributions.gatewayChannels.values()]
      .filter((record?: any) : any => record.pluginId === pluginId);
    const implementation: any = records[0]?.implementation;
    if (implementation) gatewayChannelRouter.registerContribution(pluginId, implementation);
  }
  for (const record of pluginContributions.gatewayChannels.values()) {
    synchronizePluginGatewayChannels(record.pluginId);
  }
  let consoleAuthRef: any = null;
  const unregisterPluginLifecycleListener: any = runtime.onPluginLifecycleTransition({
    prepare({ pluginId }: Record<string, any>) : any {
      const contributionChange: any = pluginContributions.preparePluginDeactivation(pluginId);
      const platformChange: any = platformRegistry.prepareUnregisterOwner(pluginId);
      const previousFeatureIds: any[] = [...activeFeatureIds];
      return Object.freeze({
        commit() : any {
          contributionChange.commit();
          synchronizePluginGatewayChannels(pluginId);
          platformChange.commit();
          for (const featureId of pluginFeatureIds.get(pluginId) || [pluginId]) activeFeatureIds.delete(featureId);
          consoleAuthRef?.refreshActiveFeatureIds([...activeFeatureIds]);
        },
        rollback() : any {
          contributionChange.rollback();
          synchronizePluginGatewayChannels(pluginId);
          platformChange.rollback();
          activeFeatureIds.clear();
          for (const featureId of previousFeatureIds) activeFeatureIds.add(featureId);
          consoleAuthRef?.refreshActiveFeatureIds(previousFeatureIds);
        }
      });
    }
  });
  resourceClosers.push(() : any => unregisterPluginLifecycleListener());
  const activeApiOperations: any = pluginContributions.activeOperations;
  const getActiveApiOperations: any = () : any => pluginContributions.currentActiveOperations();
  let sandboxExecution: any = null;
  const publicFeatures: any = () : any => {
    const { enabledPlugins: effectivePlugins, ...pluginRuntime } = pluginContributions.publicRuntime();
    return Object.freeze({
      ...publicFeatureRuntime(lifecycleFeatureRuntime, getActiveApiOperations()),
      plugins: Object.freeze({
        ...pluginRuntime,
        loadedPlugins: Object.freeze(pluginDeployment.loadedPlugins.map((plugin?: any) : any => Object.freeze({
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
  const { registerSecurityProviders } = await import("./register-security-providers.ts");
  const registeredSecurityProvider: any = await registerSecurityProviders({ userDataPath });
  resourceClosers.push(() : any => registeredSecurityProvider?.close?.());
  const consoleAuth: any = createConsoleAuth({
    userDataPath,
    consoleRoles: CONSOLE_ROLES,
    activeFeatureIds: [...activeFeatureIds],
    featureScopeGrants: Object.fromEntries((Object.entries(pluginConfigurations) as [string, any][])
      .flatMap(([pluginId, configuration]: any[]) : any => (Object.entries(configuration?.consoleRoleScopeGrants || {}) as [string, any][])
        .map(([featureId, grants]: any[]) : any => [featureId || pluginId, grants])))
  });
  consoleAuthRef = consoleAuth;
  resourceClosers.push(() : any => consoleAuth.close());
  const organizationGovernanceService: any = createOrganizationGovernanceService({
    tagManagementStore: registeredSecurityProvider
  });
  const processIdentity: any = createProcessIdentityService({ dataDir: userDataPath });
  pluginOwnerProcessIdentityAuthority.bind(processIdentity);
  resourceClosers.push(() : any => processIdentity.close());
  if (!pluginHostPorts.pluginOwnerProcessIdentityAuthority) {
    resourceClosers.push(() : any => pluginOwnerProcessIdentityAuthority.close());
  }
  const securityPermissions: any = createSecurityPermissionsProvider({
    consoleAuth,
    organizationGovernanceService,
    tagManagementStore: registeredSecurityProvider,
    processIdentity
  });
  setModuleManagementSettingsDeps({ loadSettings, saveSettings });
  const moduleManagement: any = createModuleManagementProvider({
    runtime,
    userDataPath,
    activeFeatureIds
  });
  const dataStructureSubstrate: any = createDataStructureSubstrate({ userDataPath });
  resourceClosers.push(() : any => dataStructureSubstrate.close());
  const operationProofSubstrate: any = createOperationProofSubstrate({
    userDataPath,
    pactiumRuntime: dataStructureSubstrate.pactiumRuntime,
    runtimeOptions: runtimeOptionsWithFeatures
  });
  resourceClosers.push(() : any => operationProofSubstrate.close());
  const operationAuditStore: any = createOperationAuditStore({ userDataPath });
  resourceClosers.push(() : any => operationAuditStore.close());
  const operationLockManager: any = runtime.operationLockManager;
  const operationConcurrencyScope: any =
    requestedOperationConcurrencyScope.trim() ||
    String(operationLockManager?.namespace || "").trim() ||
    "server";
  const protocolEventRuntime: any = await createProtocolEventRuntime({
    userDataPath,
    logger: runtimeLogger,
    createEventBus: createProtocolEventBus
  });
  const { protocolEventBus } = protocolEventRuntime;
  resourceClosers.push(() : any => protocolEventRuntime.close());
  const queueApplicationPort: any = await createQueueApplicationPort({
    userDataPath,
    logger: runtimeLogger
  });
  resourceClosers.push(() : any => queueApplicationPort.close());
  const coreProvider: any = createCorePlatformProvider({
    operations: activeApiOperations,
    getOperations: getActiveApiOperations,
    protocolEventBus,
    runtimeLogger,
    featureRuntime: lifecycleFeatureRuntime,
    operationLockManager,
    operationConcurrencyScope,
    operationProofSubstrate
  });
  const storageProvider: any = createStorageProvider({
    userDataPath,
    storageKernel: runtime.storageKernel,
    artifactClassifiers: dataStructureSubstrate.storageArtifactClassifiers
  });
  const custodyKeyBroker: any = createLocalCustodyKeyBroker({ userDataPath });
  resourceClosers.push(() : any => custodyKeyBroker.close());
  const deferredProtectedSinkAuthorityPort: any =
    securityPermissions.deferredProtectedSinkAuthorityPort;
  if (
    !deferredProtectedSinkAuthorityPort ||
    typeof deferredProtectedSinkAuthorityPort.reauthorizeCustodyRead !==
      "function"
  ) {
    throw new Error(
      "Deferred protected sink authority composition is unavailable."
    );
  }
  const uploadNoRunCustody: any = createUploadNoRunCustody({
    userDataPath,
    storageKernel: runtime.storageKernel,
    storageProvider,
    keyBroker: custodyKeyBroker,
    reauthorizeCustodyRead: (input?: any) : any =>
      deferredProtectedSinkAuthorityPort.reauthorizeCustodyRead(input)
  });
  const uploadSessionStore: any = createUploadSessionStore({
    userDataPath,
    custodyPort: uploadNoRunCustody.stagingPort,
    custodyDescribe: uploadNoRunCustody.describe
  });
  const opaqueCustodyRuntime: any = createOpaqueSandboxCustodyRuntime({
    userDataPath,
    storageKernel: runtime.storageKernel,
    storageProvider,
    keyBroker: custodyKeyBroker
  });
  const opaqueArtifactCustody: any = opaqueCustodyRuntime.custody;
  const persistedSettings: any = await loadSettings(userDataPath);
  sandboxExecution = await createConfiguredSandboxExecution({
    userDataPath,
    settings: persistedSettings.executionSandbox,
    opaqueArtifactCustody: opaqueCustodyRuntime.promotionAuthority,
    queueApplicationPort,
    audit: (entry?: any) : any => operationAuditStore.append({
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
    resourceClosers.push(() : any => pluginControlledExecutionAuthority.close());
  }
  resourceClosers.push(() : any => sandboxExecution.close());
  const devopsProvider: any = createDevopsProvider({ userDataPath });

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
  async function createBoundRuntimeProviders(input: Record<string, any> = {}) : Promise<any> {
    if (runtimeProviderCompositionState !== "available") {
      throw new TypeError(
        "Server runtime providers may only be composed once."
      );
    }
    if (
      input &&
      typeof input === "object" &&
      Object.hasOwn(input, "materializationRootAuthority")
    ) {
      throw new TypeError(
        "Workspace materialization root authority injection is forbidden."
      );
    }
    runtimeProviderCompositionState = "creating";
    try {
      const { createServerRuntimeProviders } =
        await import("./server-runtime-providers.ts");
      const providers: any = await createServerRuntimeProviders({
        ...input,
        materializationRootAuthority:
          workspaceMaterializationRootAuthority
      });
      if (providers.agentWorkspace) {
        workspaceMaterializationPort =
          claimAgentWorkspaceMaterializationRootPort(
            workspaceMaterializationRootAuthority
          );
      }
      runtimeProviderCompositionState = "created";
      return providers;
    } catch (error: any) {
      runtimeProviderCompositionState = "failed";
      throw error;
    }
  }

  async function createBoundUploadWorkspaceMaterializationProvider(
    input: Record<string, any> = {}
  ) : Promise<any> {
    if (runtimeProviderCompositionState !== "created") {
      throw new TypeError(
        "Server runtime providers must be composed before upload materialization."
      );
    }
    if (!workspaceMaterializationPort) {
      throw new TypeError(
        "The root-owned workspace materialization port is unavailable."
      );
    }
    if (
      input &&
      typeof input === "object" &&
      Object.hasOwn(input, "workspaceMaterializationPort")
    ) {
      throw new TypeError(
        "Workspace materialization port injection is forbidden."
      );
    }
    if (
      uploadMaterializationProviderCompositionState !== "available"
    ) {
      throw new TypeError(
        "Upload workspace materialization may only be composed once."
      );
    }
    uploadMaterializationProviderCompositionState = "creating";
    try {
      const { createUploadWorkspaceMaterializationProvider } =
        await import("./upload-workspace-materialization-provider.ts");
      const provider: any =
        await createUploadWorkspaceMaterializationProvider({
          ...input,
          workspaceMaterializationPort
        });
      uploadMaterializationProviderCompositionState = "created";
      return provider;
    } catch (error: any) {
      uploadMaterializationProviderCompositionState = "failed";
      throw error;
    }
  }

  const close: any = createCompositionCloser(resourceClosers);

  return Object.freeze({
    userDataPath,
    runtimeOptions: runtimeOptionsWithFeatures,
    featureRuntime: lifecycleFeatureRuntime,
    allApiOperationCount: SERVER_API_OPERATIONS.length,
    activeApiOperations,
    getActiveApiOperations,
    pluginContributions,
    gatewayChannelRouter,
    synchronizePluginGatewayChannels,
    publicFeatures,
    isFeatureActive,
    isAnyFeatureActive,
    platformRegistry,
    coreProvider,
    runtime,
    moduleManagement,
    dataStructureSubstrate,
    operationProofSubstrate,
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
    registeredSecurityProvider,
    storageProvider,
    storageKernel: runtime.storageKernel,
    clientRegistryService: runtime.clientRegistryService,
    devopsProvider,
    integrationTaskSupervisor,
    loadSettings,
    saveSettings,
    normalizeSettings,
    getSettingsPath,
    createBoundRuntimeProviders,
    createBoundUploadWorkspaceMaterializationProvider,
    close
  });
  } catch (error: any) {
    await runResourceClosers(resourceClosers, { surfaceFailure: false });
    throw error;
  }
}

export async function ensureConsoleOwner({ consoleAuth }: Record<string, any>) : Promise<any> {
  return consoleAuth.ensureInitialOwner();
}
