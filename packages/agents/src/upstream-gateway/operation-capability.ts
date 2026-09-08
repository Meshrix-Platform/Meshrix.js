import {
  asArray,
  hash,
  normalizeRisk,
  object,
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

function hasOwn(value: Record<string, any> = {}, key?: any) : any {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function subjectDeclaredAuthority(subject: Record<string, any> = {}, keys: any = []) : any {
  return keys.some((key?: any) : any => hasOwn(subject, key));
}

function stringSet(values: any = []) : any {
  return new Set<any>(asArray(values).map(text).filter(Boolean));
}

function governedSubjectCapabilitySet(subject: Record<string, any> = {}) : any {
  if (subjectDeclaredAuthority(subject, ["dynamicCapabilities", "capabilities", "upstreamCapabilities"])) {
    return stringSet([
      ...asArray(subject.dynamicCapabilities),
      ...asArray(subject.capabilities),
      ...asArray(subject.upstreamCapabilities)
    ]);
  }
  const grant: any = object(subject.grant);
  const metadata: any = object(grant.metadata);
  return stringSet([
    ...asArray(grant.dynamicCapabilities),
    ...asArray(grant.capabilities),
    ...asArray(grant.upstreamCapabilities),
    ...asArray(metadata.dynamicCapabilities),
    ...asArray(metadata.capabilities),
    ...asArray(metadata.upstreamCapabilities)
  ]);
}

function governedSubjectAllowedServiceIds(subject: Record<string, any> = {}) : any {
  if (subjectDeclaredAuthority(subject, ["allowedServiceIds"])) {
    return stringSet(subject.allowedServiceIds);
  }
  const grant: any = object(subject.grant);
  const metadata: any = object(grant.metadata);
  return stringSet([
    ...asArray(grant.allowedServiceIds),
    ...asArray(metadata.allowedServiceIds)
  ]);
}

function governedSubjectAllowedSecretBindings(subject: Record<string, any> = {}) : any {
  if (subjectDeclaredAuthority(subject, ["allowedSecretBindings"])) {
    return stringSet(subject.allowedSecretBindings);
  }
  const grant: any = object(subject.grant);
  const metadata: any = object(grant.metadata);
  return stringSet([
    ...asArray(grant.allowedSecretBindings),
    ...asArray(metadata.allowedSecretBindings)
  ]);
}

export function evaluateDynamicOperationAuthorization(subject: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  const subjectType: any = text(subject.type);
  if (subjectType !== "tool-grant" && subjectType !== "scoped-api-key") {
    return { allowed: true, reasonCode: "not_tool_grant" };
  }
  const descriptor: any = operation.dynamicCapability || {};
  const capabilityId: any = text(descriptor.capabilityId);
  const capabilities: any = governedSubjectCapabilitySet(subject);
  if (!capabilityId || !capabilities.has(capabilityId)) {
    return { allowed: false, reasonCode: "missing_dynamic_upstream_capability", capabilityId };
  }
  const allowedServiceIds: any = governedSubjectAllowedServiceIds(subject);
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(descriptor.serviceId)) {
    return { allowed: false, reasonCode: "upstream_service_binding_denied", capabilityId };
  }
  const allowedSecretBindings: any = governedSubjectAllowedSecretBindings(subject);
  const missingCredentialBindings: any = asArray(descriptor.credentialBindingIds).map(text).filter(Boolean)
    .filter((bindingId?: any) : any =>
      !allowedSecretBindings.has(bindingId) && !capabilities.has(`${capabilityId}:${bindingId}`)
    );
  if (missingCredentialBindings.length > 0) {
    return { allowed: false, reasonCode: "upstream_credential_binding_denied", capabilityId };
  }
  return { allowed: true, reasonCode: "dynamic_upstream_capability_allowed", capabilityId };
}
