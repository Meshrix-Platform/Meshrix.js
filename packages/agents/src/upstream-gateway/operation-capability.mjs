import {
  asArray,
  hash,
  normalizeRisk,
  safePublicToolSegment,
  text
} from "./support.mjs";

const DESCRIPTOR_VERSION = "v0.0.1:upstream-gateway:operation-capability-1";

function unique(values = []) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function capabilityOperationSegment(operation = {}, options = {}) {
  const upstreamToolName = text(options.upstreamToolName || operation.upstreamToolName || operation.toolName);
  if (upstreamToolName && text(operation.operationKey) === "tools/call") {
    return `tools-call-${safePublicToolSegment(upstreamToolName)}`;
  }
  return safePublicToolSegment(operation.operationKey || upstreamToolName || "default");
}

export function upstreamOperationCapabilityId(service = {}, operation = {}, options = {}) {
  return `cap:upstream:${safePublicToolSegment(service.serviceId)}:${capabilityOperationSegment(operation, options)}`;
}

export function compileUpstreamOperationCapability(service = {}, operation = {}, options = {}) {
  const serviceId = text(service.serviceId);
  const operationKey = text(operation.operationKey || "default");
  const upstreamToolName = text(options.upstreamToolName || operation.upstreamToolName || operation.toolName);
  const capabilityId = upstreamOperationCapabilityId(service, operation, { upstreamToolName });
  const credentialBindingIds = unique(asArray(service.credentialRefs).map((ref) => `credential:${hash(ref, 16)}`));
  const risk = normalizeRisk(operation.risk);
  const tupleCapabilityIds = unique([
    `cap:upstream-tuple:${safePublicToolSegment(serviceId)}:${capabilityOperationSegment(operation, { upstreamToolName })}:risk:${risk}`,
    ...credentialBindingIds.map((bindingId) => `${capabilityId}:${bindingId}`)
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

export function operationWithUpstreamCapability(service = {}, operation = {}, options = {}) {
  const dynamicCapability = operation.dynamicCapability || compileUpstreamOperationCapability(service, operation, options);
  return {
    ...operation,
    dynamicCapability,
    resourceContext: {
      ...(operation.resourceContext || {}),
      ...dynamicCapability.resourceContext
    }
  };
}

export function evaluateDynamicOperationAuthorization(subject = {}, operation = {}) {
  if (text(subject.type) !== "tool-grant") {
    return { allowed: true, reasonCode: "not_tool_grant" };
  }
  const descriptor = operation.dynamicCapability || {};
  const capabilityId = text(descriptor.capabilityId);
  const capabilities = new Set(asArray(subject.dynamicCapabilities).map(text).filter(Boolean));
  if (!capabilityId || !capabilities.has(capabilityId)) {
    return { allowed: false, reasonCode: "missing_dynamic_upstream_capability", capabilityId };
  }
  const allowedServiceIds = new Set(asArray(subject.allowedServiceIds).map(text).filter(Boolean));
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(descriptor.serviceId)) {
    return { allowed: false, reasonCode: "upstream_service_binding_denied", capabilityId };
  }
  const allowedSecretBindings = new Set(asArray(subject.allowedSecretBindings).map(text).filter(Boolean));
  const missingCredentialBindings = asArray(descriptor.credentialBindingIds).map(text).filter(Boolean)
    .filter((bindingId) =>
      !allowedSecretBindings.has(bindingId) && !capabilities.has(`${capabilityId}:${bindingId}`)
    );
  if (missingCredentialBindings.length > 0) {
    return { allowed: false, reasonCode: "upstream_credential_binding_denied", capabilityId };
  }
  return { allowed: true, reasonCode: "dynamic_upstream_capability_allowed", capabilityId };
}
