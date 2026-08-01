import {
  asArray,
  hash,
  normalizeRisk,
  safePublicToolSegment,
  text
} from "./support.ts";

const DESCRIPTOR_VERSION: any = "v0.0.1:upstream-gateway:operation-capability-1";

function unique(values: any = []) : any {
  return [...new Set<any>(values.map((value?: any) : any => text(value)).filter(Boolean))];
}

function capabilityOperationSegment(operation: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const upstreamToolName: any = text(options.upstreamToolName || operation.upstreamToolName || operation.toolName);
  if (upstreamToolName && text(operation.operationKey) === "tools/call") {
    return `tools-call-${safePublicToolSegment(upstreamToolName)}`;
  }
  return safePublicToolSegment(operation.operationKey || upstreamToolName || "default");
}

export function upstreamOperationCapabilityId(service: Record<string, any> = {}, operation: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  return `cap:upstream:${safePublicToolSegment(service.serviceId)}:${capabilityOperationSegment(operation, options)}`;
}

export function compileUpstreamOperationCapability(service: Record<string, any> = {}, operation: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const serviceId: any = text(service.serviceId);
  const operationKey: any = text(operation.operationKey || "default");
  const upstreamToolName: any = text(options.upstreamToolName || operation.upstreamToolName || operation.toolName);
  const capabilityId: any = upstreamOperationCapabilityId(service, operation, { upstreamToolName });
  const credentialBindingIds: any = unique(asArray(service.credentialRefs).map((ref?: any) : any => `credential:${hash(ref, 16)}`));
  const risk: any = normalizeRisk(operation.risk);
  const tupleCapabilityIds: any = unique([
    `cap:upstream-tuple:${safePublicToolSegment(serviceId)}:${capabilityOperationSegment(operation, { upstreamToolName })}:risk:${risk}`,
    ...credentialBindingIds.map((bindingId?: any) : any => `${capabilityId}:${bindingId}`)
  ]);
  return {
    schemaVersion: DESCRIPTOR_VERSION,
    capabilityId,
    tupleCapabilityIds,
    serviceId,
    operationKey,
    upstreamToolName,
    protocol: text(operation.protocol || service.serviceProtocol || "http"),
    risk,
    requiredScopes: unique(asArray(operation.requiredScopes)),
    toolsets: unique([
      ...(risk === "read_only" ? ["meshrix.gateway.read"] : ["meshrix.gateway.write"]),
      risk === "repair_write" || risk === "destructive" ? "meshrix.gateway.maintain" : "",
      `upstream:${serviceId}`
    ]),
    approvalPolicy: {
      requiresApproval: operation.requiresApproval === true,
      approvalScope: text(operation.approvalScope || operation.safety?.approvalScope || operation.requiredScopes?.[0] || ""),
      requiredApproval: operation.requiredApproval && typeof operation.requiredApproval === "object" && !Array.isArray(operation.requiredApproval)
        ? operation.requiredApproval
        : {}
    },
    credentialBindingIds,
    resourceContext: {
      serviceId,
      serviceIds: [serviceId],
      secretBindingId: credentialBindingIds[0] || "",
      secretBindingIds: credentialBindingIds,
      requestedEgress: text(service.serviceProtocol || operation.protocol || "http"),
      requestedEgresses: unique([service.serviceProtocol, operation.protocol, operation.method].filter(Boolean)),
      resourceKind: "upstream-service-operation",
      capabilityDomain: "upstream-gateway",
      capabilityVerb: operationKey
    }
  };
}

export function operationWithUpstreamCapability(service: Record<string, any> = {}, operation: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const dynamicCapability: any = operation.dynamicCapability || compileUpstreamOperationCapability(service, operation, options);
  return {
    ...operation,
    dynamicCapability,
    resourceContext: {
      ...(operation.resourceContext || {}),
      ...dynamicCapability.resourceContext
    }
  };
}

export function evaluateDynamicOperationAuthorization(subject: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  if (text(subject.type) !== "tool-grant") {
    return { allowed: true, reasonCode: "not_tool_grant" };
  }
  const descriptor: any = operation.dynamicCapability || {};
  const capabilityId: any = text(descriptor.capabilityId);
  const capabilities: any = new Set<any>(asArray(subject.dynamicCapabilities).map(text).filter(Boolean));
  if (!capabilityId || !capabilities.has(capabilityId)) {
    return { allowed: false, reasonCode: "missing_dynamic_upstream_capability", capabilityId };
  }
  const allowedServiceIds: any = new Set<any>(asArray(subject.allowedServiceIds).map(text).filter(Boolean));
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(descriptor.serviceId)) {
    return { allowed: false, reasonCode: "upstream_service_binding_denied", capabilityId };
  }
  const allowedSecretBindings: any = new Set<any>(asArray(subject.allowedSecretBindings).map(text).filter(Boolean));
  const missingCredentialBindings: any = asArray(descriptor.credentialBindingIds).map(text).filter(Boolean)
    .filter((bindingId?: any) : any =>
      !allowedSecretBindings.has(bindingId) && !capabilities.has(`${capabilityId}:${bindingId}`)
    );
  if (missingCredentialBindings.length > 0) {
    return { allowed: false, reasonCode: "upstream_credential_binding_denied", capabilityId };
  }
  return { allowed: true, reasonCode: "dynamic_upstream_capability_allowed", capabilityId };
}
