function grantMetadata(grant?: any) : any {
  return grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
}

function normalizeGrantValues(value?: any, limit: any = 64) : any {
  const items: any = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set<any>(items.map((item?: any) : any => String(item || "").trim()).filter(Boolean))].slice(0, limit);
}

export function mcpSubjectFromGrant(grant: any = null) : any {
  if (!grant) {
    return {
      type: "anonymous",
      subjectId: "",
      label: "",
      scopes: [],
      toolsets: []
    };
  }
  const metadata: any = grantMetadata(grant);
  const dynamicCapabilities: any = normalizeGrantValues([
    ...(Array.isArray(grant.dynamicCapabilities) ? grant.dynamicCapabilities : []),
    ...(Array.isArray(grant.upstreamCapabilities) ? grant.upstreamCapabilities : []),
    ...(Array.isArray(grant.capabilities) ? grant.capabilities : []),
    ...(Array.isArray(metadata.dynamicCapabilities) ? metadata.dynamicCapabilities : []),
    ...(Array.isArray(metadata.upstreamCapabilities) ? metadata.upstreamCapabilities : []),
    ...(Array.isArray(metadata.capabilities) ? metadata.capabilities : [])
  ], 512);
  const allowedServiceIds: any = normalizeGrantValues([
    ...(Array.isArray(grant.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(metadata.allowedServiceIds) ? metadata.allowedServiceIds : [])
  ], 512);
  const allowedSecretBindings: any = normalizeGrantValues([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(metadata.allowedSecretBindings) ? metadata.allowedSecretBindings : [])
  ], 512);
  const subjectId: any = String(grant.subjectId || grant.subject?.id || grant.id || "");
  const grantId: any = String(grant.id || "");
  return {
    type: "tool-grant",
    subjectId,
    grantId,
    grant: {
      id: grantId,
      subjectId,
      dynamicCapabilities,
      allowedServiceIds,
      allowedSecretBindings
    },
    label: String(grant.label || grant.id || ""),
    scopes: normalizeGrantValues(grant.scopes || [], 512),
    toolsets: normalizeGrantValues(grant.toolsets || [], 256),
    dynamicCapabilities,
    allowedServiceIds,
    allowedSecretBindings,
    maxRisk: String(grant.maxRisk || grant.max_risk || metadata.maxRisk || metadata.max_risk || "")
  };
}

export function mcpSubjectFromAuthorization(authorization: any = null) : any {
  const apiKeyAuthorization: any = authorization?.credentialKind === "scoped_api_key"
    ? authorization.apiKeyAuthorization
    : null;
  if (!apiKeyAuthorization) return mcpSubjectFromGrant(authorization?.grant || null);
  const policy: any = apiKeyAuthorization.policy || {};
  return {
    type: "scoped-api-key",
    subjectId: String(apiKeyAuthorization.workloadPrincipalId || ""),
    grantId: String(authorization?.grant?.id || apiKeyAuthorization.id || ""),
    grant: authorization?.grant || { id: String(authorization?.grant?.id || apiKeyAuthorization.id || "") },
    label: String(apiKeyAuthorization.workloadPrincipalId || ""),
    tenantId: "local",
    organizationNodeId: String(apiKeyAuthorization.organizationNodeId || ""),
    scopes: normalizeGrantValues(policy.scopeIds || [], 512),
    toolsets: normalizeGrantValues(policy.toolsetIds || [], 256),
    allowedOrigins: normalizeGrantValues(policy.resources?.allowedOrigins || [], 512),
    allowedCidrs: normalizeGrantValues(policy.resources?.allowedCidrs || [], 256),
    capabilities: normalizeGrantValues(policy.capabilityIds || [], 512),
    dynamicCapabilities: normalizeGrantValues(policy.capabilityIds || [], 512),
    maxRisk: String(policy.maximumRisk || ""),
    allowedWorkspaceIds: normalizeGrantValues(policy.resources?.workspaceIds || [], 512),
    allowedDataClasses: normalizeGrantValues(policy.resources?.dataClassifications || [], 256),
    allowedEgress: normalizeGrantValues(policy.resources?.egressClasses || [], 256),
    allowedStaticSemanticFamilies: normalizeGrantValues(policy.resources?.semanticFamilies || [], 256),
    allowedCapabilityDomains: normalizeGrantValues(policy.resources?.capabilityDomains || [], 256),
    allowedCapabilityVerbs: normalizeGrantValues(policy.resources?.capabilityVerbs || [], 256),
    allowedResourceKinds: normalizeGrantValues(policy.resources?.resourceKinds || [], 256),
    allowedEffectKinds: normalizeGrantValues(policy.resources?.effectKinds || [], 256),
    allowedServiceIds: normalizeGrantValues(policy.serviceIds || [], 512),
    allowedSecretBindings: normalizeGrantValues(policy.resources?.secretBindingIds || [], 512)
  };
}
