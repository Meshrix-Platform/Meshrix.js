import { createHash } from "node:crypto";
import { compileUpstreamOperationCapability } from "./operation-capability.ts";
import { safePublicToolSegment } from "./support.ts";

function digest(value?: any) : any {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function upstreamProjectedOperationId(serviceId?: any, operationKey?: any) : any {
  return `upstream_operation.${digest(`${serviceId}\0${operationKey}`)}`;
}

function projectedToolsets(capability?: any) : any {
  // Only attach toolsets whose configured maxRisk can host the projected risk.
  // Destructive ops need meshrix.gateway.maintain (maxRisk destructive); write alone is filtered out by OP catalog.
  if (capability.risk === "read_only") return ["meshrix.gateway.read"];
  if (capability.risk === "repair_write" || capability.risk === "destructive") {
    return ["meshrix.gateway.maintain"];
  }
  return ["meshrix.gateway.write"];
}

function projectedForwardInputSchema(operation: Record<string, any> = {}) : any {
  const requestSchema: any = operation.requestSchema && typeof operation.requestSchema === "object" && !Array.isArray(operation.requestSchema)
    ? operation.requestSchema
    : { type: "object" };
  const requestProperties: any = requestSchema.properties && typeof requestSchema.properties === "object" && !Array.isArray(requestSchema.properties)
    ? requestSchema.properties
    : {};
  return Object.freeze({
    type: "object",
    additionalProperties: true,
    // Declare forward envelope fields so Operation Permission keeps body/query wrappers
    // when MCP/console callers use the same shape as gateway.forward.
    properties: Object.freeze({
      ...requestProperties,
      serviceId: { type: "string" },
      operationKey: { type: "string" },
      toolName: { type: "string" },
      arguments: { type: "object" },
      query: { type: "object" },
      params: { type: "object" },
      rpcParams: { type: "object" },
      rpcId: { type: "string" },
      body: {},
      bodyJson: {},
      payload: { type: "object" }
    })
  });
}

export function compileUpstreamOperationProjection(snapshot?: any) : any {
  if (!Array.isArray(snapshot?.serviceEntries) || !Number.isSafeInteger(snapshot.setRevision)) {
    throw new TypeError("Upstream operation projection requires a validated manifest snapshot.");
  }
  const operations: any[] = [];
  const targets: any = new Map<any, any>();
  const toolIds: any = new Set<any>();
  for (const [serviceId, service] of snapshot.serviceEntries) {
    if (service.disabled === true) continue;
    for (const operation of service.operations || []) {
      const operationId: any = upstreamProjectedOperationId(serviceId, operation.operationKey);
      const toolId: any = `upstream.${safePublicToolSegment(serviceId)}.${safePublicToolSegment(operation.operationKey)}`;
      if (targets.has(operationId) || toolIds.has(toolId)) {
        throw new Error("Upstream operation projection contains duplicate identities.");
      }
      const dynamicCapability: any = compileUpstreamOperationCapability(service, operation);
      const risk: any = dynamicCapability.risk;
      const requiresApproval: any = dynamicCapability.approvalPolicy.requiresApproval === true;
      const projected: Readonly<Record<string, any>> = Object.freeze({
        id: operationId,
        toolId,
        feature: "upstream-gateway",
        featureId: "upstream-gateway",
        label: String(operation.label || `${service.label}: ${operation.operationKey}`),
        description: `Governed operation published by upstream service ${serviceId}.`,
        target: { controller: "system", method: "handleUpstreamGatewayOperation" },
        http: { method: "POST", path: `/api/gateway/v1/projected/${operationId.slice("upstream_operation.".length)}`, localInForwardMode: true },
        requiredScopes: Object.freeze([...dynamicCapability.requiredScopes]),
        readOnly: risk === "read_only",
        concurrency: risk === "read_only"
          ? { workloadClass: "light", maxParallel: 64, cost: 1 }
          : { workloadClass: "standard", key: `upstream:${serviceId}`, maxParallel: 1, cost: 2 },
        execution: { timeoutMs: operation.timeoutMs || 30_000 },
        safety: {
          risk,
          requiresConfirmation: requiresApproval,
          approvalScope: dynamicCapability.approvalPolicy.approvalScope
        },
        toolsets: Object.freeze(projectedToolsets(dynamicCapability)),
        resourceContext: Object.freeze(dynamicCapability.resourceContext),
        payloadTransport: operation.payloadTransport || null,
        inputSchema: projectedForwardInputSchema(operation),
        audit: { recordInput: false, metadataOnly: true },
        log: { recordInput: false },
        aspects: Object.freeze(["upstream-gateway", "operation-permission", "published-operation"]),
        _meta: Object.freeze({
          upstreamProjectedOperation: true,
          sourceRevision: snapshot.setRevision,
          sourceDigest: snapshot.setDigest,
          serviceId,
          serviceRevision: service.serviceRevision,
          operationKey: operation.operationKey,
          protocol: operation.protocol,
          payloadTransport: operation.payloadTransport || null,
          dynamicCapability: Object.freeze(dynamicCapability),
          resourceContext: Object.freeze(dynamicCapability.resourceContext)
        })
      });
      operations.push(projected);
      targets.set(operationId, Object.freeze({ serviceId, operationKey: operation.operationKey }));
      toolIds.add(toolId);
    }
  }
  operations.sort((left?: any, right?: any) : any => left.id.localeCompare(right.id));
  return Object.freeze({
    sourceRevision: snapshot.setRevision,
    sourceDigest: snapshot.setDigest,
    operations: Object.freeze(operations),
    targets
  });
}
