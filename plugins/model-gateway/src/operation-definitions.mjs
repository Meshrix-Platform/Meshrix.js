const TRAFFIC_MODEL = "gateway_transit";

function resource(capabilityVerb, effectKind, fieldMap = {}) {
  return Object.freeze({
    capabilityDomain: "model_gateway",
    resourceKind: "model_service",
    capabilityVerb,
    effectKind,
    fieldMap: Object.freeze(fieldMap)
  });
}

function definition({ id, label, requiredScopes, readOnly, inputSchema, fieldMap = {} }) {
  const risk = readOnly ? "read_only" : "safe_write";
  const operationResource = resource(id.split(".").at(-1).replace(/_/gu, "-"), readOnly ? "read" : "external-effect", fieldMap);
  return Object.freeze({
    id,
    feature: "model_gateway",
    featureId: "model-gateway",
    trafficModel: TRAFFIC_MODEL,
    label,
    description: `${label} through the configured standalone Model Gateway Service.`,
    target: Object.freeze({ controller: "plugin", method: "execute" }),
    rpc: Object.freeze({ method: id, body: "params" }),
    cli: Object.freeze({ command: Object.freeze(id.split(".")), usage: id.replaceAll(".", " ") }),
    requiredScopes: Object.freeze(requiredScopes),
    toolsets: Object.freeze(["meshrix.model.gateway"]),
    readOnly,
    concurrencySafe: readOnly,
    safety: Object.freeze({ risk, requiresConfirmation: false }),
    risk,
    aspects: Object.freeze([
      "model-gateway",
      "gateway-transit",
      "mcp",
      "dispatch",
      "authorization",
      "safety",
      "audit",
      "operation-proof"
    ]),
    resource: operationResource,
    resourceContext: operationResource,
    proof: Object.freeze({ binding: "proof-bound", lifecycle: "two-stage", substrate: "operation-proof-substrate" }),
    inputSchema: Object.freeze(inputSchema),
    audit: Object.freeze({ recordInput: false, recordOutput: false, metadataOnly: true }),
    log: Object.freeze({ recordInput: false, recordOutput: false, redaction: "strict" })
  });
}

export const MODEL_GATEWAY_OPERATION_DEFINITIONS = Object.freeze([
  definition({
    id: "model_gateway.call",
    label: "Call Model Gateway",
    requiredScopes: ["model:call"],
    readOnly: false,
    fieldMap: { modelRef: "modelRef", providerRef: "providerRef" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["modelRef", "providerRef", "inputRefs", "idempotencyKey", "deadlineMs", "stream"],
      properties: {
        modelRef: { type: "string", minLength: 1, maxLength: 256 },
        providerRef: { type: "string", minLength: 1, maxLength: 256 },
        inputRefs: { type: "array", maxItems: 64, items: { type: "string", minLength: 1, maxLength: 1024 } },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        deadlineMs: { type: "integer", minimum: 1 },
        stream: { type: "boolean" }
      }
    }
  }),
  definition({
    id: "models.list",
    label: "List Model Gateway models",
    requiredScopes: ["model:read"],
    readOnly: true,
    inputSchema: { type: "object", additionalProperties: false, properties: {} }
  }),
  definition({
    id: "models.get",
    label: "Read a Model Gateway model",
    requiredScopes: ["model:read"],
    readOnly: true,
    fieldMap: { modelRef: "modelRef" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["modelRef"],
      properties: { modelRef: { type: "string", minLength: 1, maxLength: 256 } }
    }
  })
]);

export const MODEL_GATEWAY_OPERATIONS_BY_ID = Object.freeze(Object.fromEntries(
  MODEL_GATEWAY_OPERATION_DEFINITIONS.map((operation) => [operation.id, operation])
));

export const MODEL_GATEWAY_MCP_TOOL_BINDINGS = Object.freeze({
  "meshrix.modelGateway.call": Object.freeze({ operationId: "model_gateway.call", outlet: "meshrix.gateway" }),
  "meshrix.modelGateway.models.list": Object.freeze({ operationId: "models.list", outlet: "meshrix.gateway" }),
  "meshrix.modelGateway.models.get": Object.freeze({ operationId: "models.get", outlet: "meshrix.gateway" })
});

export const PLUGIN_OPERATION_DEFINITIONS = MODEL_GATEWAY_OPERATION_DEFINITIONS;
