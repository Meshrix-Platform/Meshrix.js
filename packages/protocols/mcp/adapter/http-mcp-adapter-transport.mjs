import { sendJson } from "#lico/http-utils";
import {
  broadcastConfiguredMcpNotification,
  registerConfiguredMcpSseConnection,
  acknowledgeConfiguredMcpCatalogConvergence,
  disconnectConfiguredMcpGrantConnections
} from "./mcp-notification-bus.mjs";
import {
  MCP_PROXY_SESSION_HEADER_LOWER,
  normalizeMcpProxySessionId,
  parseMcpCatalogAcknowledgement
} from "#lico/contracts/mcp-catalog-delivery";
import {
  MCP_DISCOVERY_TOOL_NAME,
  MCP_GATEWAY_TOOL_NAME,
  MCP_INTERFACE_VERSION,
  MCP_PRIORITY_INSTALL_TARGETS,
  MCP_SERVER_VERSION,
  MCP_STABLE_TOOL_NAME,
  MCP_TOOLSET_VERSION
} from "./http-mcp-adapter-constants.mjs";
import { buildLicoMcpDiscovery, githubOneLineMcpInstallCommands, mcpAuthorizationErrorData, mcpConnectorRuntimeMetadata, mcpDiscoveryBase, mcpInitializeResult, mcpPublicSupportedTargetDetails, mcpRuntimeMetadata, mcpSupportedTargetDetails, mcpVersionInfo, mcpHandshake } from "./http-mcp-adapter-discovery.mjs";
import { broadcastMcpOperationReply, inferMcpTargetReceipt, projectMcpOperationPayload } from "./http-mcp-adapter-replies.mjs";
import { hasMcpAuthToken, isAllowedOrigin, normalizeMcpOperationEnvelope } from "./http-mcp-adapter-request-validation.mjs";
import { executeToolPayload, jsonRpcError, jsonRpcNotification, jsonRpcResult, mcpEnvelopePublic, mcpToolResult, parseRequestBody, publicMcpEnvelopeString, publicMcpEnvelopeValue } from "./http-mcp-adapter-response.mjs";
import { mcpAuthSessionFromGrant, delegatedChildOperationFromMcpCall } from "./http-mcp-adapter-session.mjs";
import { licoCategorizedTools, mcpCapabilityFamilies, mcpOutletForOperation, mcpOutletForTool, mcpOutletSummary, operationOutletMismatchError, publicMcpTool } from "./http-mcp-adapter-tools.mjs";
import { isUpstreamMcpToolName, listVisibleUpstreamMcpTools } from "./http-mcp-adapter-upstream.mjs";
import { executeUpstreamToolViaGatewayForward } from "./http-mcp-adapter-upstream-tools.mjs";
import {
  dispatchMcpMessageWithCancellation,
  isProtectedMcpMessage,
  mcpInFlightRequestRegistryFor
} from "./http-mcp-adapter-in-flight.mjs";

function requestHeader(request, name) {
  const raw = request?.headers?.[name] ?? Object.entries(request?.headers || {})
    .find(([key]) => String(key).toLowerCase() === name)?.[1];
  return Array.isArray(raw) ? (raw.length === 1 ? raw[0] : "") : raw;
}

function visibleLicoOutletNames(toolSkillManagementProvider, authorization) {
  const visibleTools = typeof toolSkillManagementProvider?.listVisibleTools === "function"
    ? toolSkillManagementProvider.listVisibleTools({ authorization })
    : [];
  return new Set([
    MCP_DISCOVERY_TOOL_NAME,
    ...visibleTools.map((tool) => mcpOutletForTool(tool).toolName)
  ]);
}

async function licoMetaResult({
  operation,
  input,
  envelope,
  toolSkillManagementProvider,
  upstreamGatewayRegistry = null,
  authorization,
  signal = null,
  listenUrl = "",
  discoveryState = null
}) {
  if (operation === "lico.mcp.version" || operation === "lico.version") {
    return mcpToolResult({
      result: {
        ...mcpRuntimeMetadata({ listenUrl, discoveryState }),
        envelope: mcpEnvelopePublic(envelope)
      }
    });
  }
  if (operation === "lico.capabilities.list") {
    const visibleCatalogTools = toolSkillManagementProvider.listVisibleTools({ authorization });
    const categorizedOperations = visibleCatalogTools
      .filter((tool) => tool?.upstreamProjectedOperation !== true)
      .map(publicMcpTool);
    const upstreamMcpTools = await listVisibleUpstreamMcpTools({
      upstreamGatewayRegistry,
      operationPermissionTools: visibleCatalogTools,
      authorization,
      signal
    });
    const operations = [...categorizedOperations, ...upstreamMcpTools];
    const outlets = mcpOutletSummary(categorizedOperations);
    if (outlets[MCP_GATEWAY_TOOL_NAME]) {
      outlets[MCP_GATEWAY_TOOL_NAME].gatewayCatalog = {
        protocolVersion: MCP_INTERFACE_VERSION,
        toolsetVersion: MCP_TOOLSET_VERSION,
        visibleOperationCount: operations.length
      };
    }
    const runtime = mcpRuntimeMetadata({ listenUrl, discoveryState });
    const capabilityFamilies = mcpCapabilityFamilies({ operations: categorizedOperations });
    return mcpToolResult({
      result: {
        ...runtime,
        grant: toolSkillManagementProvider.visibleGrantSummary({ authorization }),
        envelope: mcpEnvelopePublic(envelope),
        capabilityFamilies,
        outlets,
        operations
      }
    });
  }
  if (operation === "lico.update") {
    const clientVersion = envelope?.clientVersion || input?.clientVersion || "0.0.0";
    const serverVersion = MCP_SERVER_VERSION;
    const updateAvailable = clientVersion !== serverVersion;
    const autoUpdate = Boolean(authorization?.grant?.metadata?.autoUpdate);
    const { baseUrl } = mcpDiscoveryBase({ listenUrl, discoveryState });
    const {
      clientInstallJsonCommand: githubOneLineClientInstallJsonCommand,
      clientInstallJsonCommandZhCN: githubOneLineClientInstallJsonCommandZhCN,
      autoInstallCommand: githubOneLineAutoInstallCommand,
      autoInstallCommandZhCN: githubOneLineAutoInstallCommandZhCN,
      priorityInstallCommand: githubOneLinePriorityInstallCommand,
      priorityInstallCommandZhCN: githubOneLinePriorityInstallCommandZhCN
    } = githubOneLineMcpInstallCommands({ baseUrl });
    const discovery = buildLicoMcpDiscovery({ listenUrl, discoveryState });
    const connector = mcpConnectorRuntimeMetadata(discovery);
    const updateResult = {
      clientVersion,
      serverVersion,
      updateAvailable,
      autoUpdate,
      installCommand: githubOneLineAutoInstallCommand,
      installCommandZhCN: githubOneLineAutoInstallCommandZhCN,
      autoInstallCommand: githubOneLineAutoInstallCommand,
      autoInstallCommandZhCN: githubOneLineAutoInstallCommandZhCN,
      priorityInstallCommand: githubOneLinePriorityInstallCommand,
      priorityInstallCommandZhCN: githubOneLinePriorityInstallCommandZhCN,
      oneCommandClientInstallJson: githubOneLineClientInstallJsonCommand,
      oneCommandClientInstallJsonZhCN: githubOneLineClientInstallJsonCommandZhCN,
      clientInstallCommand: discovery.installer.clientInstallCommand,
      clientInstallJsonCommand: discovery.installer.clientInstallJsonCommand,
      connector,
      priorityTargets: [...MCP_PRIORITY_INSTALL_TARGETS],
      supportedTargets: mcpPublicSupportedTargetDetails(),
      sharedHub: discovery.sharedHub
    };
    if (updateAvailable) {
      const updatePayload = jsonRpcNotification("notifications/lico/update_available", {
        ...updateResult,
        message: `An update to LicoMesh MCP server is available (${serverVersion}).`
      });
      broadcastConfiguredMcpNotification(updatePayload, { grantId: authorization?.grant?.id || "" });
    }
    const instructionText = updateAvailable
      ? (autoUpdate
          ? `A new version of the LicoMesh MCP connector is available (${serverVersion}). Please immediately execute the following unattended command in the user's terminal to update every verified local agent client:\n\n${githubOneLineAutoInstallCommand}\n\nIf the user asks to limit the update to the priority release targets, use this priority command instead:\n\n${githubOneLinePriorityInstallCommand}\n\nCRITICAL: You MUST explicitly inform the user that you just performed an automatic push update of the MCP service.`
          : `A new version of the LicoMesh MCP connector is available (${serverVersion}). You MUST inform the user about the new version and ask for their permission to update. Do NOT execute any command automatically. If they approve, instruct them to execute this unattended command:\n\n${githubOneLineAutoInstallCommand}\n\nIf they ask to limit the update to the priority release targets, use this priority command instead:\n\n${githubOneLinePriorityInstallCommand}`)
      : `The client is already up-to-date (version ${clientVersion}). No update is required.`;

    return mcpToolResult({
      content: [
        {
          type: "text",
          text: instructionText
        }
      ],
      result: updateResult
    });
  }
  return null;
}

async function sendMcpSseVersionEvent(request, response, toolSkillManagementProvider, { listenUrl = "", discoveryState = null } = {}) {
  if (!hasMcpAuthToken(request)) {
    sendJson(response, 401, jsonRpcError(null, -32001, "MCP SSE requires authentication.", {
      code: "mcp_sse_authentication_required"
    }));
    return;
  }
  const requestGrant = await toolSkillManagementProvider.authorizeRequest({
    request,
    requiredScopes: [],
    requestBody: Buffer.alloc(0),
    url: new URL(String(request?.url || "/mcp"), "http://127.0.0.1"),
    method: "GET"
  });
  if (!requestGrant?.ok) {
    sendJson(
      response,
      requestGrant?.status || 401,
      jsonRpcError(
        null,
        -32001,
        requestGrant?.error || "MCP SSE authentication failed.",
        mcpAuthorizationErrorData({ authorization: requestGrant, listenUrl, discoveryState })
      )
    );
    return;
  }
  const requestUrl = new URL(String(request?.url || "/mcp"), "http://127.0.0.1");
  const negotiatedCapabilities = requestUrl.searchParams
    .getAll("capability")
    .map((value) => String(value || "").trim())
    .filter((value) => value === "upstream.catalog.list_changed");
  const registration = registerConfiguredMcpSseConnection({
    request,
    response,
    grantId: requestGrant.grant?.id || "",
    grant: requestGrant.grant,
    privateOnly: true,
    partitionKeys: typeof toolSkillManagementProvider.audiencePartitionKeys === "function"
      ? toolSkillManagementProvider.audiencePartitionKeys({ authorization: requestGrant })
      : [],
    negotiatedCapabilities,
    proxySessionId: normalizeMcpProxySessionId(
      requestHeader(request, MCP_PROXY_SESSION_HEADER_LOWER)
    )
  });
  if (!registration?.ok || typeof registration.write !== "function") {
    sendJson(
      response,
      registration?.status || 503,
      jsonRpcError(null, -32004, "MCP SSE capacity is unavailable.", {
        code: registration?.code || "mcp_sse_registration_unavailable"
      })
    );
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive"
  });
  const initialized = registration.write(
    "event: endpoint\ndata: /mcp\n\n"
  );
  if (!initialized) registration.close?.();
}

async function handleMcpMessage({
  message,
  request,
  requestBody = Buffer.alloc(0),
  url = null,
  method: httpMethod = "POST",
  toolSkillManagementProvider,
  upstreamGatewayRegistry = null,
  listenUrl = "",
  discoveryState = null,
  signal = null,
  requestAuthorization = null
}) {
  const id = message?.id;
  const method = String(message?.method || "");
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const authorizeMcpRequest = () => requestAuthorization || toolSkillManagementProvider.authorizeRequest({
    request,
    requiredScopes: [],
    requestBody,
    url,
    method: httpMethod
  });

  if (!method) {
    return jsonRpcError(id, -32600, "MCP request is missing method.");
  }

  if (method === "lico/catalog/acknowledge") {
    const authorization = await authorizeMcpRequest();
    if (!authorization?.ok) {
      return jsonRpcError(id, -32001, "Catalog convergence acknowledgement requires authorization.", {
        code: "catalog_convergence_acknowledgement_unauthorized"
      });
    }
    const facts = parseMcpCatalogAcknowledgement(params);
    if (!facts) {
      return jsonRpcError(id, -32602, "Catalog convergence acknowledgement is invalid.", {
        code: "catalog_convergence_acknowledgement_invalid"
      });
    }
    const result = acknowledgeConfiguredMcpCatalogConvergence({
      grantId: authorization.grant?.id || "",
      proxySessionId: normalizeMcpProxySessionId(
        requestHeader(request, MCP_PROXY_SESSION_HEADER_LOWER)
      ),
      sourceRevision: facts.sourceRevision,
      catalogRevision: facts.catalogRevision,
      audienceRevision: facts.audienceRevision,
      partitionKeys: facts.partitionKeys
    });
    return jsonRpcResult(id, result);
  }

  if (method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    return jsonRpcResult(id, mcpInitializeResult({ listenUrl, discoveryState }));
  }

  if (method === "ping") {
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    const authorization = await authorizeMcpRequest();
    if (!authorization.ok) {
      return {
        httpStatus: authorization.status || 401,
        body: jsonRpcError(id, -32001, authorization.error || "MCP authorization failed.", mcpAuthorizationErrorData({
          authorization,
          listenUrl,
          discoveryState
        }))
      };
    }
    const visibleTools = typeof toolSkillManagementProvider?.listVisibleTools === "function"
      ? toolSkillManagementProvider.listVisibleTools({ authorization })
      : [];
    const activeOutlets = [...new Set([
      MCP_DISCOVERY_TOOL_NAME,
      ...visibleTools.map((tool) => mcpOutletForTool(tool).toolName)
    ])];
    const upstreamMcpTools = await listVisibleUpstreamMcpTools({
      upstreamGatewayRegistry,
      operationPermissionTools: visibleTools,
      authorization,
      signal
    });
    const catalogConvergence = typeof toolSkillManagementProvider?.audienceCatalogFacts === "function"
      ? toolSkillManagementProvider.audienceCatalogFacts({ authorization })
      : null;
    return jsonRpcResult(id, {
      tools: [
        ...licoCategorizedTools({ activeOutlets, visibleTools }),
        ...upstreamMcpTools
      ],
      _meta: {
        ...mcpRuntimeMetadata({ listenUrl, discoveryState }),
        ...(catalogConvergence ? { catalogConvergence } : {})
      }
    });
  }

  if (method === "tools/call") {
    const toolName = String(params.name || "").trim();
    if (!toolName) {
      return jsonRpcError(id, -32602, "tools/call requires params.name.");
    }
    
    let parsedCall;
    if (isUpstreamMcpToolName(toolName)) {
      const authorization = await authorizeMcpRequest();
      if (!authorization.ok) {
        return {
          httpStatus: authorization.status || 401,
          body: jsonRpcError(id, -32001, authorization.error || "MCP authorization failed.", mcpAuthorizationErrorData({
            authorization,
            listenUrl,
            discoveryState
          }))
        };
      }
      const visibleCatalogTools = typeof toolSkillManagementProvider?.listVisibleTools === "function"
        ? toolSkillManagementProvider.listVisibleTools({ authorization })
        : [];
      const visibleTools = await listVisibleUpstreamMcpTools({
        upstreamGatewayRegistry,
        operationPermissionTools: visibleCatalogTools,
        authorization,
        signal
      });
      const visibleTool = visibleTools.find((tool) => tool.name === toolName);
      if (!visibleTool) {
        return {
          httpStatus: 403,
          body: jsonRpcError(id, -32001, "Upstream MCP tool is not visible for this grant.", {
            code: "upstream_mcp_tool_not_visible",
            toolName
          })
        };
      }
      return executeUpstreamToolViaGatewayForward({
        id,
        toolName,
        visibleTool,
        params,
        request,
        toolSkillManagementProvider,
        authorization,
        signal
      });
    }

    const authorization = await authorizeMcpRequest();
    if (!authorization.ok) {
      return {
        httpStatus: authorization.status || 401,
        body: jsonRpcError(id, -32001, authorization.error || "MCP authorization failed.", mcpAuthorizationErrorData({
          authorization,
          listenUrl,
          discoveryState
        }))
      };
    }
    const activeOutletNames = visibleLicoOutletNames(toolSkillManagementProvider, authorization);
    if (!activeOutletNames.has(toolName)) {
      return jsonRpcError(id, -32601, `Method not found. Use one of the visible categorized outlets for this grant.`, {
        code: "method_not_found",
        stableToolName: MCP_STABLE_TOOL_NAME,
        categorizedOutlets: [...activeOutletNames]
      });
    }
    parsedCall = normalizeMcpOperationEnvelope(params.arguments, authorization);
    if (!parsedCall.ok) {
      const error = parsedCall.error;
      error.id = id;
      return error;
    }
    const delegatedChildOperation = delegatedChildOperationFromMcpCall({
      payload: params.arguments,
      request,
      authorization,
      envelope: parsedCall.envelope,
      operation: parsedCall.operation
    });
    if (
      delegatedChildOperation &&
      (
        delegatedChildOperation.grantBindingVerified !== true ||
        (Array.isArray(delegatedChildOperation.requestBindingMismatches) &&
          delegatedChildOperation.requestBindingMismatches.length > 0) ||
        (Array.isArray(delegatedChildOperation.missingRequestBindings) &&
          delegatedChildOperation.missingRequestBindings.length > 0)
      )
    ) {
      return {
        httpStatus: 200,
        body: jsonRpcError(id, -32001, "Delegated MCP child operation binding mismatch.", {
          code: "delegated_child_operation_binding_mismatch",
          requestBindingMismatches: delegatedChildOperation.requestBindingMismatches || [],
          missingRequestBindings: delegatedChildOperation.missingRequestBindings || []
        })
      };
    }
    const expectedOutlet = mcpOutletForOperation({
      operation: parsedCall.operation,
      toolSkillManagementProvider,
      authorization
    });
    if (expectedOutlet && expectedOutlet.toolName !== toolName) {
      return operationOutletMismatchError({
        id,
        operation: parsedCall.operation,
        requestedTool: toolName,
        expectedOutlet
      });
    }
    const metaResult = await licoMetaResult({
      operation: parsedCall.operation,
      input: parsedCall.input,
      envelope: parsedCall.envelope,
      toolSkillManagementProvider,
      upstreamGatewayRegistry,
      authorization,
      signal,
      listenUrl,
      discoveryState
    });
    if (metaResult) {
      return jsonRpcResult(id, metaResult);
    }
    if (activeOutletNames.has(parsedCall.operation)) {
      return {
        httpStatus: 200,
        body: jsonRpcError(id, -32602, `${parsedCall.operation} is an outlet tool name, not a concrete operation id. First call tool '${MCP_DISCOVERY_TOOL_NAME}' with operation 'lico.capabilities.list', then use one returned operations[].name as arguments.operation.`, {
          code: "outlet_name_used_as_operation",
          outlet: parsedCall.operation,
          discoveryTool: MCP_DISCOVERY_TOOL_NAME,
          discoveryOperation: "lico.capabilities.list",
          example: {
            name: MCP_DISCOVERY_TOOL_NAME,
            arguments: {
              apiVersion: MCP_INTERFACE_VERSION,
              operation: "lico.capabilities.list",
              input: {}
            }
          }
        })
      };
    }
    const mcpExecutionContext = {
      transport: "mcp",
      client: request?.headers?.["user-agent"] || "",
      traceId: delegatedChildOperation?.traceId || parsedCall.envelope.traceId,
      operatorId: parsedCall.envelope.operatorId,
      agentId: parsedCall.envelope.agentProfileId || parsedCall.envelope.operatorId,
      profileId: parsedCall.envelope.agentProfileId,
      agentProfileId: parsedCall.envelope.agentProfileId,
      subject: parsedCall.envelope.subject,
      authSession: mcpAuthSessionFromGrant(authorization.grant || null),
      workspaceId: delegatedChildOperation?.delegatedWorkspaceId || parsedCall.envelope.workspaceId,
      intent: parsedCall.envelope.intent,
      idempotencyKey: parsedCall.envelope.idempotencyKey,
      requestedScopes: parsedCall.envelope.requestedScopes,
      ...(delegatedChildOperation ? {
        delegatedChildOperation,
        delegatedMcpGrantId: delegatedChildOperation.delegatedMcpGrantId,
        delegatedSessionId: delegatedChildOperation.delegatedSessionId,
        delegatedTurnId: delegatedChildOperation.delegatedTurnId,
        delegatedSubjectId: delegatedChildOperation.delegatedSubjectId,
        delegatedTargetId: delegatedChildOperation.delegatedTargetId,
        delegatedWorkspaceId: delegatedChildOperation.delegatedWorkspaceId,
        delegatedParentOperationId: delegatedChildOperation.parentOperationId,
        delegatedTraceId: delegatedChildOperation.traceId
      } : {})
    };
    const resolvedWorkspaceInput = await toolSkillManagementProvider.resolveMcpWorkspaceInput({
      input: parsedCall.input,
      request,
      context: mcpExecutionContext,
      signal
    });
    const result = await toolSkillManagementProvider.executeTool({
      toolId: parsedCall.operation,
      input: resolvedWorkspaceInput.input,
      request,
      authorization,
      context: mcpExecutionContext,
      dryRun: parsedCall.envelope.dryRun,
      signal
    });
    if (!result.ok) {
      const publicFailurePayload = await toolSkillManagementProvider.publicMcpToolPayload({
        payload: result.payload || {},
        workspaceDirectory: resolvedWorkspaceInput.workspaceDirectory,
        request,
        context: mcpExecutionContext,
        signal
      });
      const failureProjection = projectMcpOperationPayload(publicFailurePayload);
      const failurePayload = failureProjection.payload;
      const error = failurePayload?.error || {};
      const status = result.status || 500;
      const target = inferMcpTargetReceipt({
        operation: parsedCall.operation,
        input: resolvedWorkspaceInput.input,
        payload: failurePayload,
        envelope: parsedCall.envelope
      });
      const exchange = failureProjection.exchange;
      const publicTarget = publicMcpEnvelopeValue(target, resolvedWorkspaceInput.workspaceDirectory);
      const publicExchange = exchange
        ? publicMcpEnvelopeValue(exchange, resolvedWorkspaceInput.workspaceDirectory)
        : null;
      broadcastMcpOperationReply({
        envelope: parsedCall.envelope,
        operation: parsedCall.operation,
        status: "failed",
        target,
        exchange,
        payload: failurePayload,
        error: {
          code: error.code || "tool_call_failed",
          message: error.message || "MCP tool call failed.",
          details: error.details || {}
        },
        authorization,
        workspaceDirectory: resolvedWorkspaceInput.workspaceDirectory
      });
      return {
        httpStatus: status === 401 || status === 403 || status === 429 ? status : 200,
        body: jsonRpcError(id, -32000, error.message || "MCP tool call failed.", {
          code: error.code || "tool_call_failed",
          status,
          details: publicMcpEnvelopeValue(error.details || {}, resolvedWorkspaceInput.workspaceDirectory),
          traceId: publicMcpEnvelopeString(result.payload?.traceId || "", resolvedWorkspaceInput.workspaceDirectory),
          target: publicTarget,
          ...(publicExchange ? { exchange: publicExchange } : {})
        })
      };
    }
    const publicPayload = await toolSkillManagementProvider.publicMcpToolPayload({
      payload: executeToolPayload(result),
      workspaceDirectory: resolvedWorkspaceInput.workspaceDirectory,
      request,
      context: mcpExecutionContext,
      signal
    });
    const payloadProjection = projectMcpOperationPayload(publicPayload);
    const operationPayload = payloadProjection.payload;
    const target = inferMcpTargetReceipt({
      operation: parsedCall.operation,
      input: resolvedWorkspaceInput.input,
      payload: operationPayload,
      envelope: parsedCall.envelope
    });
    const exchange = payloadProjection.exchange;
    const publicTarget = publicMcpEnvelopeValue(target, resolvedWorkspaceInput.workspaceDirectory);
    const publicExchange = exchange
      ? publicMcpEnvelopeValue(exchange, resolvedWorkspaceInput.workspaceDirectory)
      : null;
    broadcastMcpOperationReply({
      envelope: parsedCall.envelope,
      operation: parsedCall.operation,
      status: "completed",
      target,
      exchange,
      payload: operationPayload,
      authorization,
      workspaceDirectory: resolvedWorkspaceInput.workspaceDirectory
    });
    return jsonRpcResult(id, mcpToolResult({
      result: {
        operation: parsedCall.operation,
        ...mcpVersionInfo(),
        envelope: mcpEnvelopePublic(parsedCall.envelope, resolvedWorkspaceInput.workspaceDirectory),
        target: publicTarget,
        ...(publicExchange ? { exchange: publicExchange } : {}),
        payload: operationPayload
      }
    }));
  }

  return jsonRpcError(id, -32601, "MCP method not found.");
}

export async function handleLicoMcpHttpRequest({
  request,
  response,
  requestBody,
  method,
  url,
  toolSkillManagementProvider,
  upstreamGatewayRegistry = null,
  listenUrl = "",
  discoveryState = null,
  logger = null,
  signal = null,
  inFlightRequestRegistry = null
}) {
  if (url.pathname === "/.well-known/lico/mcp.json" || url.pathname === "/api/mcp/discovery") {
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    sendJson(response, 200, buildLicoMcpDiscovery({ listenUrl, discoveryState }));
    return true;
  }

  if (url.pathname === "/api/mcp/handshake") {
    if (method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    try {
      const result = mcpHandshake({ request, requestBody, listenUrl, discoveryState });
      sendJson(response, result.status, result.body);
    } catch {
      sendJson(response, 400, {
        ok: false,
        error: "MCP handshake body must be valid JSON."
      });
    }
    return true;
  }

  if (url.pathname === "/api/mcp/local-grant/requests") {
    if (method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    if (!toolSkillManagementProvider?.createLocalMcpGrantAuthorizationRequest) {
      sendJson(response, 503, {
        ok: false,
        error: {
          code: "tool_skill_management_unavailable",
          message: "Tool/Skill management provider is unavailable."
        }
      });
      return true;
    }
    try {
      const result = await toolSkillManagementProvider.createLocalMcpGrantAuthorizationRequest({
        request,
        requestBody
      });
      sendJson(response, result.status, result.body);
    } catch (error) {
      logger?.warn?.("mcp.local_grant_authorization_request.failed", {
        reasonCode: "local_grant_authorization_request_failed",
        errorType: error?.name || "Error"
      });
      sendJson(response, 400, {
        ok: false,
        error: {
          code: "local_grant_authorization_request_failed",
          message: "MCP local installation authorization request could not be processed."
        }
      });
    }
    return true;
  }

  const localGrantConsumeMatch = url.pathname.match(/^\/api\/mcp\/local-grant\/requests\/([^/]+)\/consume$/u);
  if (localGrantConsumeMatch) {
    if (method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    if (!toolSkillManagementProvider?.consumeLocalMcpGrantAuthorizationRequest) {
      sendJson(response, 503, {
        ok: false,
        error: {
          code: "tool_skill_management_unavailable",
          message: "Tool/Skill management provider is unavailable."
        }
      });
      return true;
    }
    try {
      const result = await toolSkillManagementProvider.consumeLocalMcpGrantAuthorizationRequest({
        request,
        requestId: decodeURIComponent(localGrantConsumeMatch[1]),
        discoveryState
      });
      sendJson(response, result.status, result.body);
    } catch (error) {
      logger?.warn?.("mcp.local_grant_authorization_consume.failed", {
        reasonCode: "local_grant_authorization_consume_failed",
        errorType: error?.name || "Error"
      });
      sendJson(response, 400, {
        ok: false,
        error: {
          code: "local_grant_authorization_consume_failed",
          message: "MCP local installation authorization could not be consumed."
        }
      });
    }
    return true;
  }

  if (url.pathname === "/api/mcp/local-grant") {
    if (method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    if (!toolSkillManagementProvider) {
      sendJson(response, 503, {
        ok: false,
        error: {
          code: "tool_skill_management_unavailable",
          message: "Tool/Skill management provider is unavailable."
        }
      });
      return true;
    }
    try {
      const result = toolSkillManagementProvider.createLocalMcpGrant({
        request,
        requestBody,
        discoveryState,
        url
      });
      const awaitedResult = typeof result?.then === "function" ? await result : result;
      sendJson(response, awaitedResult.status, awaitedResult.body);
    } catch (error) {
      logger?.warn?.("mcp.local_grant.failed", {
        requestId: request?.__licoRequestId || "",
        error: error?.message || "local grant failed"
      });
      sendJson(response, 400, {
        ok: false,
        error: {
          code: "local_grant_failed",
          message: "MCP local grant request could not be processed."
        }
      });
    }
    return true;
  }

  if (url.pathname === "/api/mcp/local-uninstall") {
    if (method !== "POST") {
      response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
      response.end();
      return true;
    }
    if (!toolSkillManagementProvider) {
      sendJson(response, 503, {
        ok: false,
        error: {
          code: "tool_skill_management_unavailable",
          message: "Tool/Skill management provider is unavailable."
        }
      });
      return true;
    }
    try {
      const result = await toolSkillManagementProvider.markLocalMcpGrantUninstalled({
        request,
        requestBody,
        url,
        method
      });
      if (result?.status === 200 && result?.body?.ok === true && result.body.authorizedGrantId) {
        disconnectConfiguredMcpGrantConnections(result.body.authorizedGrantId);
      }
      sendJson(response, result.status, result.body);
    } catch (error) {
      logger?.warn?.("mcp.local_uninstall.failed", {
        requestId: request?.__licoRequestId || "",
        error: error?.message || "local uninstall update failed"
      });
      sendJson(response, 400, {
        ok: false,
        error: {
          code: "local_uninstall_failed",
          message: "MCP local uninstall update could not be processed."
        }
      });
    }
    return true;
  }

  if (url.pathname !== "/mcp") {
    return false;
  }

  if (!toolSkillManagementProvider) {
    sendJson(response, 503, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32004,
        message: "Tool/Skill management provider is unavailable."
      }
    });
    return true;
  }

  if (!isAllowedOrigin(request)) {
    sendJson(response, 403, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32003,
        message: "MCP request origin is not allowed."
      }
    });
    return true;
  }

  if (method === "HEAD") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform"
    });
    response.end();
    return true;
  }

  if (method === "GET") {
    await sendMcpSseVersionEvent(request, response, toolSkillManagementProvider, { listenUrl, discoveryState });
    return true;
  }

  if (method !== "POST") {
    response.writeHead(405, {
      Allow: "POST",
      "Cache-Control": "no-store"
    });
    response.end();
    return true;
  }

  let payload;
  try {
    payload = parseRequestBody(requestBody);
  } catch (error) {
    logger?.warn?.("mcp.http.invalid_json", {
      requestId: request?.__licoRequestId || ""
    });
    sendJson(response, 400, jsonRpcError(null, -32700, "MCP request body must be valid JSON."));
    return true;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const hasProtectedMessage = messages.some(isProtectedMcpMessage);
  const requestAuthorization = hasProtectedMessage
    ? await toolSkillManagementProvider.authorizeRequest({
        request,
        requiredScopes: [],
        recordUse: false,
        requestBody,
        url,
        method
      })
    : null;
  const cancellationOnly = messages.every((message) => String(message?.method || "").startsWith("notifications/"));
  if (hasProtectedMessage && !requestAuthorization?.ok && cancellationOnly) {
    response.writeHead(requestAuthorization?.status || 401, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  const activeRequestRegistry = inFlightRequestRegistry || mcpInFlightRequestRegistryFor(toolSkillManagementProvider);
  const results = [];
  let httpStatus = 200;
  for (const message of messages) {
    const result = await dispatchMcpMessageWithCancellation({
      message,
      request,
      authenticatedGrant: requestAuthorization,
      registry: activeRequestRegistry,
      parentSignal: signal,
      execute: (messageSignal) => handleMcpMessage({
        message,
        request,
        requestBody,
        url,
        method,
        toolSkillManagementProvider,
        upstreamGatewayRegistry,
        listenUrl,
        discoveryState,
        signal: messageSignal,
        requestAuthorization
      })
    });
    if (!result) {
      continue;
    }
    if (result.body) {
      httpStatus = Math.max(httpStatus, result.httpStatus || 200);
      results.push(result.body);
    } else {
      results.push(result);
    }
  }

  if (results.length === 0) {
    response.writeHead(202, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }

  sendJson(response, httpStatus, Array.isArray(payload) ? results : results[0]);
  return true;
}
