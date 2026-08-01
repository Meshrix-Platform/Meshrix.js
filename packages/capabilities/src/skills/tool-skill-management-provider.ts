import {
  grantMetadata,
  normalizeGrantTargets,
  normalizeGrantValues,
  normalizedGrantTargetKeys,
  normalizedTargetKey,
  nowIso
} from "./tool-skill-management-provider-grant-utils.ts";
import {
  LOCAL_GRANT_PRIORITY_TARGETS,
  LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES,
  LOCAL_MCP_AUTHORIZATION_REQUEST_TTL_MS,
  LOCAL_MCP_AUTHORIZATION_REPLAY_TTL_MS,
  authorizeLocalGrantIssuance,
  denyLocalGrant,
  grantCanSeeTool,
  grantVisibleRisk,
  isDirectMcpClientRequest,
  isLocalMcpGrant,
  isLocalMcpAuthorizationClaimHash,
  isLocalMcpPairingRequest,
  localGrantConnectorMetadata,
  localGrantMatchedTargetDetails,
  localGrantRiskRank,
  localGrantSharedHubContract,
  localGrantSupportedTargetDetails,
  localGrantSupportedTargets,
  localGrantTargetMatch,
  localMcpAuthorizationVerificationCode,
  localMcpProcessKeyFingerprint,
  localMcpGrantTargetKeys,
  localMcpGrantTargets,
  mcpGrantClientRows,
  hashLocalMcpAuthorizationClaim,
  normalizeLocalMcpProcessIdentityRequest,
  normalizeApiKeyHeader,
  openLocalMcpAuthorizationReplay,
  parseRequestBody,
  requestedLocalGrantMaxRisk,
  sealLocalMcpAuthorizationReplay
} from "./tool-skill-management-provider-local-mcp.ts";
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

export const OPERATION_PERMISSION_FACADE_PROTOCOL_VERSION: any = "v0.0.1:operation-permission:facade-1";

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
    normalizeApiKeyHeader(request);
    const authorization: any = await current.store.authorizeRequest({
      request,
      requiredScopes,
      recordUse,
      requestBody,
      url,
      method
    });
    if (!authorization.ok && typeof current.securityPermissions?.appendDecision === "function") {
      current.securityPermissions.appendDecision({
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

  function visibleGrantSummary({ authorization = null }: Record<string, any> = {}) : any {
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
    const grantId: any = String(authorization?.grant?.id || "").trim();
    if (!grantId || typeof resolveAudiencePartitionKeys !== "function") return [];
    const keys: any = resolveAudiencePartitionKeys(grantId);
    return [...new Set<any>((Array.isArray(keys) ? keys : []).map((key?: any) : any => String(key || "").trim()).filter(Boolean))].sort();
  }

  function audienceCatalogFacts({ authorization = null }: Record<string, any> = {}) : any {
    const grantId: any = String(authorization?.grant?.id || "").trim();
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
    const current: any = requirePlatform();
    const catalog: any = current.catalog?.() || { tools: [] };
    const grant: any = authorization?.grant || null;
    return (catalog.tools || [])
      .filter((tool?: any) : any => tool.status === "active")
      .filter((tool?: any) : any => !grant || grantCanSeeTool(tool, grant))
      .filter((tool?: any) : any => tool.upstreamProjectedOperation !== true ||
        evaluateToolAudience?.({ grant, tool, purpose: "discovery" })?.allowed === true);
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
    const tool: any = current.registry?.getTool?.(toolId) || null;
    const contextualCapability: any = context?.dynamicCapability && typeof context.dynamicCapability === "object" && !Array.isArray(context.dynamicCapability)
      ? context.dynamicCapability
      : null;
    if (tool?.upstreamProjectedOperation === true) {
      const grant: any = authorization?.grant || null;
      const audienceTool: any = contextualCapability
        ? {
            ...tool,
            serviceId: contextualCapability.serviceId || tool.serviceId,
            requiredScopes: contextualCapability.requiredScopes || context.requestedScopes || tool.requiredScopes,
            toolsets: contextualCapability.toolsets || tool.toolsets,
            risk: contextualCapability.risk || tool.risk,
            dynamicCapability: contextualCapability
          }
        : tool;
      const audienceDecision: any = evaluateToolAudience?.({ grant, tool: audienceTool, purpose: "execution" }) || null;
      if (!grant || audienceDecision?.allowed !== true) {
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
      context: dynamicCapability
        ? {
            ...context,
            requestedScopes: tool.requiredScopes || context.requestedScopes || [],
            requestedCapabilities: [dynamicCapability.capabilityId],
            dynamicCapability,
            resourceContext: tool.resourceContext || dynamicCapability.resourceContext || {},
            upstreamTool: {
              toolName: tool.id,
              serviceId: tool.serviceId || dynamicCapability.serviceId || "",
              operationKey: tool.operationKey || dynamicCapability.operationKey || "",
              risk: tool.risk || dynamicCapability.risk || "",
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

  function localGrantProcessIdentityRequestForTarget(body: Record<string, any> = {}, target: any = "", targetCount: any = 1) : any {
    const targetKey: any = normalizedTargetKey(target);
    const processIdentities: any = body.processIdentities && typeof body.processIdentities === "object" && !Array.isArray(body.processIdentities)
      ? body.processIdentities
      : {};
    const targetIdentity: any = processIdentities[target] || processIdentities[targetKey] || null;
    if (targetIdentity && typeof targetIdentity === "object" && !Array.isArray(targetIdentity)) {
      return normalizeLocalMcpProcessIdentityRequest(targetIdentity);
    }
    if (targetCount === 1 && body.processIdentity && typeof body.processIdentity === "object" && !Array.isArray(body.processIdentity)) {
      return normalizeLocalMcpProcessIdentityRequest(body.processIdentity);
    }
    return {};
  }

  function hasProcessIdentityPublicKey(processIdentityRequest: Record<string, any> = {}) : any {
    return Boolean(
      processIdentityRequest.processPublicKeyPem ||
        processIdentityRequest.processPublicKeySpkiBase64 ||
        processIdentityRequest.publicKeyPem ||
        processIdentityRequest.publicKeySpkiBase64
    );
  }

  function localGrantLabelForTarget(body: Record<string, any> = {}, target: any = "", targetCount: any = 1) : any {
    const provided: any = String(body.label || "").trim().slice(0, 256);
    if (provided && targetCount <= 1) {
      return provided;
    }
    if (provided) {
      return `${provided} (${target})`;
    }
    return `Meshrix MCP ${target || "local agent"}`;
  }

  function grantValuesFitByteLimit(values: any = [], maxBytes: any = 512) : any {
    return values.every((value?: any) : any => Buffer.byteLength(String(value || ""), "utf8") <= maxBytes);
  }

  async function issueLocalMcpGrantForTarget({
    current,
    body,
    target,
    targetCount,
    processIdentityRequest,
    requestedToolsets,
    requestedScopes,
    toolAllow,
    toolDeny,
    allowedWorkspaceIds,
    dynamicCapabilities,
    allowedServiceIds,
    allowedSecretBindings,
    hasExplicitGrantRequest,
    discoveryState
  }: Record<string, any>) : Promise<any> {
    const targetMatch: any = localGrantTargetMatch([target]);
    const effectiveToolsets: any = hasExplicitGrantRequest ? requestedToolsets : targetMatch.toolsets;
    const resolved: any = current.registry.resolveToolset({
      toolsets: effectiveToolsets,
      toolAllow,
      toolDeny,
      scopes: requestedScopes
    });
    const identityIssued: any = await securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage({
      input: {
        ...processIdentityRequest,
        clientId: processIdentityRequest.clientId || normalizedTargetKey(target || ""),
        installationId: processIdentityRequest.installationId || `${normalizedTargetKey(target || "mcp")}-local-install`,
        nonce: processIdentityRequest.nonce || ""
      }
    });
    if (!identityIssued.ok || !identityIssued.clientIdentityPackage) {
      return {
        ok: false,
        response: denyLocalGrant(
          identityIssued.status || 400,
          identityIssued.reasonCode || "process_identity_issue_failed",
          identityIssued.error || "Local MCP process identity package could not be issued.",
          { target }
        )
      };
    }
    const targets: any[] = [target];
    let result: any;
    try {
      result = await current.store.createGrant({
      label: localGrantLabelForTarget(body, target, targetCount),
      type: "machine",
      toolsets: resolved.toolsets,
      scopes: resolved.requiredScopes,
      allowedWorkspaceIds,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      toolAllow,
      toolDeny,
      metadata: {
        issuedBy: "meshrix-mcp-local-pairing",
        connectorVersion: String(body.connectorVersion || "").trim().slice(0, 128),
        autoUpdate: Boolean(body.autoUpdate),
        authorizationBatchTargetCount: targetCount,
        authorizationBatchSinglePrompt: targetCount > 1,
        targets,
        clientTarget: target || "",
        mcpTarget: target || "",
        clientId: normalizedTargetKey(target || ""),
        processIdentityRequired: true,
        processIdentityPackageId: identityIssued.clientIdentityPackage.packageId || "",
        processIdentityProcessKeyId: identityIssued.clientIdentityPackage.processKey?.processKeyId || "",
        processIdentityClientId: identityIssued.clientIdentityPackage.clientId || "",
        targetMatch: targetMatch.matched,
        matchedTargets: targetMatch.matchedTargets,
        unmatchedTargets: targetMatch.unmatchedTargets,
        agentProfileId: String(body.agentProfileId || body.agent_profile_id || targetMatch.agentProfileId || "")
          .trim()
          .slice(0, 256),
        allowedWorkspaceIds,
        dynamicCapabilities,
        allowedServiceIds,
        allowedSecretBindings,
        serverId: discoveryState?.serverId || "",
        identityKeyId: discoveryState?.mcpIdentity?.keyId || "",
        maxRisk: resolved.maxRisk || "read_only"
      },
      reason: targetCount > 1
        ? "Issued by batched local Meshrix MCP connector pairing."
        : "Issued by local Meshrix MCP connector pairing."
      });
    } catch (error: any) {
      await securityPermissions.processIdentity.revokeIssuedLocalMcpClientIdentityPackage({
        clientIdentityPackage: identityIssued.clientIdentityPackage,
        reason: "local_mcp_grant_create_failed"
      });
      throw error;
    }
    return {
      ok: true,
      payload: {
        target,
        grant: result.grant,
        token: result.token,
        processIdentity: {
          protocolVersion: identityIssued.protocolVersion,
          serverIdentity: identityIssued.serverIdentity,
          clientIdentityPackage: identityIssued.clientIdentityPackage
        },
        tokenPrefix: result.grant.tokenPrefix,
        toolsets: resolved.toolsets,
        scopes: resolved.requiredScopes,
        maxRisk: resolved.maxRisk,
        targets
      }
    };
  }

  function localMcpPairingDenied(message: any = "MCP local pairing is only available from the local machine.") : any {
    return denyLocalGrant(403, "local_pairing_required", message);
  }

  function prepareLocalMcpGrantRequest(body: Record<string, any> = {}) : any {
    const current: any = requirePlatform();
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES) {
      return {
        ok: false,
        response: denyLocalGrant(
          413,
          "local_grant_request_too_large",
          "MCP local grant request is too large."
        )
      };
    }
    const targets: any = normalizeGrantTargets(body.targets || body.target || body.clientId);
    if (targets.length === 0) {
      return {
        ok: false,
        response: denyLocalGrant(400, "mcp_targets_required", "MCP local grants require at least one target client.", {
          targets
        })
      };
    }
    const requestedToolsets: any = normalizeGrantValues(body.toolsets || body.toolsetIds || body.toolset || []);
    const requestedScopes: any = normalizeGrantValues(body.scopes || body.scopeIds || body.scope || []);
    const toolAllow: any = normalizeGrantValues(body.toolAllow || body.tool_allow || []);
    const toolDeny: any = normalizeGrantValues(body.toolDeny || body.tool_deny || []);
    const allowedWorkspaceIds: any = normalizeGrantValues(body.allowedWorkspaceIds || body.workspaceIds || body.workspaceId || []);
    const dynamicCapabilities: any = normalizeGrantValues(body.dynamicCapabilities || body.upstreamCapabilities || [], 512);
    const allowedServiceIds: any = normalizeGrantValues(body.allowedServiceIds || body.upstreamServiceIds || [], 512);
    const allowedSecretBindings: any = normalizeGrantValues(body.allowedSecretBindings || body.credentialBindingIds || [], 512);
    if (
      !grantValuesFitByteLimit(targets, 128) ||
      !grantValuesFitByteLimit(requestedToolsets, 256) ||
      !grantValuesFitByteLimit(requestedScopes, 256) ||
      !grantValuesFitByteLimit(toolAllow, 512) ||
      !grantValuesFitByteLimit(toolDeny, 512) ||
      !grantValuesFitByteLimit(allowedWorkspaceIds, 512) ||
      !grantValuesFitByteLimit(dynamicCapabilities, 512) ||
      !grantValuesFitByteLimit(allowedServiceIds, 512) ||
      !grantValuesFitByteLimit(allowedSecretBindings, 512)
    ) {
      return {
        ok: false,
        response: denyLocalGrant(
          400,
          "local_grant_field_too_large",
          "MCP local grant request contains an oversized identifier."
        )
      };
    }
    const targetMatch: any = localGrantTargetMatch(targets);
    const hasExplicitGrantRequest: any = requestedToolsets.length > 0 || requestedScopes.length > 0 || toolAllow.length > 0;
    const effectiveToolsets: any = hasExplicitGrantRequest ? requestedToolsets : targetMatch.toolsets;

    const resolved: any = current.registry.resolveToolset({
      toolsets: effectiveToolsets,
      toolAllow,
      toolDeny,
      scopes: requestedScopes
    });
    const toolsetsById: any = new Map<any, any>(current.registry.listToolsets().map((toolset?: any) : any => [toolset.id, toolset]));
    const blockedToolsets: any = resolved.toolsets.filter((toolsetId?: any) : any => toolsetsById.get(toolsetId)?.grantable === false);
    if (blockedToolsets.length > 0) {
      return {
        ok: false,
        response: denyLocalGrant(403, "toolset_not_grantable", "Requested MCP toolset is not grantable.", {
          toolsets: blockedToolsets
        })
      };
    }
    const requestedMaxRisk: any = requestedLocalGrantMaxRisk(body, resolved);
    if (
      !securityPermissions?.processIdentity?.issueLocalMcpClientIdentityPackage ||
      !securityPermissions?.processIdentity?.revokeIssuedLocalMcpClientIdentityPackage
    ) {
      return {
        ok: false,
        response: denyLocalGrant(
          503,
          "process_identity_unavailable",
          "Local MCP grants require process identity package issuance and rollback support."
        )
      };
    }
    const processIdentityRequests: any = new Map<any, any>();
    for (const target of targets) {
      let processIdentityRequest: any;
      try {
        processIdentityRequest = localGrantProcessIdentityRequestForTarget(body, target, targets.length);
      } catch (error: any) {
        return {
          ok: false,
          response: denyLocalGrant(
            400,
            error?.reasonCode || "process_identity_schema_invalid",
            error?.message || "MCP process identity request is invalid.",
            { target }
          )
        };
      }
      if (!hasProcessIdentityPublicKey(processIdentityRequest)) {
        return {
          ok: false,
          response: denyLocalGrant(
            400,
            "process_identity_client_key_required",
            "Local MCP grants require a process identity public key for every target client.",
            { target, targets }
          )
        };
      }
      processIdentityRequests.set(target, processIdentityRequest);
    }
    return {
      ok: true,
      current,
      body,
      targets,
      requestedToolsets,
      requestedScopes,
      toolAllow,
      toolDeny,
      allowedWorkspaceIds,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      targetMatch,
      hasExplicitGrantRequest,
      resolved,
      requestedMaxRisk,
      processIdentityRequests
    };
  }

  function canonicalLocalMcpGrantBody(prepared?: any) : any {
    return {
      targets: prepared.targets,
      label: String(prepared.body.label || "").trim().slice(0, 256),
      connectorVersion: String(prepared.body.connectorVersion || "").trim().slice(0, 128),
      autoUpdate: prepared.body.autoUpdate === true,
      grantMode: String(prepared.body.grantMode || prepared.body.grant_mode || prepared.body.mode || "").trim().slice(0, 64),
      maxRisk: String(prepared.body.maxRisk || prepared.body.max_risk || "").trim().slice(0, 64),
      agentProfileId: String(prepared.body.agentProfileId || prepared.body.agent_profile_id || "").trim().slice(0, 256),
      toolsets: prepared.requestedToolsets,
      scopes: prepared.requestedScopes,
      toolAllow: prepared.toolAllow,
      toolDeny: prepared.toolDeny,
      allowedWorkspaceIds: prepared.allowedWorkspaceIds,
      dynamicCapabilities: prepared.dynamicCapabilities,
      allowedServiceIds: prepared.allowedServiceIds,
      allowedSecretBindings: prepared.allowedSecretBindings,
      processIdentities: Object.fromEntries(
        prepared.targets.map((target?: any) : any => [target, prepared.processIdentityRequests.get(target)])
      )
    };
  }

  async function rollbackIssuedLocalMcpGrants(current?: any, issued: any = []) : Promise<any> {
    for (const item of [...issued].reverse()) {
      try {
        await current.store.revokeGrant(item.grant?.id, "local_mcp_authorization_batch_rolled_back");
      } catch (error: any) {
        logger?.warn?.("mcp.local_grant.rollback_grant.failed", {
          reasonCode: "grant_rollback_failed",
          errorType: error?.name || "Error"
        });
      }
      try {
        await securityPermissions.processIdentity.revokeIssuedLocalMcpClientIdentityPackage({
          clientIdentityPackage: item.processIdentity?.clientIdentityPackage,
          reason: "local_mcp_authorization_batch_rolled_back"
        });
      } catch (error: any) {
        logger?.warn?.("mcp.local_grant.rollback_identity.failed", {
          reasonCode: "process_identity_rollback_failed",
          errorType: error?.name || "Error"
        });
      }
    }
  }

  async function issuePreparedLocalMcpGrant(prepared?: any, { request = null, discoveryState = null }: Record<string, any> = {}) : Promise<any> {
    const {
      current,
      body,
      targets,
      requestedToolsets,
      requestedScopes,
      toolAllow,
      toolDeny,
      allowedWorkspaceIds,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings,
      targetMatch,
      hasExplicitGrantRequest,
      processIdentityRequests
    } = prepared;
    const issued: any[] = [];
    try {
      for (const target of targets) {
        const grantIssued: any = await issueLocalMcpGrantForTarget({
          current,
          body,
          target,
          targetCount: targets.length,
          processIdentityRequest: processIdentityRequests.get(target),
          requestedToolsets,
          requestedScopes,
          toolAllow,
          toolDeny,
          allowedWorkspaceIds,
          dynamicCapabilities,
          allowedServiceIds,
          allowedSecretBindings,
          hasExplicitGrantRequest,
          discoveryState
        });
        if (!grantIssued.ok) {
          await rollbackIssuedLocalMcpGrants(current, issued);
          return grantIssued.response;
        }
        issued.push(grantIssued.payload);
      }
    } catch (error: any) {
      await rollbackIssuedLocalMcpGrants(current, issued);
      throw error;
    }
    const primary: any = issued[0];
    const targetGrants: any = Object.fromEntries(issued.map((item?: any) : any => [item.target, item]));
    if (targets.length > 1) {
      return {
        status: 201,
        body: {
          ok: true,
          schemaVersion: "v0.0.1:schema:definition-1",
          batch: true,
          authorizationBatch: {
            singleAuthorizationRequest: true,
            perTargetGrantIsolation: true,
            targetCount: targets.length
          },
          targetGrants,
          grants: issued,
          targets,
          priorityTargets: [...LOCAL_GRANT_PRIORITY_TARGETS],
          supportedTargets: localGrantSupportedTargets(),
          supportedTargetDetails: localGrantSupportedTargetDetails(),
          connector: localGrantConnectorMetadata({ request, discoveryState }),
          sharedHub: localGrantSharedHubContract({ request, discoveryState }),
          targetMatch: {
            matched: targetMatch.matched,
            matchedTargets: targetMatch.matchedTargets,
            unmatchedTargets: targetMatch.unmatchedTargets,
            agentProfileId: targetMatch.agentProfileId,
            matchedTargetDetails: localGrantMatchedTargetDetails(targetMatch.matchedTargets)
          }
        }
      };
    }
    return {
      status: 201,
      body: {
        ok: true,
        schemaVersion: "v0.0.1:schema:definition-1",
        grant: primary.grant,
        token: primary.token,
        processIdentity: primary.processIdentity,
        tokenPrefix: primary.tokenPrefix,
        toolsets: primary.toolsets,
        scopes: primary.scopes,
        maxRisk: primary.maxRisk,
        targets,
        priorityTargets: [...LOCAL_GRANT_PRIORITY_TARGETS],
        supportedTargets: localGrantSupportedTargets(),
        supportedTargetDetails: localGrantSupportedTargetDetails(),
        connector: localGrantConnectorMetadata({ request, discoveryState }),
        sharedHub: localGrantSharedHubContract({ request, discoveryState }),
        targetMatch: {
          matched: targetMatch.matched,
          matchedTargets: targetMatch.matchedTargets,
          unmatchedTargets: targetMatch.unmatchedTargets,
          agentProfileId: targetMatch.agentProfileId,
          matchedTargetDetails: localGrantMatchedTargetDetails(targetMatch.matchedTargets)
        }
      }
    };
  }

  async function createLocalMcpGrant({ request, requestBody, discoveryState = null, url = null }: Record<string, any> = {}) : Promise<any> {
    if (!isLocalMcpPairingRequest(request)) {
      return localMcpPairingDenied("MCP local grant issuance is only available from the local machine.");
    }
    const body: any = parseRequestBody(requestBody);
    const prepared: any = prepareLocalMcpGrantRequest(body);
    if (!prepared.ok) {
      return prepared.response;
    }
    const authorizationDenied: any = await authorizeLocalGrantIssuance({
      request,
      url,
      securityPermissions,
      resolved: prepared.resolved,
      requestedMaxRisk: prepared.requestedMaxRisk,
      matchedLocalTarget: prepared.targetMatch.matched && !prepared.hasExplicitGrantRequest
    });
    if (authorizationDenied) {
      return authorizationDenied;
    }
    return issuePreparedLocalMcpGrant(prepared, { request, discoveryState });
  }

  function createLocalMcpGrantAuthorizationRequest({ request, requestBody }: Record<string, any> = {}) : any {
    const current: any = requirePlatform();
    if (!isDirectMcpClientRequest(request)) {
      return localMcpPairingDenied("MCP installation authorization requires a direct client connection.");
    }
    const body: any = parseRequestBody(requestBody);
    const claimTokenHash: any = String(body.claimTokenHash || body.claim_token_hash || "").trim();
    if (!isLocalMcpAuthorizationClaimHash(claimTokenHash)) {
      return denyLocalGrant(
        400,
        "authorization_claim_hash_required",
        "MCP local installation authorization requires a SHA-256 claim token hash."
      );
    }
    const prepared: any = prepareLocalMcpGrantRequest(body);
    if (!prepared.ok) {
      return prepared.response;
    }
    if (
      localGrantRiskRank(prepared.resolved.maxRisk) >= localGrantRiskRank("repair_write") &&
      localGrantRiskRank(prepared.requestedMaxRisk) < localGrantRiskRank("repair_write")
    ) {
      return denyLocalGrant(
        403,
        "repair_grant_mode_required",
        "Repair-capable MCP local grants require grantMode=maintain or maxRisk=repair_write.",
        { maxRisk: prepared.resolved.maxRisk }
      );
    }
    const canonicalBody: any = canonicalLocalMcpGrantBody(prepared);
    const verificationCode: any = localMcpAuthorizationVerificationCode(claimTokenHash);
    const processKeyFingerprints: any = prepared.targets.map((target?: any) : any => ({
      target,
      fingerprint: localMcpProcessKeyFingerprint(prepared.processIdentityRequests.get(target))
    }));
    const expiresAt: any = new Date(Date.now() + LOCAL_MCP_AUTHORIZATION_REQUEST_TTL_MS).toISOString();
    const requestPayload: Record<string, any> = {
      body: canonicalBody,
      summary: {
        targets: prepared.targets,
        toolsets: prepared.resolved.toolsets,
        scopes: prepared.resolved.requiredScopes,
        maxRisk: prepared.resolved.maxRisk,
        verificationCode,
        processKeyFingerprints
      }
    };
    if (
      Buffer.byteLength(JSON.stringify(requestPayload), "utf8") >
      LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES
    ) {
      return denyLocalGrant(
        413,
        "authorization_request_too_large",
        "MCP installation authorization request is too large."
      );
    }
    let authorizationRequest: any;
    try {
      authorizationRequest = current.store.createMcpAuthorizationRequest({
        request,
        clientName: canonicalBody.label || `Meshrix MCP ${prepared.targets.join(", ")}`,
        requestedScopes: prepared.resolved.requiredScopes,
        requestedTools: prepared.resolved.toolIds,
        reason: `Authorize native MCP installation for ${prepared.targets.join(", ")}.`,
        requestKind: "local_mcp_install",
        requestPayload,
        claimTokenHash,
        expiresAt
      });
    } catch (error: any) {
      if (error?.message === "local_mcp_authorization_payload_too_large") {
        return denyLocalGrant(
          413,
          "authorization_request_too_large",
          "MCP installation authorization request is too large."
        );
      }
      if (error?.message === "local_mcp_authorization_capacity_exceeded") {
        return denyLocalGrant(
          429,
          "authorization_request_capacity_exceeded",
          "Too many MCP installation authorization requests are pending."
        );
      }
      throw error;
    }
    return {
      status: 202,
      body: {
        ok: true,
        requestId: authorizationRequest.requestId,
        status: authorizationRequest.status,
        expiresAt: authorizationRequest.expiresAt,
        verificationCode,
        targets: prepared.targets,
        toolsets: prepared.resolved.toolsets,
        maxRisk: prepared.resolved.maxRisk
      }
    };
  }

  function localMcpAuthorizationStatusResponse(status?: any, requestId: any = "") : any {
    if (status === "pending") {
      return {
        status: 202,
        body: { ok: true, requestId, status: "pending" }
      };
    }
    const responses: Record<string, any> = {
      not_found: [404, "authorization_request_not_found", "MCP installation authorization request was not found."],
      rejected: [403, "authorization_request_rejected", "MCP installation authorization request was rejected."],
      expired: [410, "authorization_request_expired", "MCP installation authorization request expired."],
      issuing: [409, "authorization_request_in_progress", "MCP installation authorization is already being consumed."],
      consumed: [409, "authorization_request_consumed", "MCP installation authorization was already consumed."],
      failed: [409, "authorization_request_failed", "MCP installation authorization could not be consumed."]
    };
    const [httpStatus, code, message] = responses[status] || responses.not_found;
    return denyLocalGrant(httpStatus, code, message, requestId ? { requestId } : {});
  }

  async function consumeLocalMcpGrantAuthorizationRequest({ request, requestId, discoveryState = null }: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (!isDirectMcpClientRequest(request)) {
      return localMcpPairingDenied("MCP installation authorization requires a direct client connection.");
    }
    const claimToken: any = String(request?.headers?.["x-meshrix-authorization-claim"] || "").trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(claimToken)) {
      return localMcpAuthorizationStatusResponse("not_found");
    }
    const claim: any = current.store.claimMcpAuthorizationRequest({
      requestId,
      claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
    });
    if (!claim.claimed) {
      if (claim.status === "consumed" && claim.replayable && claim.request?.replayEnvelope) {
        try {
          const replayed: any = openLocalMcpAuthorizationReplay({
            claimToken,
            requestId,
            envelope: claim.request.replayEnvelope
          });
          if (
            replayed?.status === 201 &&
            replayed?.body?.authorizationRequestId === requestId
          ) {
            return replayed;
          }
        } catch (error: any) {
          logger?.warn?.("mcp.local_grant.authorization_replay.failed", {
            reasonCode: "authorization_replay_invalid",
            errorType: error?.name || "Error"
          });
        }
      }
      return localMcpAuthorizationStatusResponse(claim.status, claim.request?.requestId || "");
    }
    const prepared: any = prepareLocalMcpGrantRequest(claim.request?.requestPayload?.body || {});
    if (!prepared.ok) {
      current.store.completeMcpAuthorizationRequest({
        requestId,
        status: "failed",
        errorCode: prepared.response?.body?.error?.code || "authorization_request_invalid"
      });
      return prepared.response;
    }
    const approvedSummary: any = claim.request?.requestPayload?.summary || {};
    const sameValues: any = (left?: any, right?: any) : any => JSON.stringify(
      normalizeGrantValues(left, 512).sort()
    ) === JSON.stringify(normalizeGrantValues(right, 512).sort());
    const currentProcessKeyFingerprints: any = prepared.targets.map((target?: any) : any => ({
      target,
      fingerprint: localMcpProcessKeyFingerprint(prepared.processIdentityRequests.get(target))
    }));
    const approvedProcessKeyFingerprints: any = Array.isArray(approvedSummary.processKeyFingerprints)
      ? approvedSummary.processKeyFingerprints
      : [];
    const immutableRequestMatches: any =
      sameValues(approvedSummary.targets, prepared.targets) &&
      sameValues(approvedSummary.toolsets, prepared.resolved.toolsets) &&
      sameValues(approvedSummary.scopes, prepared.resolved.requiredScopes) &&
      sameValues(claim.request?.requestedTools, prepared.resolved.toolIds) &&
      String(approvedSummary.maxRisk || "") === String(prepared.resolved.maxRisk || "") &&
      JSON.stringify(approvedProcessKeyFingerprints) === JSON.stringify(currentProcessKeyFingerprints);
    if (!immutableRequestMatches) {
      current.store.completeMcpAuthorizationRequest({
        requestId,
        status: "failed",
        errorCode: "authorization_request_policy_changed"
      });
      return denyLocalGrant(
        409,
        "authorization_request_policy_changed",
        "MCP installation authorization no longer matches the current grant policy. Create a new request."
      );
    }
    let issued: any = null;
    try {
      issued = await issuePreparedLocalMcpGrant(prepared, { request, discoveryState });
      if (issued.status !== 201) {
        current.store.completeMcpAuthorizationRequest({
          requestId,
          status: "failed",
          errorCode: issued.body?.error?.code || "local_grant_issue_failed"
        });
        return issued;
      }
      const grantIds: any = issued.body.batch
        ? (issued.body.grants || []).map((entry?: any) : any => entry?.grant?.id).filter(Boolean)
        : [issued.body.grant?.id].filter(Boolean);
      const response: Record<string, any> = {
        ...issued,
        body: {
          ...issued.body,
          authorizationRequestId: requestId
        }
      };
      const replayEnvelope: any = sealLocalMcpAuthorizationReplay({
        claimToken,
        requestId,
        response
      });
      const completed: any = current.store.completeMcpAuthorizationRequest({
        requestId,
        status: "consumed",
        grantIds,
        replayEnvelope,
        replayExpiresAt: new Date(Date.now() + LOCAL_MCP_AUTHORIZATION_REPLAY_TTL_MS).toISOString()
      });
      if (!completed) {
        const issuedEntries: any = issued.body.batch
          ? (issued.body.grants || [])
          : [{ grant: issued.body.grant, processIdentity: issued.body.processIdentity }];
        await rollbackIssuedLocalMcpGrants(current, issuedEntries);
        return denyLocalGrant(
          409,
          "authorization_request_completion_conflict",
          "MCP installation authorization could not be completed; issued credentials were revoked."
        );
      }
      return response;
    } catch (error: any) {
      if (issued?.status === 201) {
        const issuedEntries: any = issued.body.batch
          ? (issued.body.grants || [])
          : [{ grant: issued.body.grant, processIdentity: issued.body.processIdentity }];
        await rollbackIssuedLocalMcpGrants(current, issuedEntries);
      }
      try {
        current.store.completeMcpAuthorizationRequest({
          requestId,
          status: "failed",
          errorCode: "local_grant_issue_failed"
        });
      } catch (completionError: any) {
        logger?.warn?.("mcp.local_grant.authorization_completion.failed", {
          reasonCode: "authorization_completion_failed",
          errorType: completionError?.name || "Error"
        });
      }
      throw error;
    }
  }

  async function markLocalMcpGrantUninstalled({ request, requestBody, url = null, method = "POST" }: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (!isDirectMcpClientRequest(request)) {
      return {
        status: 403,
        body: {
          ok: false,
          error: {
            code: "local_pairing_required",
            message: "MCP uninstall updates require a direct client connection."
          }
        }
      };
    }

    const body: any = parseRequestBody(requestBody);
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES) {
      return denyLocalGrant(413, "local_uninstall_request_too_large", "MCP local uninstall request is too large.");
    }
    const targets: any = normalizeGrantTargets(body.targets || body.target || body.clientId);
    const targetKeys: any = normalizedGrantTargetKeys(targets);
    if (targets.length === 0) {
      return denyLocalGrant(
        400,
        "targets_required",
        "MCP local uninstall updates require at least one target."
      );
    }
    if (!grantValuesFitByteLimit(targets, 128)) {
      return denyLocalGrant(400, "local_uninstall_target_invalid", "MCP local uninstall target is invalid.");
    }

    const authorization: any = await authorizeRequest({
      request,
      requiredScopes: [],
      recordUse: false,
      requestBody,
      url,
      method
    });
    if (!authorization.ok) {
      return denyLocalGrant(
        authorization.status || 401,
        authorization.reasonCode === "missing_token" ? "local_uninstall_token_required" : authorization.reasonCode || "local_uninstall_token_denied",
        authorization.error || "MCP local uninstall updates require a valid local MCP token."
      );
    }
    const authorizedGrant: any = authorization.grant || null;
    if (!isLocalMcpGrant(authorizedGrant)) {
      return denyLocalGrant(
        403,
        "local_uninstall_local_grant_required",
        "MCP local uninstall updates require a local MCP connector grant."
      );
    }
    const authorizedTargets: any = localMcpGrantTargetKeys(authorizedGrant);
    const unauthorizedTargets: any = targets.filter((target?: any) : any => !authorizedTargets.includes(normalizedTargetKey(target)));
    if (unauthorizedTargets.length > 0) {
      return denyLocalGrant(
        403,
        "local_uninstall_target_denied",
        "MCP local uninstall token is not bound to every requested target.",
        {
          unauthorizedTargets,
          authorizedTargets
        }
      );
    }

    const store: any = current.store;
    if (typeof store?.updateGrant !== "function") {
      return denyLocalGrant(
        503,
        "operation_permission_unavailable",
        "Operation Permission storage is not available."
      );
    }

    const uninstalledAt: any = nowIso();
    const grantTargets: any = localMcpGrantTargets(authorizedGrant);
    const matchedTargets: any = grantTargets.filter((target?: any) : any => targetKeys.includes(normalizedTargetKey(target)));
    const metadata: any = grantMetadata(authorizedGrant);
    const uninstalledTargets: any = [
      ...normalizedGrantTargetKeys(metadata.uninstalledTargets),
      ...matchedTargets.map((target?: any) : any => normalizedTargetKey(target))
    ].filter((target?: any, index?: any, values?: any) : any => values.indexOf(target) === index);
    const remainingTargets: any = grantTargets.filter((target?: any) : any => !uninstalledTargets.includes(normalizedTargetKey(target)));
    const nextMetadata: Record<string, any> = {
      ...metadata,
      uninstalledTargets,
      lastUninstalledAt: uninstalledAt,
      lastUninstallConnectorVersion: String(body.connectorVersion || "").trim().slice(0, 128)
    };
    if (remainingTargets.length === 0) {
      nextMetadata.uninstalledAt = nextMetadata.uninstalledAt || uninstalledAt;
      nextMetadata.currentDeviceVisible = false;
    } else if (nextMetadata.currentDeviceVisible === false) {
      nextMetadata.currentDeviceVisible = true;
    }
    const nextGrant: any = await store.updateGrant(authorizedGrant.id, {
      enabled: remainingTargets.length > 0 ? authorizedGrant.enabled !== false : false,
      metadata: nextMetadata,
      reason: authorizedGrant.reason || "Updated by local Meshrix MCP connector uninstall."
    });
    const updated: any = nextGrant
      ? [{
          grantId: nextGrant.id,
          targets: matchedTargets,
          currentDeviceVisible: remainingTargets.length > 0
        }]
      : [];

    return {
      status: 200,
      body: {
        ok: true,
        schemaVersion: "v0.0.1:schema:definition-1",
        targets,
        authorizedGrantId: authorizedGrant.id || "",
        updatedCount: updated.length,
        updated
      }
    };
  }

  async function createDelegatedMcpGrant(input: Record<string, any> = {}) : Promise<any> {
    return createDelegatedMcpGrantForPlatform(requirePlatform(), input);
  }

  async function revokeDelegatedMcpGrant(input: Record<string, any> = {}) : Promise<any> {
    return revokeDelegatedMcpGrantForPlatform(requirePlatform(), input);
  }

  function createMcpAuthorizationRequest(input: Record<string, any> = {}, { request = null }: Record<string, any> = {}) : any {
    const current: any = requirePlatform();
    return current.store.createMcpAuthorizationRequest({
      request,
      clientName: String(input.clientName || input.name || "").trim(),
      requestedScopes: Array.isArray(input.requestedScopes) ? input.requestedScopes : [],
      requestedTools: Array.isArray(input.requestedTools) ? input.requestedTools : [],
      reason: String(input.reason || "").trim()
    });
  }

  function listMcpAuthorizationRequests(input: Record<string, any> = {}) : any {
    const current: any = requirePlatform();
    return current.store.listMcpAuthorizationRequests({
      status: input.status || "pending"
    });
  }

  async function resolveMcpAuthorizationRequest(input: Record<string, any> = {}, { authSession = null }: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    const requestId: any = String(input.requestId || input["request-id"] || input.id || "").trim();
    const resolutionInput: any = String(input.resolution || "").trim();
    const resolution: any = resolutionInput === "denied" ? "rejected" : resolutionInput;
    const resolvedBy: any = String(
      authSession?.user?.userId || authSession?.user?.id || authSession?.user?.username || ""
    ).trim();
    const pendingRequest: any = current.store.getMcpAuthorizationRequest(requestId);
    if (!pendingRequest || pendingRequest.status !== "pending") {
      return { success: false, grantId: "" };
    }
    if (pendingRequest.requestKind === "local_mcp_install") {
      const success: any = current.store.resolveMcpAuthorizationRequest({
        requestId,
        resolution,
        grantId: "",
        resolvedBy
      });
      return { success, grantId: "", requestKind: pendingRequest.requestKind };
    }
    let grantId: any = "";
    if (resolution === "approved") {
      const clientName: any = String(input.clientName || "MCP Client");
      const grantResult: any = await current.store.createGrant({
        label: `${clientName} (MCP Client)`,
        type: "mcp-client",
        scopes: Array.isArray(input.scopes) ? input.scopes : [],
        toolsets: Array.isArray(input.toolsets) ? input.toolsets : [],
        toolAllow: Array.isArray(input.toolAllow) ? input.toolAllow : [],
        enabled: true,
        reason: `Approved MCP authorization request ${requestId}`
      });
      grantId = grantResult.grant.id;
    }

    const success: any = current.store.resolveMcpAuthorizationRequest({
      requestId,
      resolution,
      grantId,
      resolvedBy
    });
    return { success, grantId };
  }

  async function handleOperationPermissionHttpRequest(input: Record<string, any> = {}) : Promise<any> {
    const current: any = requirePlatform();
    if (!current.router?.handleOperationPermissionHttpRequest) {
      return false;
    }
    return current.router.handleOperationPermissionHttpRequest(input);
  }

  function listMcpClientConnections({ offlineAfterSeconds = 0 }: Record<string, any> = {}) : any {
    const current: any = requirePlatform();
    if (typeof current.store?.listGrants !== "function") {
      return [];
    }
    try {
      return current.store.listGrants({ includeRevoked: true })
        .filter(isLocalMcpGrant)
        .flatMap((grant?: any) : any => mcpGrantClientRows(grant, { offlineAfterSeconds }));
    } catch (error: any) {
      logger?.warn?.("operation_permission_facade.client_connections.failed", {
        error: error?.message || "client connection projection failed"
      });
      return [];
    }
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
          "mcp_local_grant",
          "mcp_device_authorization",
          "mcp_delegated_child_grant",
          "mcp_workspace_reference_projection"
        ]
      };
    },
    authorizeRequest,
    visibleGrantSummary,
    audiencePartitionKeys,
    audienceCatalogFacts,
    listVisibleTools,
    executeTool,
    resolveMcpWorkspaceInput,
    publicMcpToolPayload,
    createLocalMcpGrant,
    createLocalMcpGrantAuthorizationRequest,
    consumeLocalMcpGrantAuthorizationRequest,
    markLocalMcpGrantUninstalled,
    createDelegatedMcpGrant,
    revokeDelegatedMcpGrant,
    createMcpAuthorizationRequest,
    listMcpAuthorizationRequests,
    resolveMcpAuthorizationRequest,
    handleOperationPermissionHttpRequest,
    listMcpClientConnections
  });
}
