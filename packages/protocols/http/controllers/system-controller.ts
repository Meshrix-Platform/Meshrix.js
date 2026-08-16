import { createHash } from "node:crypto";
import {
  contentDispositionHeader,
  sendJson
} from "#meshrix/http-utils";
import { createSystemControllerSettingsHandlers } from "./system-controller-settings-handlers.ts";
import { createSystemControllerAppearancePresetHandlers } from "./system-controller-appearance-preset-handlers.ts";
import { createSystemControllerAuthHandlers } from "./system-controller-auth-handlers.ts";
import { createSystemControllerCapabilityEcosystemHandlers } from "./system-controller-capability-ecosystem-handlers.ts";
import { createSystemControllerContexts } from "./system-controller-contexts.ts";
import { createSystemControllerFoundationHandlers } from "./system-controller-foundation-handlers.ts";
import { createSystemControllerOpsObservationHandlers } from "./system-controller-ops-observation-handlers.ts";
import { createSystemControllerProcessIdentityHandlers } from "./system-controller-process-identity-handlers.ts";
import { createSystemControllerRuntimeHandlers } from "./system-controller-runtime-handlers.ts";
import { createSystemControllerWorkspaceProtocolHandlers } from "./system-controller-workspace-protocol-handlers.ts";
import { createSystemControllerWorkspaceRuntimeHandlers } from "./system-controller-workspace-runtime-handlers.ts";

function parseJsonBody(requestBody?: any) : any {
  return requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
}

function sendJsonWithHeaders(response?: any, statusCode?: any, payload?: any, headers: Record<string, any> = {}) : any {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

const CONSOLE_STATE_PROOF_FIELDS: Readonly<Record<string, any>> = Object.freeze({
  runtime: Object.freeze(["status", "state", "mode", "version", "revision", "generation", "ready", "healthy"]),
  discovery: Object.freeze(["mode", "configVersion"]),
  agentConfigs: Object.freeze(["generation", "revision"]),
  readinessBaseline: Object.freeze(["status", "state", "version", "revision", "generation", "ok", "ready", "healthy"]),
  storage: Object.freeze([
    "databaseExists",
    "objectCount",
    "ownedObjectCount",
    "deletionOperationCount",
    "objectFileCount",
    "objectBytes"
  ])
});

function proofScalar(value?: any) : any {
  if (["string", "boolean"].includes(typeof value)) return value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickProofFields(value?: any, fields?: any) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const projected: Record<string, any> = {};
  for (const key of fields) {
    const scalar: any = proofScalar(source[key]);
    if (scalar !== undefined) projected[key] = scalar;
  }
  return projected;
}

function countProjection(value?: any) : any {
  const source: any = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const projected: Record<string, any> = {};
  for (const key of Object.keys(source).sort()) {
    const child: any = source[key];
    const scalar: any = proofScalar(child);
    if (scalar !== undefined && /(?:count|total|queued|pending|running|failed|succeeded|completed|online|offline|active|idle)$/iu.test(key)) {
      projected[key] = scalar;
      continue;
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const nested: any = countProjection(child);
      if (Object.keys(nested).length > 0) projected[key] = nested;
    }
  }
  return projected;
}

function featureProjection(features?: any) : any {
  const source: any = Array.isArray(features)
    ? features
    : features && typeof features === "object"
      ? (Object.entries(features) as [string, any][]).map(([featureId, value]: any[]) : any => (
          value && typeof value === "object" && !Array.isArray(value)
            ? { featureId, ...value }
            : { featureId, enabled: value === true }
        ))
      : [];
  return source.map((feature?: any) : any => ({
    id: String(feature?.id || feature?.featureId || feature?.name || ""),
    ...pickProofFields(feature, ["status", "state", "version", "revision", "enabled", "active", "ready"])
  })).filter((feature?: any) : any => feature.id).sort((left?: any, right?: any) : any => left.id.localeCompare(right.id));
}

function canonicalProofJson(value?: any) : any {
  if (Array.isArray(value)) return value.map(canonicalProofJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key?: any) : any => [key, canonicalProofJson(value[key])])
  );
}

export function consoleStateProofChangeProjection(consoleState: Record<string, any> = {}) : any {
  const state: any = consoleState && typeof consoleState === "object" && !Array.isArray(consoleState)
    ? consoleState
    : {};
  const projection: any = canonicalProofJson({
    schema: "console-state-v1",
    runtime: pickProofFields(state.runtime, CONSOLE_STATE_PROOF_FIELDS.runtime),
    discovery: pickProofFields(state.discovery?.value, CONSOLE_STATE_PROOF_FIELDS.discovery),
    agentConfigs: pickProofFields(state.agentConfigs, CONSOLE_STATE_PROOF_FIELDS.agentConfigs),
    readinessBaseline: pickProofFields(state.readinessBaseline, CONSOLE_STATE_PROOF_FIELDS.readinessBaseline),
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
  gatewayChannelRouter,
  jobWorkflowProvider,
  storageProvider = null,
  clientRegistryService = null,
  serverLabel,
  getDiscoveryState,
  setDiscoveryState,
  getListenUrl,
  coreProvider = null,
  getControllers = () : any => null,
  protocolEventBus = null,
  consoleAuth = null,
  securityPermissions = null,
  processIdentity = null,
  operationAuditStore = null,
  agentWorkspace = null,
  contextRuntime = null,
  modelDecisionRuntime = null,
  strategyManagementProvider = null,
  checkpointTreeApi = null,
  operationProofSubstrate = null,
  workQueueObservation = null,
  devopsProvider = null,
  getFeatureEntries = () : any => null,
  isFeatureActive: isFeatureActiveOverride = null,
  settingsPort = null,
  discoveryPort = null,
  getToolSkillManagementProvider = () : any => null,
  getOperationPermissionPlatform = () : any => null,
  getIntegrationTaskSupervisorSnapshot = () : any => null,
  consoleDomainServices = null,
  workspaceRoot = ""
}: Record<string, any>) : any {
  const effectiveWorkspaceRoot: any = String(workspaceRoot || process.cwd()).trim() || process.cwd();
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
  const effectiveSecurityPermissions: any = securityPermissions;
  const effectiveProcessIdentity: any = processIdentity || effectiveSecurityPermissions?.processIdentity || null;
  const {
    executeConsoleDomainOperation,
    runtimeWorkflowContext,
    settingsContext,
    authorizationFacadeContext,
    accessControlContext,
    appendConsoleOperationLog,
    isFeatureActive: contextIsFeatureActive
  } = createSystemControllerContexts({
    userDataPath,
    runtime,
    moduleManagement,
    gatewayChannelRouter,
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
  const isFeatureActive: any = (featureId?: any) : any => typeof isFeatureActiveOverride === "function"
    ? isFeatureActiveOverride(featureId)
    : contextIsFeatureActive(featureId);

  function protocolPayload(requestBody?: any, url: any = null) : any {
    if (requestBody?.length > 0) {
      return parseJsonBody(requestBody);
    }
    return url ? Object.fromEntries(url.searchParams.entries()) : {};
  }

  function queryPayload(url: any = null) : any {
    if (!url) {
      return {};
    }
    const payload: Record<string, any> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        payload[key] = Array.isArray(payload[key]) ? [...payload[key], value] : [payload[key], value];
      } else {
        payload[key] = value;
      }
    }
    return payload;
  }

  function workspaceIdFrom(input: Record<string, any> = {}, fallback: any = "") : any {
    return String(input.workspaceId || input.workspace || fallback || "default").trim() || "default";
  }

  async function sendConsoleDomainOperation({
    operationId,
    input = {},
    response,
    context = {},
    errorMessage = "Console domain operation failed."
  }: Record<string, any>) : Promise<any> {
    try {
      const operationResult: any = await runConsoleDomainOperation({ operationId, input, context });
      if (
        operationId === "system.console_state" &&
        Number(operationResult.status || 200) < 400 &&
        response &&
        typeof response === "object"
      ) {
        response.__meshrixProofChangeProjection = consoleStateProofChangeProjection(operationResult.payload);
      }
      if (operationResult.payload?.__responseHandled) {
        return;
      }
      if (operationResult.payload?.__binaryResponse) {
        const disposition: any = operationResult.payload.disposition || "inline";
        const buffer: any = Buffer.isBuffer(operationResult.payload.buffer)
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
    } catch (error: any) {
      const declaredStatus: any = Number(error?.statusCode || error?.status || 0);
      const status: any = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
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

  async function runConsoleDomainOperation({ operationId, input = {}, context = {} }: Record<string, any>) : Promise<any> {
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
  }: Record<string, any> = {}) : Promise<any> {
    const provider: any = getToolSkillManagementProvider();
    if (!provider?.authorizeRequest) {
      return {
        ok: false,
        status: 503,
        reasonCode: "tool_authorization_unavailable",
        error: "Tool/Skill management provider is unavailable."
      };
    }
    const authorization: any = await provider.authorizeRequest({
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
    const grant: any = authorization.grant || {};
    const actor: Record<string, any> = {
      type: "tool-grant",
      userId: grant.id || "",
      subjectId: grant.id || "",
      username: grant.label || grant.id || "tool-grant",
      roleId: "tool-grant",
      tenantId: "local",
      scopes: Array.isArray(grant.scopes) ? grant.scopes : [],
      toolsets: Array.isArray(grant.toolsets) ? grant.toolsets : []
    };
    return {
      ...authorization,
      actor,
      authSession: { user: actor },
      revalidateAuthorization: async () : Promise<any> => {
        const currentAuthorization: any = await provider.authorizeRequest({
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

  async function verifyConsoleOrToolSkillExternalAuth({
    operation,
    request,
    input,
    requestBody = Buffer.alloc(0),
    url = null,
    method = "GET",
    phase = "",
    externalAuth = {}
  }: Record<string, any> = {}) : Promise<any> {
    const consoleAuthorizationOperation: any = (candidate?: any) : any =>
      candidate?.externalAuth === true
        ? Object.freeze({
            ...candidate,
            externalAuth: false
          })
        : candidate;
    const consoleAuthorization: any = await effectiveSecurityPermissions.authorizeOperation({
      request,
      operation: consoleAuthorizationOperation(operation),
      method,
      url,
      input,
      phase
    });
    if (consoleAuthorization?.ok === true && consoleAuthorization.session) {
      const authSession: any = consoleAuthorization.session;
      return {
        ...consoleAuthorization,
        actor: authSession.user || null,
        authSession,
        revalidateAuthorization: async (revalidation: Record<string, any> = {}) : Promise<any> =>
          effectiveSecurityPermissions.authorizeOperation({
            ...revalidation,
            request: revalidation.request || request,
            operation: consoleAuthorizationOperation(
              revalidation.operation || operation
            ),
            method: revalidation.method || method,
            url: revalidation.url || url,
            input: revalidation.input || input
          })
      };
    }
    return verifyToolSkillExternalAuth({
      request,
      requestBody,
      url,
      method,
      externalAuth
    });
  }

  const controller: Record<string, any> = {
    verifyToolSkillExternalAuth,
    verifyConsoleOrToolSkillExternalAuth,
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
      getStrategyManagementProvider: () : any => strategyManagementProvider,
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
      gatewayChannelRouter,
      jobWorkflowProvider,
      storageProvider,
      clientRegistryService,
      securityPermissions: effectiveSecurityPermissions,
      getToolSkillManagementProvider,
      getIntegrationTaskSupervisorSnapshot,
      consoleDomainServices
    }),
    ...createSystemControllerSettingsHandlers({
      sendConsoleDomainOperation,
      parseJsonBody,
      settingsContext
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
      getStrategyManagementProvider: () : any => strategyManagementProvider
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
