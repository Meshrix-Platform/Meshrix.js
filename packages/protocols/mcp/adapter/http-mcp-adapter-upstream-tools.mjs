import {
  executeToolPayload,
  jsonRpcError,
  jsonRpcResult,
  mcpToolResult,
  publicMcpEnvelopeString,
  publicMcpEnvelopeValue
} from "./http-mcp-adapter-response.mjs";
import {
  mcpAuthSessionFromGrant,
  mcpSubjectFromGrant
} from "./http-mcp-adapter-session.mjs";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasForwardInputShape(value = {}) {
  return ["body", "bodyJson", "payload", "query", "rpcParams", "params", "arguments"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function gatewayForwardInputForUpstreamTool(tool = {}, args = {}) {
  const meta = plainObject(tool._meta);
  const serviceId = String(meta.serviceId || "").trim();
  if (meta.upstreamMcp === true) {
    return {
      serviceId,
      operationKey: "tools/call",
      toolName: String(meta.upstreamToolName || "").trim(),
      upstreamPublicToolName: String(tool.name || "").trim(),
      arguments: plainObject(args)
    };
  }
  const base = {
    serviceId,
    operationKey: String(meta.operationKey || "").trim()
  };
  const input = plainObject(args);
  const requestRepresentation = plainObject(meta.payloadTransport).request;
  if (["artifact_body", "artifact_multipart"].includes(String(requestRepresentation?.mode || ""))) {
    return { ...base, arguments: input };
  }
  if (hasForwardInputShape(input)) {
    return { ...base, ...input };
  }
  if (String(meta.protocol || "").toLowerCase() === "json-rpc") {
    return { ...base, rpcParams: input };
  }
  const method = String(meta.method || "POST").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { ...base, query: input };
  }
  return { ...base, body: input };
}

function artifactResourceFrom(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (
    typeof value.uri === "string" &&
    typeof value.name === "string" &&
    typeof value.mediaType === "string" &&
    Number.isSafeInteger(Number(value.byteLength))
  ) {
    return value;
  }
  for (const key of ["resource", "artifact", "response", "payload", "result", "data"]) {
    const found = artifactResourceFrom(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

async function publicToolPayloadForProvider(toolSkillManagementProvider, {
  payload,
  request,
  context,
  signal = null
} = {}) {
  if (typeof toolSkillManagementProvider?.publicMcpToolPayload === "function") {
    return toolSkillManagementProvider.publicMcpToolPayload({
      payload,
      workspaceDirectory: null,
      request,
      context,
      signal
    });
  }
  return publicMcpEnvelopeValue(payload || {});
}

export async function executeUpstreamToolViaGatewayForward({
  id,
  toolName,
  visibleTool,
  params,
  request,
  toolSkillManagementProvider,
  authorization,
  signal = null
}) {
  if (typeof toolSkillManagementProvider?.executeTool !== "function") {
    return {
      httpStatus: 503,
      body: jsonRpcError(id, -32000, "Operation Permission execution is unavailable for upstream tools.", {
        code: "operation_permission_execution_unavailable",
        toolName
      })
    };
  }
  const grantSubject = mcpSubjectFromGrant(authorization.grant || null);
  const grantMetadata = plainObject(authorization.grant?.metadata);
  const dynamicCapability = plainObject(visibleTool?._meta?.dynamicCapability);
  const grantAgentId = String(
    authorization.grant?.agentId ||
      authorization.grant?.agentProfileId ||
      grantMetadata.agentId ||
      grantMetadata.agentProfileId ||
      grantMetadata.profileId ||
      ""
  ).trim();
  const context = {
    transport: "mcp",
    client: request?.headers?.["user-agent"] || "",
    traceId: request?.__licoRequestId || "",
    operatorId: grantAgentId || grantSubject.subjectId || authorization.grant?.id || "",
    agentId: grantAgentId,
    profileId: grantAgentId,
    agentProfileId: grantAgentId,
    subject: grantSubject,
    authSession: mcpAuthSessionFromGrant(authorization.grant || null),
    intent: toolName,
    requestedScopes: visibleTool?._meta?.requiredScopes || [],
    // Published upstream capability identities are evaluated by Operation Permission's
    // dynamic-capability branch below. They are not static credential capabilities.
    requestedCapabilities: [],
    dynamicCapability,
    resourceContext: plainObject(dynamicCapability.resourceContext || visibleTool?._meta?.resourceContext),
    upstreamTool: {
      toolName,
      serviceId: visibleTool?._meta?.serviceId || "",
      operationKey: visibleTool?._meta?.operationKey || visibleTool?._meta?.upstreamToolName || "",
      risk: visibleTool?._meta?.risk || "",
      capabilityId: dynamicCapability.capabilityId || visibleTool?._meta?.capabilityId || ""
    }
  };
  const input = gatewayForwardInputForUpstreamTool(
    visibleTool,
    params.arguments && typeof params.arguments === "object" ? params.arguments : {}
  );
  // Configured published operations and remote MCP tools/call use projected Operation Permission tools.
  // Local stdio operator config remains outside developer publishing; remote MCP shares tools/call projection.
  const serviceId = String(visibleTool?._meta?.serviceId || "").trim();
  const projectedToolsCallId = serviceId
    ? `upstream.${serviceId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "service"}.tools-call`
    : "";
  const configuredToolId = String(
    visibleTool?._meta?.toolId ||
      (visibleTool?._meta?.upstreamConfiguredOperation === true ? toolName : "") ||
      ""
  ).trim();
  const executionToolId = visibleTool?._meta?.upstreamConfiguredOperation === true && configuredToolId
    ? configuredToolId
    : visibleTool?._meta?.upstreamMcp === true && projectedToolsCallId
      ? projectedToolsCallId
      : "meshrix.gateway.forward";
  const result = await toolSkillManagementProvider.executeTool({
    toolId: executionToolId,
    input,
    request,
    authorization,
    context,
    signal
  });
  const publicPayload = await publicToolPayloadForProvider(toolSkillManagementProvider, {
    payload: executeToolPayload(result),
    request,
    context,
    signal
  });
  if (!result.ok) {
    const error = publicPayload?.error || {};
    const status = result.status || 500;
    return {
      httpStatus: status === 401 || status === 403 || status === 429 ? status : 200,
      body: jsonRpcError(id, -32000, error.message || "Upstream MCP tool call failed.", {
        code: error.code || "upstream_tool_call_failed",
        status,
        toolName,
        details: publicMcpEnvelopeValue(error.details || {}),
        traceId: publicMcpEnvelopeString(result.payload?.traceId || "")
      })
    };
  }
  const resultPayload = {
    result: {
      upstreamMcp: visibleTool?._meta?.upstreamMcp === true,
      upstreamConfiguredOperation: visibleTool?._meta?.upstreamConfiguredOperation === true,
      toolName,
      operation: executionToolId,
      capabilityId: dynamicCapability.capabilityId || visibleTool?._meta?.capabilityId || "",
      dynamicCapability,
      toolExecutionId: publicPayload?.toolExecutionId || result.payload?.toolExecutionId || "",
      traceId: publicPayload?.traceId || result.payload?.traceId || "",
      payload: publicPayload
    }
  };
  const artifact = artifactResourceFrom(publicPayload);
  if (artifact) {
    resultPayload.content = [{
      type: "resource_link",
      uri: artifact.uri,
      name: artifact.name,
      mimeType: artifact.mediaType,
      size: Number(artifact.byteLength)
    }];
  }
  return jsonRpcResult(id, mcpToolResult(resultPayload));
}
