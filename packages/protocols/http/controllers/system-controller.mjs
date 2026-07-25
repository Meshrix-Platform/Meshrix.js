import { createHash } from "node:crypto";
import {
  contentDispositionHeader,
  sendJson
} from "#meshrix/http-utils";
import { createSystemControllerAgentSettingsHandlers } from "./system-controller-agent-settings-handlers.mjs";
import { createSystemControllerAppearancePresetHandlers } from "./system-controller-appearance-preset-handlers.mjs";
import { createSystemControllerAuthHandlers } from "./system-controller-auth-handlers.mjs";
import { createSystemControllerCapabilityEcosystemHandlers } from "./system-controller-capability-ecosystem-handlers.mjs";
import { createSystemControllerContexts } from "./system-controller-contexts.mjs";
import { createSystemControllerFoundationHandlers } from "./system-controller-foundation-handlers.mjs";
import { createSystemControllerOpsObservationHandlers } from "./system-controller-ops-observation-handlers.mjs";
import { createSystemControllerProcessIdentityHandlers } from "./system-controller-process-identity-handlers.mjs";
import { createSystemControllerRuntimeHandlers } from "./system-controller-runtime-handlers.mjs";
import { createSystemControllerWorkspaceProtocolHandlers } from "./system-controller-workspace-protocol-handlers.mjs";
import { createSystemControllerWorkspaceRuntimeHandlers } from "./system-controller-workspace-runtime-handlers.mjs";

function parseJsonBody(requestBody) {
  return requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
}

function sendJsonWithHeaders(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

const CONSOLE_STATE_PROOF_FIELDS = Object.freeze({
  runtime: Object.freeze(["status", "state", "mode", "version", "revision", "generation", "ready", "healthy"]),
  discovery: Object.freeze(["mode", "configVersion"]),
  agentConfigs: Object.freeze(["generation", "revision"]),
  readinessBaseline: Object.freeze(["status", "state", "version", "revision", "generation", "ok", "ready", "healthy"]),
  maintenanceAgent: Object.freeze(["status", "state", "version", "revision", "generation", "enabled", "active", "ready", "healthy"]),
  storage: Object.freeze([
    "databaseExists",
    "objectCount",
    "ownedObjectCount",
    "deletionOperationCount",
    "objectFileCount",
    "objectBytes"
  ])
});

function proofScalar(value) {
  if (["string", "boolean"].includes(typeof value)) return value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickProofFields(value, fields) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const projected = {};
  for (const key of fields) {
    const scalar = proofScalar(source[key]);
    if (scalar !== undefined) projected[key] = scalar;
  }
  return projected;
}

function countProjection(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const projected = {};
  for (const key of Object.keys(source).sort()) {
    const child = source[key];
    const scalar = proofScalar(child);
    if (scalar !== undefined && /(?:count|total|queued|pending|running|failed|succeeded|completed|online|offline|active|idle)$/iu.test(key)) {
      projected[key] = scalar;
      continue;
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const nested = countProjection(child);
      if (Object.keys(nested).length > 0) projected[key] = nested;
    }
  }
  return projected;
}

function featureProjection(features) {
  const source = Array.isArray(features)
    ? features
    : features && typeof features === "object"
      ? Object.entries(features).map(([featureId, value]) => (
          value && typeof value === "object" && !Array.isArray(value)
            ? { featureId, ...value }
            : { featureId, enabled: value === true }
        ))
      : [];
  return source.map((feature) => ({
    id: String(feature?.id || feature?.featureId || feature?.name || ""),
    ...pickProofFields(feature, ["status", "state", "version", "revision", "enabled", "active", "ready"])
  })).filter((feature) => feature.id).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalProofJson(value) {
  if (Array.isArray(value)) return value.map(canonicalProofJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalProofJson(value[key])])
  );
}

export function consoleStateProofChangeProjection(consoleState = {}) {
  const state = consoleState && typeof consoleState === "object" && !Array.isArray(consoleState)
    ? consoleState
    : {};
  const projection = canonicalProofJson({
    schema: "console-state-v1",
    runtime: pickProofFields(state.runtime, CONSOLE_STATE_PROOF_FIELDS.runtime),
    discovery: pickProofFields(state.discovery?.value, CONSOLE_STATE_PROOF_FIELDS.discovery),
    agentConfigs: pickProofFields(state.agentConfigs, CONSOLE_STATE_PROOF_FIELDS.agentConfigs),
    readinessBaseline: pickProofFields(state.readinessBaseline, CONSOLE_STATE_PROOF_FIELDS.readinessBaseline),
    maintenanceAgent: pickProofFields(state.maintenanceAgent, CONSOLE_STATE_PROOF_FIELDS.maintenanceAgent),
    storage: pickProofFields(state.storage, CONSOLE_STATE_PROOF_FIELDS.storage),
    jobs: countProjection(state.jobs?.summary),
    clients: countProjection(state.clients?.summary),
    features: featureProjection(state.features)
  });
  return Object.freeze({
    changeProjection: "console-state-v1",
    changeDigest: `sha256:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`
  });
}

export function createSystemController({
  userDataPath,
  distPath,
  runtime,
  moduleManagement,
  externalGatewayManagement,
  jobWorkflowProvider,
  storageProvider = null,
  clientRegistryService = null,
  serverLabel,
  getDiscoveryState,
  setDiscoveryState,
  getListenUrl,
  coreProvider = null,
  getControllers = () => null,
  protocolEventBus = null,
  consoleAuth = null,
  securityPermissions = null,
  processIdentity = null,
  operationAuditStore = null,
  maintenanceAgent = null,
  agentWorkspace = null,
  contextRuntime = null,
  modelDecisionRuntime = null,
  strategyManagementProvider = null,
  checkpointTreeApi = null,
  operationProofSubstrate = null,
  workQueueObservation = null,
  devopsProvider = null,
  getFeatureEntries = () => null,
  isFeatureActive: isFeatureActiveOverride = null,
  settingsPort = null,
  discoveryPort = null,
  getToolSkillManagementProvider = () => null,
  getOperationPermissionPlatform = () => null,
  consoleDomainServices = null,
  workspaceRoot = ""
}) {
  const effectiveWorkspaceRoot = String(workspaceRoot || process.cwd()).trim() || process.cwd();
  if (!securityPermissions) {
    throw new TypeError("System controller requires an explicit security permissions port.");
  }
  if (
    !settingsPort ||
    typeof settingsPort.loadSettings !== "function" ||
    typeof settingsPort.saveSettings !== "function" ||
    typeof settingsPort.normalizeSettings !== "function" ||
    typeof settingsPort.getSettingsPath !== "function"
  ) {
    throw new TypeError("System controller requires an explicit settings port.");
  }
  if (!discoveryPort || typeof discoveryPort.saveDiscoveryConfig !== "function") {
    throw new TypeError("System controller requires an explicit discovery port.");
  }
  const effectiveSecurityPermissions = securityPermissions;
  const effectiveProcessIdentity = processIdentity || effectiveSecurityPermissions?.processIdentity || null;
  const {
    executeConsoleDomainOperation,
    runtimeWorkflowContext,
    settingsAgentGatewayContext,
    authorizationFacadeContext,
    accessControlContext,
    appendConsoleOperationLog,
    isFeatureActive: contextIsFeatureActive
  } = createSystemControllerContexts({
    userDataPath,
    runtime,
    moduleManagement,
    externalGatewayManagement,
    jobWorkflowProvider,
    storageProvider,
    clientRegistryService,
    protocolEventBus,
    securityPermissions: effectiveSecurityPermissions,
    operationAuditStore,
    agentWorkspace,
    contextRuntime,
    modelDecisionRuntime,
    strategyManagementProvider,
    workQueueObservation,
    getListenUrl,
    getFeatureEntries,
    settingsPort,
    discoveryPort,
    consoleDomainServices
  });
  const isFeatureActive = (featureId) => typeof isFeatureActiveOverride === "function"
    ? isFeatureActiveOverride(featureId)
    : contextIsFeatureActive(featureId);

  function protocolPayload(requestBody, url = null) {
    if (requestBody?.length > 0) {
      return parseJsonBody(requestBody);
    }
    return url ? Object.fromEntries(url.searchParams.entries()) : {};
  }

  function queryPayload(url = null) {
    if (!url) {
      return {};
    }
    const payload = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        payload[key] = Array.isArray(payload[key]) ? [...payload[key], value] : [payload[key], value];
      } else {
        payload[key] = value;
      }
    }
    return payload;
  }

  function workspaceIdFrom(input = {}, fallback = "") {
    return String(input.workspaceId || input.workspace || fallback || "default").trim() || "default";
  }

  async function sendConsoleDomainOperation({
    operationId,
    input = {},
    response,
    context = {},
    errorMessage = "Console domain operation failed."
  }) {
    try {
      const operationResult = await runConsoleDomainOperation({ operationId, input, context });
      if (
        operationId === "system.console_state" &&
        Number(operationResult.status || 200) < 400 &&
        response &&
        typeof response === "object"
      ) {
        response.__licoProofChangeProjection = consoleStateProofChangeProjection(operationResult.payload);
      }
      if (operationResult.payload?.__responseHandled) {
        return;
      }
      if (operationResult.payload?.__binaryResponse) {
        const disposition = operationResult.payload.disposition || "inline";
        const buffer = Buffer.isBuffer(operationResult.payload.buffer)
          ? operationResult.payload.buffer
          : Buffer.alloc(0);
        response.writeHead(operationResult.status || 200, {
          "Content-Type": operationResult.payload.contentType || "application/octet-stream",
          "Content-Disposition": contentDispositionHeader(disposition, operationResult.payload.fileName || "asset.bin"),
          "Content-Length": String(buffer.length),
          "Cache-Control": "no-store",
          ...(operationResult.payload.headers || {})
        });
        response.end(buffer);
        return;
      }
      if (operationResult.payload?.__htmlResponse) {
        response.writeHead(operationResult.status || 200, {
          "Content-Type": operationResult.payload.contentType || "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          ...(operationResult.payload.headers || {})
        });
        response.end(String(operationResult.payload.body || ""));
        return;
      }
      if (operationResult.payload?.__headers) {
        const { __headers: headers, ...payload } = operationResult.payload;
        sendJsonWithHeaders(response, operationResult.status || 200, payload, headers);
        return;
      }
      sendJson(response, operationResult.status || 200, operationResult.payload ?? operationResult);
    } catch (error) {
      const declaredStatus = Number(error?.statusCode || error?.status || 0);
      const status = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
        ? declaredStatus
        : 400;
      sendJson(response, status, {
        ok: false,
        operationId,
        error: error instanceof Error ? error.message : errorMessage,
        ...(typeof error?.code === "string" && error.code ? { code: error.code } : {})
      });
    }
  }

  async function runConsoleDomainOperation({ operationId, input = {}, context = {} }) {
    return executeConsoleDomainOperation({
      operationId,
      input,
      context: {
        userDataPath,
        workspaceRoot: effectiveWorkspaceRoot,
        operationProofSubstrate,
        settingsPort,
        discoveryPort,
        ...(consoleDomainServices?.consoleOperationProviders || {}),
        ...context
      }
    });
  }

  async function verifyToolSkillExternalAuth({
    request,
    requestBody = Buffer.alloc(0),
    url = null,
    method = "GET",
    externalAuth = {}
  } = {}) {
    const provider = getToolSkillManagementProvider();
    if (!provider?.authorizeRequest) {
      return {
        ok: false,
        status: 503,
        reasonCode: "tool_authorization_unavailable",
        error: "Tool/Skill management provider is unavailable."
      };
    }
    const authorization = await provider.authorizeRequest({
      request,
      requiredScopes: Array.isArray(externalAuth.requiredScopes) ? externalAuth.requiredScopes : [],
      recordUse: externalAuth.recordUse === true,
      requestBody,
      url,
      method
    });
    if (!authorization.ok) {
      return authorization;
    }
    const grant = authorization.grant || {};
    const actor = {
      type: "tool-grant",
      userId: grant.id || "",
      subjectId: grant.id || "",
      username: grant.label || grant.id || "tool-grant",
      roleId: "tool-grant",
      scopes: Array.isArray(grant.scopes) ? grant.scopes : [],
      toolsets: Array.isArray(grant.toolsets) ? grant.toolsets : []
    };
    return {
      ...authorization,
      actor,
      authSession: { user: actor },
      revalidateAuthorization: async () => {
        const currentAuthorization = await provider.authorizeRequest({
          request,
          requiredScopes: Array.isArray(externalAuth.requiredScopes) ? externalAuth.requiredScopes : [],
          recordUse: false,
          requestBody,
          url,
          method
        });
        if (
          currentAuthorization.ok !== true ||
          currentAuthorization.grant?.id !== grant.id
        ) {
          return {
            ok: false,
            status: currentAuthorization.status || 403,
            reasonCode: currentAuthorization.reasonCode || "external_grant_stale",
            error: currentAuthorization.error || "External grant is no longer authorized."
          };
        }
        return currentAuthorization;
      }
    };
  }

  const controller = {
    verifyToolSkillExternalAuth,
    ...createSystemControllerAuthHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      securityPermissions: effectiveSecurityPermissions,
      operationAuditStore,
      appendConsoleOperationLog
    }),
    ...createSystemControllerFoundationHandlers({
      sendConsoleDomainOperation,
      protocolPayload,
      workspaceIdFrom,
      authorizationFacadeContext,
      accessControlContext,
      getToolSkillManagementProvider,
      getStrategyManagementProvider: () => strategyManagementProvider,
      agentWorkspace,
      runtime
    }),
    ...createSystemControllerRuntimeHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      queryPayload,
      isFeatureActive,
      runtimeWorkflowContext,
      coreProvider,
      getControllers,
      getFeatureEntries,
      protocolEventBus,
      getDiscoveryState,
      setDiscoveryState,
      getListenUrl,
      serverLabel,
      distPath,
      runtime,
      moduleManagement,
      externalGatewayManagement,
      jobWorkflowProvider,
      storageProvider,
      clientRegistryService,
      securityPermissions: effectiveSecurityPermissions,
      maintenanceAgent,
      getToolSkillManagementProvider,
      consoleDomainServices
    }),
    ...createSystemControllerAgentSettingsHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      settingsAgentGatewayContext
    }),
    ...createSystemControllerAppearancePresetHandlers({
      parseJsonBody,
      userDataPath,
      appearancePresetCatalog: consoleDomainServices?.appearancePresetCatalog || null
    }),
    ...createSystemControllerProcessIdentityHandlers({
      parseJsonBody,
      processIdentity: effectiveProcessIdentity
    }),
    ...createSystemControllerWorkspaceProtocolHandlers({
      sendConsoleDomainOperation,
      protocolPayload,
      operationAuditStore,
      checkpointTreeApi,
      agentWorkspace,
      accessControlContext
    }),
    ...createSystemControllerCapabilityEcosystemHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      moduleManagement,
      getToolSkillManagementProvider,
      getStrategyManagementProvider: () => strategyManagementProvider
    }),
    ...createSystemControllerOpsObservationHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      jobWorkflowProvider,
      checkpointTreeApi,
      workQueueObservation,
      devopsProvider
    }),
    ...createSystemControllerWorkspaceRuntimeHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      protocolPayload,
      contextRuntime,
      agentWorkspace,
      userDataPath
    }),
  };
  return controller;
}
