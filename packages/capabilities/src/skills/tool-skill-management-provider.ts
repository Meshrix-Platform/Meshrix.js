import {
  grantCanSeeTool,
  grantVisibleRisk,
  nowIso
} from "./tool-skill-management-provider-grant-utils.ts";
import {
  collectWorkspaces,
  executeToolPayload,
  inputMayNeedWorkspaceResolution,
  resolveWorkspaceReferencesInInput,
  sanitizeMcpOutputValue,
  valueContainsWorkspaceId,
  workspaceDirectoryFromWorkspaces
} from "./tool-skill-management-provider-workspace-projection.ts";
import {
  createDelegatedMcpGrantForPlatform,
  revokeDelegatedMcpGrantForPlatform
} from "./tool-skill-management-provider-delegated-mcp.ts";
import { authenticateMcpApiKey } from "./mcp-api-key-authentication.ts";
import { apiKeyAuthorizationEvaluationInput } from "../operation-permission-core/api-key-distribution.ts";

export const OPERATION_PERMISSION_FACADE_PROTOCOL_VERSION: any = "v0.0.1:operation-permission:facade-1";
const VISIBLE_TOOL_SNAPSHOT_SCHEMA: any = "v0.0.1:capabilities:visible-tool-snapshot-1";
const VISIBLE_TOOL_SNAPSHOT_CAPACITY: any = 8;
let visibleToolSnapshotBuildCount: any = 0;
let catalogEnumerationCount: any = 0;

export function getRefactorInstrumentation() : any {
  return {
    schemaVersion: VISIBLE_TOOL_SNAPSHOT_SCHEMA,
    snapshotBuildCount: visibleToolSnapshotBuildCount,
    catalogEnumerationCount: catalogEnumerationCount
  };
}

export function createToolSkillManagementProvider({
  operationPermissionPlatform,
  userDataPath = "",
  securityPermissions = operationPermissionPlatform?.securityPermissions || null,
  evaluateToolAudience = null,
  resolveAudiencePartitionKeys = null,
  resolveAudienceCatalogFacts = null,
  logger = null
}: Record<string, any> = {}) : any {
  const platform: any = operationPermissionPlatform;
  const visibleToolSnapshots: any = new Map<string, any>();

  function visibleToolSnapshot() : any {
    const current: any = requirePlatform();
    const catalog: any = current.catalog?.() || { tools: [] };
    const fingerprint: any = String(catalog?.fingerprint || "").trim();
    let snapshot: any = fingerprint ? visibleToolSnapshots.get(fingerprint) : null;
    if (!snapshot) {
      const tools: any[] = Array.isArray(catalog?.tools) ? catalog.tools : [];
      catalogEnumerationCount += 1;
      const toolsById: any = new Map<any, any>(
        tools.map((tool?: any) : any => [tool?.id, tool])
      );
      const activeTools: any[] = tools.filter((tool?: any) : any => tool?.status === "active");
      snapshot = Object.freeze({
        revision: fingerprint,
        toolsById,
        activeTools: Object.freeze(activeTools)
      });
      visibleToolSnapshotBuildCount += 1;
      if (fingerprint) {
        visibleToolSnapshots.set(fingerprint, snapshot);
        if (visibleToolSnapshots.size > VISIBLE_TOOL_SNAPSHOT_CAPACITY) {
          visibleToolSnapshots.delete(visibleToolSnapshots.keys().next().value);
        }
      }
    }
    return snapshot;
  }

  async function loadMcpWorkspaceDirectory({ request, context = {}, signal = null }: Record<string, any>) : Promise<any> {
    const result: any = await executeTool({
      toolId: "meshrix.agentWorkspace.list",
      input: {},
      request,
      context: {
        ...context,
        transport: "mcp",
        internalPurpose: "workspace-reference-resolution"
      },
      signal
    });
    if (!result.ok) {
      return workspaceDirectoryFromWorkspaces([]);
    }
    return workspaceDirectoryFromWorkspaces(collectWorkspaces(executeToolPayload(result)));
  }

  function requirePlatform() : any {
    if (!platform) {
      throw new Error("Operation Permission provider is not connected to Operation Permission platform.");
    }
    return platform;
  }

  async function authorizeRequest({
    request,
    requiredScopes = [],
    recordUse = true,
    requestBody = Buffer.alloc(0),
    url = null,
    method = "GET"
  }: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (!current.store?.authorizeRequest) {
      return {
        ok: false,
        status: 503,
        error: "Operation Permission authorization is unavailable."
      };
    }
    const apiKeyAuthorization: any = await authenticateMcpApiKey({
      request,
      requestBody,
      url,
      method,
      apiKeyDistributionProvider: current.apiKeyDistributionProvider,
      securityPermissions: current.securityPermissions || securityPermissions
    });
    if (apiKeyAuthorization.handled) {
      if (!apiKeyAuthorization.ok) return apiKeyAuthorization;
      try {
        const evaluation: any = apiKeyAuthorizationEvaluationInput(apiKeyAuthorization.apiKeyAuthorization);
        return Object.freeze({
          ...apiKeyAuthorization,
          restriction: evaluation.restriction,
          subject: evaluation.subject
        });
      } catch {
        return {
          handled: true,
          ok: false,
          status: 503,
          reasonCode: "api_key_authority_unavailable",
          error: "API key authorization evaluation is unavailable."
        };
      }
    }
    const authorization: any = await current.store.authorizeRequest({
      request,
      requiredScopes,
      recordUse,
      requestBody,
      url,
      method
    });
    if (!authorization.ok && typeof current.securityPermissions?.appendDecision === "function") {
      await current.securityPermissions.appendDecision({
        decisionId: `authz_mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        traceId: request?.__meshrixTraceContext?.traceId || request?.__meshrixRequestId || "",
        operationId: "mcp.request",
        toolId: "",
        grantId: authorization.grant?.id || "",
        subject: authorization.grant
          ? {
              type: "tool-grant",
              subjectId: authorization.grant.id,
              username: authorization.grant.label || authorization.grant.id,
              scopes: authorization.grant.scopes || []
            }
          : {
              type: "anonymous",
              subjectId: "",
              scopes: []
            },
        resource: {
          operationId: "mcp.request",
          toolId: "",
          risk: "read_only"
        },
        action: "mcp.authorize",
        effect: "deny",
        allowed: false,
        reasonCode: authorization.reasonCode || "mcp_authorization_denied",
        redactedReason: authorization.error || "MCP authorization denied.",
        requiredScopes,
        missingScopes: authorization.missingScopes || [],
        evaluatedLayers: ["mcp_token_authorization"],
        createdAt: nowIso()
      });
    }
    return authorization;
  }

  async function authorizeMcpClientRequest(input: Record<string, any> = {}) : Promise<any> {
    const authorization: any = await authorizeRequest(input);
    if (!authorization?.ok) return authorization;
    if (authorization.credentialKind === "scoped_api_key") {
      // The API Key authorization returned by the store is flat (policy,
      // keyId, workloadPrincipalId, organizationNodeId, policyFingerprint).
      // MCP consumers (listVisibleTools, listVisibleUpstreamMcpTools, and the
      // evaluateToolAudience injection) expect apiKeyAuthorization and a
      // restriction/subject projection, so attach them here.
      const policy: any = authorization.policy || {};
      const restriction: any = Object.freeze({
        credentialKind: "scoped_api_key",
        credentialId: String(authorization.keyId || ""),
        policyFingerprint: String(authorization.policyFingerprint || ""),
        toolsets: Object.freeze([...(policy.toolsetIds || [])]),
        scopes: Object.freeze([...(policy.scopeIds || [])]),
        capabilities: Object.freeze([...(policy.capabilityIds || [])]),
        dynamicCapabilities: Object.freeze([...(policy.capabilityIds || [])]),
        maxRisk: API_KEY_MAXIMUM_RISK_TO_GRANT_RISK[String(policy.maximumRisk || "")] || "read_only",
        allowedServiceIds: Object.freeze([...(policy.serviceIds || [])]),
        allowedSecretBindings: Object.freeze([...(policy.resources?.secretBindingIds || [])])
      });
      const subject: any = Object.freeze({
        type: "scoped-api-key",
        subjectId: String(authorization.workloadPrincipalId || ""),
        organizationNodeId: String(authorization.organizationNodeId || ""),
        scopes: restriction.scopes,
        capabilities: restriction.capabilities,
        maxRisk: restriction.maxRisk
      });
      return Object.freeze({
        ...authorization,
        ok: true,
        handled: true,
        apiKeyAuthorization: authorization,
        restriction,
        subject
      });
    }
    if (String(authorization.grant?.type || "") === "delegated-mcp-child") return authorization;
    return {
      handled: true,
      ok: false,
      status: 403,
      reasonCode: "mcp_api_key_required",
      error: "MCP client access requires a scoped API key."
    };
  }

  async function revalidateApiKeyAuthorization(authorization: any = null) : Promise<any> {
    const current: any = requirePlatform();
    if (typeof current.apiKeyDistributionProvider?.revalidateAuthorization !== "function") {
      return {
        ok: false,
        status: 503,
        reasonCode: "api_key_authority_unavailable",
        error: "API key lifecycle revalidation is unavailable."
      };
    }
    try {
      const next: any = await Promise.resolve(
        current.apiKeyDistributionProvider.revalidateAuthorization(authorization)
      );
      return { ok: true, apiKeyAuthorization: next };
    } catch (error: any) {
      return {
        ok: false,
        status: Number(error?.status || error?.statusCode || 403),
        reasonCode: String(error?.reasonCode || error?.code || "api_key_revision_stale"),
        error: String(error?.publicMessage || "API key lifecycle changed before the effect.")
      };
    }
  }

  async function authorizeApiKeyOperation({ authorization = null, operation = null }: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (typeof current.apiKeyDistributionProvider?.authorizeOperation !== "function") {
      return { ok: false, status: 503, reasonCode: "api_key_authority_unavailable" };
    }
    try {
      const next: any = await Promise.resolve(
        current.apiKeyDistributionProvider.authorizeOperation({ authorization, operation })
      );
      return { ok: true, apiKeyAuthorization: next };
    } catch (error: any) {
      return {
        ok: false,
        status: Number(error?.status || error?.statusCode || 403),
        reasonCode: String(error?.reasonCode || error?.code || "api_key_policy_denied")
      };
    }
  }

  function visibleGrantSummary({ authorization = null }: Record<string, any> = {}) : any {
    const apiKeyAuthorization: any = authorization?.apiKeyAuthorization || null;
    if (authorization?.credentialKind === "scoped_api_key" && apiKeyAuthorization) {
      return {
        credentialKind: "scoped_api_key",
        principal: "workload-hidden",
        toolsets: apiKeyAuthorization.policy?.toolsetIds || [],
        scopes: apiKeyAuthorization.policy?.scopeIds || [],
        maxRisk: apiKeyAuthorization.policy?.maximumRisk || ""
      };
    }
    const grant: any = authorization?.grant || null;
    return {
      id: grant ? "grant-hidden" : "",
      label: grant?.label || "",
      toolsets: grant?.toolsets || [],
      scopes: grant?.scopes || [],
      maxRisk: grantVisibleRisk(grant)
    };
  }

  function audiencePartitionKeys({ authorization = null }: Record<string, any> = {}) : any {
    const grantId: any = String(authorization?.credentialKind === "scoped_api_key"
      ? authorization?.apiKeyAuthorization?.workloadPrincipalId
      : authorization?.grant?.id || "").trim();
    if (!grantId || typeof resolveAudiencePartitionKeys !== "function") return [];
    const keys: any = resolveAudiencePartitionKeys(grantId);
    return [...new Set<any>((Array.isArray(keys) ? keys : []).map((key?: any) : any => String(key || "").trim()).filter(Boolean))].sort();
  }

  function audienceCatalogFacts({ authorization = null }: Record<string, any> = {}) : any {
    const grantId: any = String(authorization?.credentialKind === "scoped_api_key"
      ? authorization?.apiKeyAuthorization?.workloadPrincipalId
      : authorization?.grant?.id || "").trim();
    if (!grantId || typeof resolveAudienceCatalogFacts !== "function") return null;
    const facts: any = resolveAudienceCatalogFacts(grantId);
    if (!facts || typeof facts !== "object") return null;
    const sourceRevision: any = Number(facts.sourceRevision);
    const audienceRevision: any = Number(facts.audienceRevision);
    const catalogRevision: any = String(facts.catalogRevision || "").trim();
    const partitionKeys: any = [...new Set<any>((facts.partitionKeys || [])
      .map((key?: any) : any => String(key || "").trim())
      .filter(Boolean))].sort();
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 ||
        !Number.isSafeInteger(audienceRevision) || audienceRevision < 0 ||
        !catalogRevision || partitionKeys.length === 0) return null;
    return Object.freeze({ sourceRevision, catalogRevision, audienceRevision, partitionKeys });
  }

  function listVisibleTools({ authorization = null }: Record<string, any> = {}) : any {
    const snapshot: any = visibleToolSnapshot();
    const grant: any = authorization?.grant || null;
    const apiKeyAuthorization: any = authorization?.credentialKind === "scoped_api_key"
      ? authorization.apiKeyAuthorization
      : null;
    return snapshot.activeTools
      .filter((tool?: any) : any => apiKeyAuthorization
        ? apiKeyCanSeeTool(tool, apiKeyAuthorization)
        : !grant || grantCanSeeTool(tool, grant))
      .filter((tool?: any) : any => tool.upstreamProjectedOperation !== true ||
        evaluateToolAudience?.({
          authorization,
          apiKeyAuthorization,
          restriction: authorization?.restriction || null,
          subject: authorization?.subject || null,
          grant,
          tool,
          purpose: "discovery"
        })?.allowed === true);
  }

  function resolveActiveTool(toolId: unknown): unknown {
    const tool = (visibleToolSnapshot().toolsById.get(String(toolId || "")) || null) as { status?: unknown } | null;
    return tool?.status === "active" ? tool : null;
  }

  async function executeTool({ toolId, input = {}, request = null, authorization = null, context = {}, dryRun = false, signal = null }: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (!current.runtime?.executeTool) {
      return {
        ok: false,
        status: 503,
        payload: {
          error: {
            code: "tool_runtime_unavailable",
            message: "Tool execution runtime is unavailable."
          }
        }
      };
    }
    const snapshot: any = visibleToolSnapshot();
    const tool: any = snapshot.toolsById.get(String(toolId || "")) ||
      current.registry?.getTool?.(toolId) ||
      null;
    const contextualCapability: any = context?.dynamicCapability && typeof context.dynamicCapability === "object" && !Array.isArray(context.dynamicCapability)
      ? context.dynamicCapability
      : null;
    if (tool?.upstreamProjectedOperation === true) {
      const grant: any = authorization?.grant || null;
      const apiKeyAuthorization: any = authorization?.credentialKind === "scoped_api_key"
        ? authorization.apiKeyAuthorization
        : null;
      const audienceTool: any = contextualCapability
        ? {
            ...tool,
            serviceId: contextualCapability.serviceId,
            requiredScopes: contextualCapability.requiredScopes,
            toolsets: contextualCapability.toolsets,
            risk: contextualCapability.risk,
            resourceContext: contextualCapability.resourceContext,
            dynamicCapability: contextualCapability
          }
        : tool;
      const audienceDecision: any = evaluateToolAudience?.({
        authorization,
        apiKeyAuthorization,
        restriction: authorization?.restriction || null,
        subject: authorization?.subject || null,
        grant,
        tool: audienceTool,
        purpose: "execution"
      }) || null;
      if ((!grant && !apiKeyAuthorization) || audienceDecision?.allowed !== true) {
        return {
          ok: false,
          status: 403,
          payload: {
            error: {
              code: "upstream_audience_denied",
              message: "The upstream operation is not available for this grant."
            }
          }
        };
      }
    }
    const dynamicCapability: any = contextualCapability || (
      tool?.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
        ? tool.dynamicCapability
        : null
    );
    return current.runtime.executeTool({
      toolId,
      input,
      request,
      apiKeyAuthorization: authorization?.credentialKind === "scoped_api_key"
        ? authorization.apiKeyAuthorization
        : null,
      context: dynamicCapability
        ? {
            ...context,
            requestedScopes: dynamicCapability.requiredScopes || [],
            requestedCapabilities: [dynamicCapability.capabilityId],
            dynamicCapability,
            resourceContext: dynamicCapability.resourceContext || {},
            upstreamTool: {
              toolName: dynamicCapability.upstreamToolName || tool.id,
              serviceId: dynamicCapability.serviceId || "",
              operationKey: dynamicCapability.operationKey || "",
              risk: dynamicCapability.risk || "",
              capabilityId: dynamicCapability.capabilityId || ""
            }
          }
        : context,
      dryRun,
      signal
    });
  }

  async function resolveMcpWorkspaceInput({ input, request, context = {}, signal = null }: Record<string, any> = {}) : Promise<any> {
    if (!inputMayNeedWorkspaceResolution(input)) {
      return { input, workspaceDirectory: null };
    }
    const workspaceDirectory: any = await loadMcpWorkspaceDirectory({ request, context, signal });
    return {
      input: resolveWorkspaceReferencesInInput(input, workspaceDirectory),
      workspaceDirectory
    };
  }

  async function publicMcpToolPayload({ payload, workspaceDirectory, request, context = {}, signal = null }: Record<string, any> = {}) : Promise<any> {
    const workspaces: any = collectWorkspaces(payload);
    let directory: any = workspaces.length ? workspaceDirectoryFromWorkspaces(workspaces) : workspaceDirectory;
    if (!directory && valueContainsWorkspaceId(payload)) {
      directory = await loadMcpWorkspaceDirectory({ request, context, signal });
    }
    return sanitizeMcpOutputValue(payload, directory || workspaceDirectoryFromWorkspaces([]));
  }

  async function createDelegatedMcpGrant(input: Record<string, any> = {}) : Promise<any> {
    return createDelegatedMcpGrantForPlatform(requirePlatform(), input);
  }

  async function revokeDelegatedMcpGrant(input: Record<string, any> = {}) : Promise<any> {
    return revokeDelegatedMcpGrantForPlatform(requirePlatform(), input);
  }

  async function handleOperationPermissionHttpRequest(input: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (!current.router?.handleOperationPermissionHttpRequest) {
      return false;
    }
    return current.router.handleOperationPermissionHttpRequest(input);
  }

  return Object.freeze({
    protocolVersion: OPERATION_PERMISSION_FACADE_PROTOCOL_VERSION,
    describe() : any {
      return {
        schemaVersion: "v0.0.1:schema:definition-1",
        protocolVersion: OPERATION_PERMISSION_FACADE_PROTOCOL_VERSION,
        capabilities: [
          "tool_catalog",
          "tool_grants",
          "tool_execution",
          "mcp_delegated_child_grant",
          "mcp_workspace_reference_projection"
        ]
      };
    },
    authorizeRequest,
    authorizeMcpClientRequest,
    revalidateApiKeyAuthorization,
    authorizeApiKeyOperation,
    visibleGrantSummary,
    audiencePartitionKeys,
    audienceCatalogFacts,
    listVisibleTools,
    resolveActiveTool,
    executeTool,
    resolveMcpWorkspaceInput,
    publicMcpToolPayload,
    createDelegatedMcpGrant,
    revokeDelegatedMcpGrant,
    handleOperationPermissionHttpRequest,
    getRefactorInstrumentation
  });
}

const API_KEY_RISK_RANK: Readonly<Record<string, any>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

const API_KEY_MAXIMUM_RISK_RANK: Readonly<Record<string, any>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2
});

const API_KEY_MAXIMUM_RISK_TO_GRANT_RISK: Readonly<Record<string, any>> = Object.freeze({
  low: "read_only",
  medium: "safe_write",
  high: "repair_write"
});

function apiKeyCanSeeTool(tool: any = null, authorization: any = null) : any {
  const policy: any = authorization?.policy;
  if (!tool || tool.status !== "active" || !policy || policy.protocol !== "mcp") return false;
  const toolId: any = String(tool.id || "");
  const dynamicCapability: any = tool.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
    ? tool.dynamicCapability
    : null;
  if (!dynamicCapability && (policy.deniedTools || []).includes(toolId)) return false;
  const requiredScopes: any[] = Array.isArray(tool.requiredScopes) ? tool.requiredScopes : [];
  const toolsets: any[] = Array.isArray(tool.toolsets) ? tool.toolsets : [];
  const toolsetDenied: any = dynamicCapability
    ? toolsets.length === 0 || !toolsets.some((toolset?: any) : any => (policy.toolsetIds || []).includes(toolset))
    : toolsets.some((toolset?: any) : any => !(policy.toolsetIds || []).includes(toolset));
  if (requiredScopes.some((scope?: any) : any => !(policy.scopeIds || []).includes(scope)) || toolsetDenied) return false;
  const serviceId: any = String(tool.serviceId || dynamicCapability?.serviceId || "");
  const capabilityId: any = String(dynamicCapability?.capabilityId || "");
  if (dynamicCapability && (!capabilityId || !(policy.capabilityIds || []).includes(capabilityId))) return false;
  if (serviceId && (policy.serviceIds || []).length > 0 && !(policy.serviceIds || []).includes(serviceId)) return false;
  const positiveAuthority: any = (policy.allowedTools || []).includes(toolId) ||
    (serviceId && (policy.serviceIds || []).includes(serviceId)) ||
    (capabilityId && (policy.capabilityIds || []).includes(capabilityId)) ||
    toolsets.some((toolset?: any) : any => (policy.toolsetIds || []).includes(toolset)) ||
    requiredScopes.some((scope?: any) : any => (policy.scopeIds || []).includes(scope));
  if (!positiveAuthority) return false;
  const toolRiskRank: any = API_KEY_RISK_RANK[String(tool.risk || "read_only")];
  const maximumRiskRank: any = API_KEY_MAXIMUM_RISK_RANK[String(policy.maximumRisk || "")];
  if (!Number.isInteger(toolRiskRank) || !Number.isInteger(maximumRiskRank) || toolRiskRank > maximumRiskRank) return false;
  if (policy.resources?.mode === "restricted") {
    const resource: any = tool.resourceContext || dynamicCapability?.resourceContext || {};
    const checks: any[] = [
      [resource.workspaceId, policy.resources.workspaceIds],
      [resource.dataClassification, policy.resources.dataClassifications],
      [resource.egressClass, policy.resources.egressClasses],
      [resource.semanticFamily, policy.resources.semanticFamilies],
      [resource.capabilityDomain, policy.resources.capabilityDomains],
      [resource.capabilityVerb, policy.resources.capabilityVerbs],
      [resource.resourceKind, policy.resources.resourceKinds],
      [resource.effectKind, policy.resources.effectKinds],
      [resource.secretBindingId, policy.resources.secretBindingIds],
      [resource.origin, policy.resources.allowedOrigins]
    ];
    const configuredChecks: any[] = checks.filter(([, allowed]: any[]) : any => Array.isArray(allowed) && allowed.length > 0);
    const suppliedChecks: any[] = configuredChecks.filter(([fact]: any[]) : any => Boolean(fact));
    if (configuredChecks.length === 0 ||
        suppliedChecks.some(([fact, allowed]: any[]) : any => !allowed.includes(fact)) ||
        !suppliedChecks.some(([fact, allowed]: any[]) : any => allowed.includes(fact))) return false;
  }
  return true;
}
