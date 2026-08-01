import {
  CLOSED_EMPTY_JSON_OBJECT_SCHEMA,
  compileClosedJsonSchema
} from "@meshrix/foundation/security/closed-json-schema";
import {
  asArray,
  mcpToolRisk,
  normalizeRisk,
  safePublicToolSegment,
  text
} from "./support.ts";
import { compileUpstreamOperationCapability } from "./operation-capability.ts";

function gatewayToolsetsForRisk(risk: any = "read_only") : any {
  if (risk === "read_only") return ["meshrix.gateway.read"];
  if (risk === "repair_write" || risk === "destructive") {
    return ["meshrix.gateway.write", "meshrix.gateway.maintain"];
  }
  return ["meshrix.gateway.write"];
}

function invalidToolSchemaError() : any {
  return Object.assign(new Error("Upstream tool input schema is invalid."), {
    code: "upstream_tool_schema_invalid",
    status: 502
  });
}

function projectedInputSchema(schema?: any, label?: any) : any {
  if (schema === undefined) return CLOSED_EMPTY_JSON_OBJECT_SCHEMA;
  try {
    return compileClosedJsonSchema(schema, {
      label,
      requireTopLevelObject: true
    }).schema;
  } catch {
    throw invalidToolSchemaError();
  }
}

export function publicUpstreamMcpTool({ service = {}, tool = {} }: Record<string, any> = {}) : any {
  const prefix: any = service.mcp?.toolNamePrefix || safePublicToolSegment(service.serviceId);
  const upstreamToolName: any = text(tool.name);
  const risk: any = mcpToolRisk(tool);
  const readOnly: any = risk === "read_only";
  const dynamicCapability: any = compileUpstreamOperationCapability(service, {
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
    inputSchema: projectedInputSchema(tool.inputSchema, "Upstream MCP tool input schema"),
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

export function publicUpstreamOperationTool({ service = {}, operation = {} }: Record<string, any> = {}) : any {
  const prefix: any = safePublicToolSegment(service.serviceId);
  const operationSegment: any = safePublicToolSegment(operation.operationKey);
  const risk: any = normalizeRisk(operation.risk);
  const readOnly: any = risk === "read_only";
  const dynamicCapability: any = compileUpstreamOperationCapability(service, operation);
  const toolId: any = `upstream.${prefix}.${operationSegment}`;
  return {
    name: toolId,
    title: `${service.label || service.serviceId}: ${operation.label || operation.operationKey}`,
    description: operation.description ||
      `Configured upstream ${operation.protocol || "http"} operation ${operation.operationKey} from ${service.label || service.serviceId}.`,
    inputSchema: projectedInputSchema(
      operation.requestSchema,
      "Configured upstream operation input schema"
    ),
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
