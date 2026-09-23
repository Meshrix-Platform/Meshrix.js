import { CLOSED_EMPTY_JSON_OBJECT_SCHEMA } from "@meshrix/foundation/security/closed-json-schema";
import { assertExternalSchemaBudget } from "@meshrix/gateway/schema";
import {
  asArray,
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
  { requireTopLevelObject = true, kind = "input", closedWhenAbsent = false }: Record<string, any> = {}
) : any {
  if (schema === undefined) return closedWhenAbsent ? CLOSED_EMPTY_JSON_OBJECT_SCHEMA : { type: "object" };
  try {
    if (requireTopLevelObject && (typeof schema !== "object" || schema === null || Array.isArray(schema) || "type" in schema && schema.type !== "object")) throw invalidToolSchemaError(kind);
    assertExternalSchemaBudget(schema);
    return structuredClone(schema);
  } catch {
    throw invalidToolSchemaError(kind);
  }
}

function safeNamespacedUpstreamMeta(meta: Record<string, any> = {}) : any {
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(object(meta)) as [string, any][]) {
    if (typeof key !== "string" || !key.includes("/")) continue;
    if (key.startsWith("io.meshrix/")) continue;
    output[key] = value;
  }
  return output;
}

function mcpToolAnnotations(tool: Record<string, any> = {}) : any {
  const annotations: any = object(tool.annotations);
  return { ...annotations };
}

function operatorMcpOperation(service: Record<string, any> = {}) : Record<string, any> {
  return asArray(service.operations).find((operation: any) => text(operation?.operationKey || operation?.operationId) === "tools/call") || {};
}

function operatorMcpRisk(service: Record<string, any> = {}) : any {
  return normalizeRisk(operatorMcpOperation(service).risk);
}

/**
 * The request schema the operator actually declared.
 *
 * The normalized service model stores an undeclared request schema as an empty object
 * (`support.ts` reads the manifest value through `object(...)`), so an empty object is that
 * model's canonical "no input declared" value and has to compile as the platform's closed
 * empty object, exactly as an undefined schema does. Passing it to the closed-schema
 * compiler as a declared schema instead fails the whole projection, which also removes
 * every other upstream tool from the catalog listing it is compiled for.
 */
function declaredRequestSchema(schema?: any) : any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return Object.keys(schema).length === 0 ? undefined : schema;
}

export function publicUpstreamMcpTool({ service = {}, tool = {} }: Record<string, any> = {}) : any {
  const prefix: any = service.mcp?.toolNamePrefix || safePublicToolSegment(service.serviceId);
  const upstreamToolName: any = text(tool.name);
  const configuredOperation: any = operatorMcpOperation(service);
  const risk: any = operatorMcpRisk(service);
  const requiresApproval: any = configuredOperation.requiresApproval === true || risk === "repair_write" || risk === "destructive";
  const dynamicCapability: any = compileUpstreamOperationCapability(service, {
    operationKey: "tools/call",
    protocol: "mcp",
    requiredScopes: asArray(configuredOperation.requiredScopes || (risk === "read_only" ? ["gateway:read"] : ["gateway:write"])),
    risk,
    requiresApproval
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
    annotations: mcpToolAnnotations(tool),
    _meta: {
      ...safeNamespacedUpstreamMeta(tool._meta),
      upstreamMcp: true,
      // The projected operation every discovered tool of this service executes as. It is
      // the identity Operation Permission governs, so a peer (and the gateway sink) can
      // address the governed operation rather than the discovered tool name alone.
      toolId: `upstream.${safePublicToolSegment(service.serviceId)}.${safePublicToolSegment(configuredOperation.operationKey || "tools/call")}`,
      serviceId: service.serviceId,
      upstreamToolName,
      capabilityId: dynamicCapability.capabilityId,
      requiredCapabilities: [dynamicCapability.capabilityId],
      dynamicCapability,
      resourceContext: dynamicCapability.resourceContext,
      toolsets: ["upstream-mcp", ...gatewayToolsetsForRisk(risk), `upstream:${service.serviceId}`],
      requiredScopes: asArray(configuredOperation.requiredScopes || (risk === "read_only" ? ["gateway:read"] : ["gateway:write"])),
      risk,
      requiresApproval,
      "io.meshrix/gateway-policy": {
        source: "operator-service-operation",
        effectClass: risk,
        requiresApproval
      }
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
      declaredRequestSchema(operation.requestSchema),
      "Configured upstream operation input schema",
      { requireTopLevelObject: true, kind: "input", closedWhenAbsent: true }
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
