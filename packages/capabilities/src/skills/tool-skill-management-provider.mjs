import {
  grantMetadata,
  normalizeGrantTargets,
  normalizeGrantValues,
  normalizedGrantTargetKeys,
  normalizedTargetKey,
  nowIso
} from "./tool-skill-management-provider-grant-utils.mjs";
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
} from "./tool-skill-management-provider-local-mcp.mjs";
import {
  collectWorkspaces,
  executeToolPayload,
  inputMayNeedWorkspaceResolution,
  resolveWorkspaceReferencesInInput,
  sanitizeMcpOutputValue,
  valueContainsWorkspaceId,
  workspaceDirectoryFromWorkspaces
} from "./tool-skill-management-provider-workspace-projection.mjs";
import {
  createDelegatedMcpGrantForPlatform,
  revokeDelegatedMcpGrantForPlatform
} from "./tool-skill-management-provider-delegated-mcp.mjs";

export const OPERATION_PERMISSION_FACADE_PROTOCOL_VERSION = "v0.0.1:operation-permission:facade-1";

export function createToolSkillManagementProvider({
  operationPermissionPlatform,
  userDataPath = "",
  securityPermissions = operationPermissionPlatform?.securityPermissions || null,
  evaluateToolAudience = null,
  resolveAudiencePartitionKeys = null,
  resolveAudienceCatalogFacts = null,
  logger = null
} = {}) {
  const platform = operationPermissionPlatform;

  async function loadMcpWorkspaceDirectory({ request, context = {}, signal = null }) {
    const result = await executeTool({
      toolId: "lico.agentWorkspace.list",
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

  function requirePlatform() {
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
  } = {}) {
    const current = requirePlatform();
    if (!current.store?.authorizeRequest) {
      return {
        ok: false,
        status: 503,
        error: "Operation Permission authorization is unavailable."
      };
    }
    normalizeApiKeyHeader(request);
    const authorization = await current.store.authorizeRequest({
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
        traceId: request?.__licoTraceContext?.traceId || request?.__licoRequestId || "",
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

  function visibleGrantSummary({ authorization = null } = {}) {
    const grant = authorization?.grant || null;
    return {
      id: grant ? "grant-hidden" : "",
      label: grant?.label || "",
      toolsets: grant?.toolsets || [],
      scopes: grant?.scopes || [],
      maxRisk: grantVisibleRisk(grant)
    };
  }

  function audiencePartitionKeys({ authorization = null } = {}) {
    const grantId = String(authorization?.grant?.id || "").trim();
    if (!grantId || typeof resolveAudiencePartitionKeys !== "function") return [];
    const keys = resolveAudiencePartitionKeys(grantId);
    return [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key || "").trim()).filter(Boolean))].sort();
  }

  function audienceCatalogFacts({ authorization = null } = {}) {
    const grantId = String(authorization?.grant?.id || "").trim();
    if (!grantId || typeof resolveAudienceCatalogFacts !== "function") return null;
    const facts = resolveAudienceCatalogFacts(grantId);
    if (!facts || typeof facts !== "object") return null;
    const sourceRevision = Number(facts.sourceRevision);
    const audienceRevision = Number(facts.audienceRevision);
    const catalogRevision = String(facts.catalogRevision || "").trim();
    const partitionKeys = [...new Set((facts.partitionKeys || [])
      .map((key) => String(key || "").trim())
      .filter(Boolean))].sort();
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 ||
        !Number.isSafeInteger(audienceRevision) || audienceRevision < 0 ||
        !catalogRevision || partitionKeys.length === 0) return null;
    return Object.freeze({ sourceRevision, catalogRevision, audienceRevision, partitionKeys });
  }

  function listVisibleTools({ authorization = null } = {}) {
    const current = requirePlatform();
    const catalog = current.catalog?.() || { tools: [] };
    const grant = authorization?.grant || null;
    return (catalog.tools || [])
      .filter((tool) => tool.status === "active")
      .filter((tool) => !grant || grantCanSeeTool(tool, grant))
      .filter((tool) => tool.upstreamProjectedOperation !== true ||
        evaluateToolAudience?.({ grant, tool, purpose: "discovery" })?.allowed === true);
  }

  async function executeTool({ toolId, input = {}, request = null, authorization = null, context = {}, dryRun = false, signal = null } = {}) {
    const current = requirePlatform();
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
    const tool = current.registry?.getTool?.(toolId) || null;
    const contextualCapability = context?.dynamicCapability && typeof context.dynamicCapability === "object" && !Array.isArray(context.dynamicCapability)
      ? context.dynamicCapability
      : null;
    if (tool?.upstreamProjectedOperation === true) {
      const grant = authorization?.grant || null;
      const audienceTool = contextualCapability
        ? {
            ...tool,
            serviceId: contextualCapability.serviceId || tool.serviceId,
            requiredScopes: contextualCapability.requiredScopes || context.requestedScopes || tool.requiredScopes,
            toolsets: contextualCapability.toolsets || tool.toolsets,
            risk: contextualCapability.risk || tool.risk,
            dynamicCapability: contextualCapability
          }
        : tool;
      const audienceDecision = evaluateToolAudience?.({ grant, tool: audienceTool, purpose: "execution" }) || null;
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
    const dynamicCapability = contextualCapability || (
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

  async function resolveMcpWorkspaceInput({ input, request, context = {}, signal = null } = {}) {
    if (!inputMayNeedWorkspaceResolution(input)) {
      return { input, workspaceDirectory: null };
    }
    const workspaceDirectory = await loadMcpWorkspaceDirectory({ request, context, signal });
    return {
      input: resolveWorkspaceReferencesInInput(input, workspaceDirectory),
      workspaceDirectory
    };
  }

  async function publicMcpToolPayload({ payload, workspaceDirectory, request, context = {}, signal = null } = {}) {
    const workspaces = collectWorkspaces(payload);
    let directory = workspaces.length ? workspaceDirectoryFromWorkspaces(workspaces) : workspaceDirectory;
    if (!directory && valueContainsWorkspaceId(payload)) {
      directory = await loadMcpWorkspaceDirectory({ request, context, signal });
    }
    return sanitizeMcpOutputValue(payload, directory || workspaceDirectoryFromWorkspaces([]));
  }

  function localGrantProcessIdentityRequestForTarget(body = {}, target = "", targetCount = 1) {
    const targetKey = normalizedTargetKey(target);
    const processIdentities = body.processIdentities && typeof body.processIdentities === "object" && !Array.isArray(body.processIdentities)
      ? body.processIdentities
      : {};
    const targetIdentity = processIdentities[target] || processIdentities[targetKey] || null;
    if (targetIdentity && typeof targetIdentity === "object" && !Array.isArray(targetIdentity)) {
      return normalizeLocalMcpProcessIdentityRequest(targetIdentity);
    }
    if (targetCount === 1 && body.processIdentity && typeof body.processIdentity === "object" && !Array.isArray(body.processIdentity)) {
      return normalizeLocalMcpProcessIdentityRequest(body.processIdentity);
    }
    return {};
  }

  function hasProcessIdentityPublicKey(processIdentityRequest = {}) {
    return Boolean(
      processIdentityRequest.processPublicKeyPem ||
        processIdentityRequest.processPublicKeySpkiBase64 ||
        processIdentityRequest.publicKeyPem ||
        processIdentityRequest.publicKeySpkiBase64
    );
  }

  function localGrantLabelForTarget(body = {}, target = "", targetCount = 1) {
    const provided = String(body.label || "").trim().slice(0, 256);
    if (provided && targetCount <= 1) {
      return provided;
    }
    if (provided) {
      return `${provided} (${target})`;
    }
    return `LicoMesh MCP ${target || "local agent"}`;
  }

  function grantValuesFitByteLimit(values = [], maxBytes = 512) {
    return values.every((value) => Buffer.byteLength(String(value || ""), "utf8") <= maxBytes);
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
  }) {
    const targetMatch = localGrantTargetMatch([target]);
    const effectiveToolsets = hasExplicitGrantRequest ? requestedToolsets : targetMatch.toolsets;
    const resolved = current.registry.resolveToolset({
      toolsets: effectiveToolsets,
      toolAllow,
      toolDeny,
      scopes: requestedScopes
    });
    const identityIssued = await securityPermissions.processIdentity.issueLocalMcpClientIdentityPackage({
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
    const targets = [target];
    let result;
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
        issuedBy: "lico-mcp-local-pairing",
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
        ? "Issued by batched local LicoMesh MCP connector pairing."
        : "Issued by local LicoMesh MCP connector pairing."
      });
    } catch (error) {
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

  function localMcpPairingDenied(message = "MCP local pairing is only available from the local machine.") {
    return denyLocalGrant(403, "local_pairing_required", message);
  }

  function prepareLocalMcpGrantRequest(body = {}) {
    const current = requirePlatform();
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
    const targets = normalizeGrantTargets(body.targets || body.target || body.clientId);
    if (targets.length === 0) {
      return {
        ok: false,
        response: denyLocalGrant(400, "mcp_targets_required", "MCP local grants require at least one target client.", {
          targets
        })
      };
    }
    const requestedToolsets = normalizeGrantValues(body.toolsets || body.toolsetIds || body.toolset || []);
    const requestedScopes = normalizeGrantValues(body.scopes || body.scopeIds || body.scope || []);
    const toolAllow = normalizeGrantValues(body.toolAllow || body.tool_allow || []);
    const toolDeny = normalizeGrantValues(body.toolDeny || body.tool_deny || []);
    const allowedWorkspaceIds = normalizeGrantValues(body.allowedWorkspaceIds || body.workspaceIds || body.workspaceId || []);
    const dynamicCapabilities = normalizeGrantValues(body.dynamicCapabilities || body.upstreamCapabilities || [], 512);
    const allowedServiceIds = normalizeGrantValues(body.allowedServiceIds || body.upstreamServiceIds || [], 512);
    const allowedSecretBindings = normalizeGrantValues(body.allowedSecretBindings || body.credentialBindingIds || [], 512);
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
    const targetMatch = localGrantTargetMatch(targets);
    const hasExplicitGrantRequest = requestedToolsets.length > 0 || requestedScopes.length > 0 || toolAllow.length > 0;
    const effectiveToolsets = hasExplicitGrantRequest ? requestedToolsets : targetMatch.toolsets;

    const resolved = current.registry.resolveToolset({
      toolsets: effectiveToolsets,
      toolAllow,
      toolDeny,
      scopes: requestedScopes
    });
    const toolsetsById = new Map(current.registry.listToolsets().map((toolset) => [toolset.id, toolset]));
    const blockedToolsets = resolved.toolsets.filter((toolsetId) => toolsetsById.get(toolsetId)?.grantable === false);
    if (blockedToolsets.length > 0) {
      return {
        ok: false,
        response: denyLocalGrant(403, "toolset_not_grantable", "Requested MCP toolset is not grantable.", {
          toolsets: blockedToolsets
        })
      };
    }
    const requestedMaxRisk = requestedLocalGrantMaxRisk(body, resolved);
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
    const processIdentityRequests = new Map();
    for (const target of targets) {
      let processIdentityRequest;
      try {
        processIdentityRequest = localGrantProcessIdentityRequestForTarget(body, target, targets.length);
      } catch (error) {
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

  function canonicalLocalMcpGrantBody(prepared) {
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
        prepared.targets.map((target) => [target, prepared.processIdentityRequests.get(target)])
      )
    };
  }

  async function rollbackIssuedLocalMcpGrants(current, issued = []) {
    for (const item of [...issued].reverse()) {
      try {
        await current.store.revokeGrant(item.grant?.id, "local_mcp_authorization_batch_rolled_back");
      } catch (error) {
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
      } catch (error) {
        logger?.warn?.("mcp.local_grant.rollback_identity.failed", {
          reasonCode: "process_identity_rollback_failed",
          errorType: error?.name || "Error"
        });
      }
    }
  }

  async function issuePreparedLocalMcpGrant(prepared, { request = null, discoveryState = null } = {}) {
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
    const issued = [];
    try {
      for (const target of targets) {
        const grantIssued = await issueLocalMcpGrantForTarget({
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
    } catch (error) {
      await rollbackIssuedLocalMcpGrants(current, issued);
      throw error;
    }
    const primary = issued[0];
    const targetGrants = Object.fromEntries(issued.map((item) => [item.target, item]));
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

  async function createLocalMcpGrant({ request, requestBody, discoveryState = null, url = null } = {}) {
    if (!isLocalMcpPairingRequest(request)) {
      return localMcpPairingDenied("MCP local grant issuance is only available from the local machine.");
    }
    const body = parseRequestBody(requestBody);
    const prepared = prepareLocalMcpGrantRequest(body);
    if (!prepared.ok) {
      return prepared.response;
    }
    const authorizationDenied = await authorizeLocalGrantIssuance({
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

  function createLocalMcpGrantAuthorizationRequest({ request, requestBody } = {}) {
    const current = requirePlatform();
    if (!isDirectMcpClientRequest(request)) {
      return localMcpPairingDenied("MCP installation authorization requires a direct client connection.");
    }
    const body = parseRequestBody(requestBody);
    const claimTokenHash = String(body.claimTokenHash || body.claim_token_hash || "").trim();
    if (!isLocalMcpAuthorizationClaimHash(claimTokenHash)) {
      return denyLocalGrant(
        400,
        "authorization_claim_hash_required",
        "MCP local installation authorization requires a SHA-256 claim token hash."
      );
    }
    const prepared = prepareLocalMcpGrantRequest(body);
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
    const canonicalBody = canonicalLocalMcpGrantBody(prepared);
    const verificationCode = localMcpAuthorizationVerificationCode(claimTokenHash);
    const processKeyFingerprints = prepared.targets.map((target) => ({
      target,
      fingerprint: localMcpProcessKeyFingerprint(prepared.processIdentityRequests.get(target))
    }));
    const expiresAt = new Date(Date.now() + LOCAL_MCP_AUTHORIZATION_REQUEST_TTL_MS).toISOString();
    const requestPayload = {
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
    let authorizationRequest;
    try {
      authorizationRequest = current.store.createMcpAuthorizationRequest({
        request,
        clientName: canonicalBody.label || `LicoMesh MCP ${prepared.targets.join(", ")}`,
        requestedScopes: prepared.resolved.requiredScopes,
        requestedTools: prepared.resolved.toolIds,
        reason: `Authorize native MCP installation for ${prepared.targets.join(", ")}.`,
        requestKind: "local_mcp_install",
        requestPayload,
        claimTokenHash,
        expiresAt
      });
    } catch (error) {
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

  function localMcpAuthorizationStatusResponse(status, requestId = "") {
    if (status === "pending") {
      return {
        status: 202,
        body: { ok: true, requestId, status: "pending" }
      };
    }
    const responses = {
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

  async function consumeLocalMcpGrantAuthorizationRequest({ request, requestId, discoveryState = null } = {}) {
    const current = requirePlatform();
    if (!isDirectMcpClientRequest(request)) {
      return localMcpPairingDenied("MCP installation authorization requires a direct client connection.");
    }
    const claimToken = String(request?.headers?.["x-lico-authorization-claim"] || "").trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(claimToken)) {
      return localMcpAuthorizationStatusResponse("not_found");
    }
    const claim = current.store.claimMcpAuthorizationRequest({
      requestId,
      claimTokenHash: hashLocalMcpAuthorizationClaim(claimToken)
    });
    if (!claim.claimed) {
      if (claim.status === "consumed" && claim.replayable && claim.request?.replayEnvelope) {
        try {
          const replayed = openLocalMcpAuthorizationReplay({
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
        } catch (error) {
          logger?.warn?.("mcp.local_grant.authorization_replay.failed", {
            reasonCode: "authorization_replay_invalid",
            errorType: error?.name || "Error"
          });
        }
      }
      return localMcpAuthorizationStatusResponse(claim.status, claim.request?.requestId || "");
    }
    const prepared = prepareLocalMcpGrantRequest(claim.request?.requestPayload?.body || {});
    if (!prepared.ok) {
      current.store.completeMcpAuthorizationRequest({
        requestId,
        status: "failed",
        errorCode: prepared.response?.body?.error?.code || "authorization_request_invalid"
      });
      return prepared.response;
    }
    const approvedSummary = claim.request?.requestPayload?.summary || {};
    const sameValues = (left, right) => JSON.stringify(
      normalizeGrantValues(left, 512).sort()
    ) === JSON.stringify(normalizeGrantValues(right, 512).sort());
    const currentProcessKeyFingerprints = prepared.targets.map((target) => ({
      target,
      fingerprint: localMcpProcessKeyFingerprint(prepared.processIdentityRequests.get(target))
    }));
    const approvedProcessKeyFingerprints = Array.isArray(approvedSummary.processKeyFingerprints)
      ? approvedSummary.processKeyFingerprints
      : [];
    const immutableRequestMatches =
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
    let issued = null;
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
      const grantIds = issued.body.batch
        ? (issued.body.grants || []).map((entry) => entry?.grant?.id).filter(Boolean)
        : [issued.body.grant?.id].filter(Boolean);
      const response = {
        ...issued,
        body: {
          ...issued.body,
          authorizationRequestId: requestId
        }
      };
      const replayEnvelope = sealLocalMcpAuthorizationReplay({
        claimToken,
        requestId,
        response
      });
      const completed = current.store.completeMcpAuthorizationRequest({
        requestId,
        status: "consumed",
        grantIds,
        replayEnvelope,
        replayExpiresAt: new Date(Date.now() + LOCAL_MCP_AUTHORIZATION_REPLAY_TTL_MS).toISOString()
      });
      if (!completed) {
        const issuedEntries = issued.body.batch
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
    } catch (error) {
      if (issued?.status === 201) {
        const issuedEntries = issued.body.batch
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
      } catch (completionError) {
        logger?.warn?.("mcp.local_grant.authorization_completion.failed", {
          reasonCode: "authorization_completion_failed",
          errorType: completionError?.name || "Error"
        });
      }
      throw error;
    }
  }

  async function markLocalMcpGrantUninstalled({ request, requestBody, url = null, method = "POST" } = {}) {
    const current = requirePlatform();
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

    const body = parseRequestBody(requestBody);
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > LOCAL_MCP_AUTHORIZATION_REQUEST_MAX_PERSISTED_BYTES) {
      return denyLocalGrant(413, "local_uninstall_request_too_large", "MCP local uninstall request is too large.");
    }
    const targets = normalizeGrantTargets(body.targets || body.target || body.clientId);
    const targetKeys = normalizedGrantTargetKeys(targets);
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

    const authorization = await authorizeRequest({
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
    const authorizedGrant = authorization.grant || null;
    if (!isLocalMcpGrant(authorizedGrant)) {
      return denyLocalGrant(
        403,
        "local_uninstall_local_grant_required",
        "MCP local uninstall updates require a local MCP connector grant."
      );
    }
    const authorizedTargets = localMcpGrantTargetKeys(authorizedGrant);
    const unauthorizedTargets = targets.filter((target) => !authorizedTargets.includes(normalizedTargetKey(target)));
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

    const store = current.store;
    if (typeof store?.updateGrant !== "function") {
      return denyLocalGrant(
        503,
        "operation_permission_unavailable",
        "Operation Permission storage is not available."
      );
    }

    const uninstalledAt = nowIso();
    const grantTargets = localMcpGrantTargets(authorizedGrant);
    const matchedTargets = grantTargets.filter((target) => targetKeys.includes(normalizedTargetKey(target)));
    const metadata = grantMetadata(authorizedGrant);
    const uninstalledTargets = [
      ...normalizedGrantTargetKeys(metadata.uninstalledTargets),
      ...matchedTargets.map((target) => normalizedTargetKey(target))
    ].filter((target, index, values) => values.indexOf(target) === index);
    const remainingTargets = grantTargets.filter((target) => !uninstalledTargets.includes(normalizedTargetKey(target)));
    const nextMetadata = {
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
    const nextGrant = await store.updateGrant(authorizedGrant.id, {
      enabled: remainingTargets.length > 0 ? authorizedGrant.enabled !== false : false,
      metadata: nextMetadata,
      reason: authorizedGrant.reason || "Updated by local LicoMesh MCP connector uninstall."
    });
    const updated = nextGrant
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

  async function createDelegatedMcpGrant(input = {}) {
    return createDelegatedMcpGrantForPlatform(requirePlatform(), input);
  }

  async function revokeDelegatedMcpGrant(input = {}) {
    return revokeDelegatedMcpGrantForPlatform(requirePlatform(), input);
  }

  function createMcpAuthorizationRequest(input = {}, { request = null } = {}) {
    const current = requirePlatform();
    return current.store.createMcpAuthorizationRequest({
      request,
      clientName: String(input.clientName || input.name || "").trim(),
      requestedScopes: Array.isArray(input.requestedScopes) ? input.requestedScopes : [],
      requestedTools: Array.isArray(input.requestedTools) ? input.requestedTools : [],
      reason: String(input.reason || "").trim()
    });
  }

  function listMcpAuthorizationRequests(input = {}) {
    const current = requirePlatform();
    return current.store.listMcpAuthorizationRequests({
      status: input.status || "pending"
    });
  }

  async function resolveMcpAuthorizationRequest(input = {}, { authSession = null } = {}) {
    const current = requirePlatform();
    const requestId = String(input.requestId || input["request-id"] || input.id || "").trim();
    const resolutionInput = String(input.resolution || "").trim();
    const resolution = resolutionInput === "denied" ? "rejected" : resolutionInput;
    const resolvedBy = String(
      authSession?.user?.userId || authSession?.user?.id || authSession?.user?.username || ""
    ).trim();
    const pendingRequest = current.store.getMcpAuthorizationRequest(requestId);
    if (!pendingRequest || pendingRequest.status !== "pending") {
      return { success: false, grantId: "" };
    }
    if (pendingRequest.requestKind === "local_mcp_install") {
      const success = current.store.resolveMcpAuthorizationRequest({
        requestId,
        resolution,
        grantId: "",
        resolvedBy
      });
      return { success, grantId: "", requestKind: pendingRequest.requestKind };
    }
    let grantId = "";
    if (resolution === "approved") {
      const clientName = String(input.clientName || "MCP Client");
      const grantResult = await current.store.createGrant({
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

    const success = current.store.resolveMcpAuthorizationRequest({
      requestId,
      resolution,
      grantId,
      resolvedBy
    });
    return { success, grantId };
  }

  async function handleOperationPermissionHttpRequest(input = {}) {
    const current = requirePlatform();
    if (!current.router?.handleOperationPermissionHttpRequest) {
      return false;
    }
    return current.router.handleOperationPermissionHttpRequest(input);
  }

  function listMcpClientConnections({ offlineAfterSeconds = 0 } = {}) {
    const current = requirePlatform();
    if (typeof current.store?.listGrants !== "function") {
      return [];
    }
    try {
      return current.store.listGrants({ includeRevoked: true })
        .filter(isLocalMcpGrant)
        .flatMap((grant) => mcpGrantClientRows(grant, { offlineAfterSeconds }));
    } catch (error) {
      logger?.warn?.("operation_permission_facade.client_connections.failed", {
        error: error?.message || "client connection projection failed"
      });
      return [];
    }
  }

  return Object.freeze({
    protocolVersion: OPERATION_PERMISSION_FACADE_PROTOCOL_VERSION,
    describe() {
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
