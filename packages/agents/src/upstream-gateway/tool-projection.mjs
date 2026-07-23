import {
  asArray,
  mcpToolRisk,
  normalizeRisk,
  object,
  safePublicToolSegment,
  text
} from "./support.mjs";
import { compileUpstreamOperationCapability } from "./operation-capability.mjs";

function gatewayToolsetsForRisk(risk = "read_only") {
  if (risk === "read_only") return ["lico.gateway.read"];
  if (risk === "repair_write" || risk === "destructive") {
    return ["lico.gateway.write", "lico.gateway.maintain"];
  }
  return ["lico.gateway.write"];
}

export function publicUpstreamMcpTool({ service = {}, tool = {} } = {}) {
  const prefix = service.mcp?.toolNamePrefix || safePublicToolSegment(service.serviceId);
  const upstreamToolName = text(tool.name);
  const risk = mcpToolRisk(tool);
  const readOnly = risk === "read_only";
  const dynamicCapability = compileUpstreamOperationCapability(service, {
    operationKey: "tools/call",
    protocol: "mcp",
    requiredScopes: readOnly ? ["gateway:read"] : ["gateway:write"],
    risk,
    requiresApproval: risk === "repair_write" || risk === "destructive"
  }, { upstreamToolName });
  return {
    name: `upstream.${prefix}.${upstreamToolName}`,
    title: `${service.label || service.serviceId}: ${tool.title || upstreamToolName}`,
    description: tool.description || `Upstream MCP tool ${upstreamToolName} from ${service.label || service.serviceId}.`,
    inputSchema: object(tool.inputSchema).type ? tool.inputSchema : { type: "object", additionalProperties: true },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: tool.annotations?.destructiveHint === true
    },
    _meta: {
      upstreamMcp: true,
      serviceId: service.serviceId,
      upstreamToolName,
      capabilityId: dynamicCapability.capabilityId,
      requiredCapabilities: [dynamicCapability.capabilityId],
      dynamicCapability,
      resourceContext: dynamicCapability.resourceContext,
      toolsets: ["upstream-mcp", ...gatewayToolsetsForRisk(risk), `upstream:${service.serviceId}`],
      requiredScopes: readOnly ? ["gateway:read"] : ["gateway:write"],
      risk
    }
  };
}

export function publicUpstreamOperationTool({ service = {}, operation = {} } = {}) {
  const prefix = safePublicToolSegment(service.serviceId);
  const operationSegment = safePublicToolSegment(operation.operationKey);
  const risk = normalizeRisk(operation.risk);
  const readOnly = risk === "read_only";
  const requestSchema = object(operation.requestSchema);
  const dynamicCapability = compileUpstreamOperationCapability(service, operation);
  const toolId = `upstream.${prefix}.${operationSegment}`;
  return {
    name: toolId,
    title: `${service.label || service.serviceId}: ${operation.label || operation.operationKey}`,
    description: operation.description ||
      `Configured upstream ${operation.protocol || "http"} operation ${operation.operationKey} from ${service.label || service.serviceId}.`,
    inputSchema: requestSchema.type ? requestSchema : {
      type: "object",
      additionalProperties: true
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: risk === "destructive"
    },
    _meta: {
      upstreamConfiguredOperation: true,
      toolId,
      serviceId: service.serviceId,
      operationKey: operation.operationKey,
      capabilityId: dynamicCapability.capabilityId,
      requiredCapabilities: [dynamicCapability.capabilityId],
      dynamicCapability,
      resourceContext: dynamicCapability.resourceContext,
      protocol: operation.protocol || "http",
      method: operation.method || "POST",
      payloadTransport: operation.payloadTransport || null,
      toolsets: ["upstream-gateway", ...gatewayToolsetsForRisk(risk), `upstream:${service.serviceId}`],
      requiredScopes: asArray(operation.requiredScopes),
      risk,
      requiresApproval: operation.requiresApproval === true
    }
  };
}
