import { CLOSED_EMPTY_JSON_OBJECT_SCHEMA } from "@meshrix/foundation/security/closed-json-schema";
import { compileMcpToolJsonSchema } from "./mcp-tool-schema.ts";
import {
  asArray,
  mcpToolRisk,
  normalizeRisk,
  object,
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

function invalidToolSchemaError(kind: any = "input") : any {
  if (kind === "output") {
    return Object.assign(new Error("Upstream tool output schema is invalid."), {
      code: "upstream_tool_output_schema_invalid",
      status: 502
    });
  }
  return Object.assign(new Error("Upstream tool input schema is invalid."), {
    code: "upstream_tool_schema_invalid",
    status: 502
  });
}

function projectedMcpSchema(
  schema?: any,
  label?: any,
  { requireTopLevelObject = true, kind = "input" }: Record<string, any> = {}
) : any {
  if (schema === undefined) return CLOSED_EMPTY_JSON_OBJECT_SCHEMA;
  try {
    return compileMcpToolJsonSchema(schema, {
      label,
      requireTopLevelObject
    }).schema;
  } catch {
    throw invalidToolSchemaError(kind);
  }
}

function safeNamespacedUpstreamMeta(meta: Record<string, any> = {}) : any {
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(object(meta)) as [string, any][]) {
    if (typeof key !== "string" || !key.includes("/")) continue;
    if (["toolExecutionId", "traceId", "auditId"].includes(key.split("/").pop() || "")) continue;
    output[key] = value;
  }
  return output;
}

function mcpToolAnnotations(tool: Record<string, any> = {}, readOnly?: any) : any {
  const annotations: any = object(tool.annotations);
  return {
    readOnlyHint: annotations.readOnlyHint === true || readOnly === true,
    destructiveHint: annotations.destructiveHint === true,
    ...(typeof annotations.idempotentHint === "boolean" ? { idempotentHint: annotations.idempotentHint } : {}),
    ...(typeof annotations.openWorldHint === "boolean" ? { openWorldHint: annotations.openWorldHint } : {})
  };
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
    inputSchema: projectedMcpSchema(tool.inputSchema, "Upstream MCP tool input schema", {
      requireTopLevelObject: true,
      kind: "input"
    }),
    ...(tool.outputSchema === undefined
      ? {}
      : {
          outputSchema: projectedMcpSchema(tool.outputSchema, "Upstream MCP tool output schema", {
            requireTopLevelObject: false,
            kind: "output"
          })
        }),
    annotations: mcpToolAnnotations(tool, readOnly),
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
      risk,
      ...safeNamespacedUpstreamMeta(tool._meta)
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
    inputSchema: projectedMcpSchema(
      operation.requestSchema,
      "Configured upstream operation input schema",
      { requireTopLevelObject: true, kind: "input" }
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
