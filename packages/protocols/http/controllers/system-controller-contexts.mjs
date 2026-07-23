import { logRuntimeEvent } from "#lico/runtime-logger";

export function createSystemControllerContexts({
  userDataPath,
  runtime,
  moduleManagement = null,
  externalGatewayManagement = null,
  jobWorkflowProvider,
  storageProvider = null,
  clientRegistryService = null,
  protocolEventBus = null,
  securityPermissions = null,
  operationAuditStore = null,
  agentWorkspace = null,
  contextRuntime = null,
  modelDecisionRuntime = null,
  strategyManagementProvider = null,
  workQueueObservation = null,
  getFeatureEntries = () => null,
  getListenUrl = () => "",
  settingsPort = null,
  discoveryPort = null,
  consoleDomainServices = null
} = {}) {
  const requireDomainService = (name) => {
    const service = consoleDomainServices?.[name];
    if (typeof service !== "function") {
      throw new Error(`${name} provider is not configured.`);
    }
    return service;
  };
  const requireDomainProvider = (name, validate) => {
    const provider = consoleDomainServices?.[name];
    if (!validate(provider)) {
      throw new Error(`${name} provider is not configured.`);
    }
    return provider;
  };
  const agentRuntimeProvider = requireDomainProvider(
    "agentRuntimeProvider",
    (provider) =>
      provider &&
      typeof provider.getAgentConfigRegistry === "function" &&
      typeof provider.callAgentGateway === "function" &&
      typeof provider.probeModelConnection === "function" &&
      typeof provider.inspectAgentModelRouting === "function"
  );
  const executeConsoleDomainOperation = requireDomainService("executeConsoleDomainOperation");
  const uploadSessionStore = requireDomainProvider(
    "uploadSessionStore",
    (provider) =>
      provider &&
      typeof provider.resolveUploadSessionFiles === "function" &&
      typeof provider.deleteUploadSession === "function"
  );
  function appendConsoleOperationLog(entry = {}) {
    if (operationAuditStore) {
      try {
        operationAuditStore.append({
          transport: "http",
          risk: entry.risk || "",
          readOnly: entry.readOnly === true,
          status: entry.status || "ok",
          actor: entry.authSession || entry.actor || {},
          operationId: entry.operationId || "console.operation",
          input: entry.input || {},
          output: entry.output,
          error: entry.error || ""
        });
      } catch {
        // Runtime logging below is best-effort and must not break the console path.
      }
    }
    logRuntimeEvent(entry.level || (entry.status === "failed" ? "warn" : "info"), entry.event || entry.operationId || "console.operation", {
      operationId: entry.operationId || "console.operation",
      status: entry.status || "ok",
      actor: entry.authSession?.user || entry.actor || {},
      input: entry.input || {},
      output: entry.output || {},
      error: entry.error || ""
    });
  }

  function runtimeWorkflowContext(authSession = null) {
    return {
      userDataPath,
      protocolEventBus,
      storageProvider,
      clientRegistryService,
      runtime,
      externalGatewayManagement,
      settingsPort,
      discoveryPort,
      loadSettings: settingsPort?.loadSettings || null,
      resolveUploadSessionFiles: uploadSessionStore.resolveUploadSessionFiles,
      deleteUploadSession: uploadSessionStore.deleteUploadSession,
      modelDecisionRuntime,
      strategyManagementProvider,
      jobWorkflowProvider,
      workQueueObservation,
      contextRuntime,
      getListenUrl,
      agentRuntimeProvider,
      appendConsoleOperationLog,
      authSession
    };
  }

  function settingsAgentGatewayContext(authSession = null, extra = {}) {
    return {
      userDataPath,
      runtime,
      moduleManagement,
      externalGatewayManagement,
      protocolEventBus,
      contextRuntime,
      agentWorkspace,
      agentRuntimeProvider,
      settingsPort,
      discoveryPort,
      appendConsoleOperationLog,
      authSession,
      ...extra
    };
  }

  function authorizationFacadeContext(authSession = null, extra = {}) {
    return {
      userDataPath,
      securityPermissions,
      protocolEventBus,
      authSession,
      getListenUrl,
      settingsPort,
      discoveryPort,
      ...extra
    };
  }

  function accessControlContext(authSession = null, extra = {}) {
    return {
      userDataPath,
      securityPermissions,
      authSession,
      settingsPort,
      discoveryPort,
      ...extra
    };
  }

  function isFeatureActive(featureId) {
    const features = getFeatureEntries ? getFeatureEntries() : null;
    const active = Array.isArray(features?.activeFeatureIds) ? features.activeFeatureIds : [];
    return active.length === 0 || active.includes(featureId);
  }

  return Object.freeze({
    executeConsoleDomainOperation,
    runtimeWorkflowContext,
    settingsAgentGatewayContext,
    authorizationFacadeContext,
    accessControlContext,
    appendConsoleOperationLog,
    isFeatureActive
  });
}
