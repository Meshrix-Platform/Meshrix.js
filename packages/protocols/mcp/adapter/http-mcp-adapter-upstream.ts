import { normalizeGrantValues } from "./http-mcp-adapter-session.ts";

export function isUpstreamMcpToolName(value: any = "") : any {
  return String(value || "").startsWith("upstream.");
}

function publicProjectedUpstreamTool(tool: Record<string, any> = {}) : any {
  const dynamicCapability: any = tool.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
    ? tool.dynamicCapability
    : {};
  return {
    name: tool.id,
    title: tool.label || tool.id,
    description: tool.description || tool.label || tool.id,
    inputSchema: tool.inputSchema || { type: "object", additionalProperties: true },
    annotations: {
      readOnlyHint: tool.readOnly !== false,
      destructiveHint: tool.destructive === true
    },
    _meta: {
      upstreamConfiguredOperation: true,
      toolId: tool.id,
      operationId: tool.operationId,
      sourceRevision: tool.sourceRevision || 0,
      sourceDigest: tool.sourceDigest || "",
      serviceId: tool.serviceId || dynamicCapability.serviceId || "",
      serviceRevision: tool.serviceRevision || 0,
      operationKey: tool.operationKey || dynamicCapability.operationKey || "",
      protocol: tool.protocol || dynamicCapability.protocol || "",
      payloadTransport: tool.payloadTransport || null,
      capabilityId: dynamicCapability.capabilityId || "",
      requiredCapabilities: dynamicCapability.capabilityId ? [dynamicCapability.capabilityId] : [],
      dynamicCapability,
      resourceContext: tool.resourceContext || dynamicCapability.resourceContext || {},
      toolsets: tool.toolsets || [],
      requiredScopes: tool.requiredScopes || [],
      risk: tool.risk || dynamicCapability.risk || "read_only",
      requiresApproval: tool.requiresApproval === true
    }
  };
}

function upstreamMcpToolMeta(tool: Record<string, any> = {}) : any {
  return tool?._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta)
    ? tool._meta
    : {};
}

function grantDynamicCapabilities(grant: Record<string, any> = {}) : any {
  const metadata: any = grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return new Set<any>(normalizeGrantValues([
    ...(Array.isArray(grant.dynamicCapabilities) ? grant.dynamicCapabilities : []),
    ...(Array.isArray(grant.upstreamCapabilities) ? grant.upstreamCapabilities : []),
    ...(Array.isArray(metadata.dynamicCapabilities) ? metadata.dynamicCapabilities : []),
    ...(Array.isArray(metadata.upstreamCapabilities) ? metadata.upstreamCapabilities : [])
  ], 512));
}

const MCP_RISK_RANK: Readonly<Record<string, any>> = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

function normalizeMcpRisk(value: any = "read_only") : any {
  const risk: any = String(value || "").trim();
  return Object.hasOwn(MCP_RISK_RANK, risk) ? risk : "read_only";
}

function inferredGrantMaxRisk(grant: Record<string, any> = {}, grantScopes: any = new Set<any>()) : any {
  const metadata: any = grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  const explicit: any = normalizeMcpRisk(grant.maxRisk || grant.max_risk || grant.risk || metadata.maxRisk || metadata.max_risk || "");
  if (explicit !== "read_only" || grant.maxRisk || grant.max_risk || grant.risk || metadata.maxRisk || metadata.max_risk) {
    return explicit;
  }
  return grantScopes.has("gateway:write") ? "safe_write" : "read_only";
}

function grantCanSeeUpstreamMcpTool(tool: Record<string, any> = {}, grant: any = null) : any {
  if (!tool || !grant) return false;
  const toolName: any = String(tool.name || "").trim();
  if (!isUpstreamMcpToolName(toolName)) return false;
  const deniedTools: any = new Set<any>(normalizeGrantValues(grant.toolDeny || [], 512));
  if (deniedTools.has(toolName)) return false;
  const allowedTools: any = new Set<any>(normalizeGrantValues(grant.toolAllow || [], 512));
  if (allowedTools.size > 0 && !allowedTools.has(toolName)) return false;
  const meta: any = upstreamMcpToolMeta(tool);
  const dynamicCapabilities: any = grantDynamicCapabilities(grant);
  const requiredCapabilities: any = normalizeGrantValues(meta.requiredCapabilities || meta.capabilityId || [], 128);
  if (requiredCapabilities.length === 0 || requiredCapabilities.some((capability?: any) : any => !dynamicCapabilities.has(capability))) return false;
  const dynamicCapability: any = meta.dynamicCapability && typeof meta.dynamicCapability === "object" && !Array.isArray(meta.dynamicCapability)
    ? meta.dynamicCapability
    : {};
  const credentialBindingIds: any = normalizeGrantValues(dynamicCapability.credentialBindingIds || [], 128);
  const allowedSecretBindings: any = new Set<any>(normalizeGrantValues([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(grant.metadata?.allowedSecretBindings) ? grant.metadata.allowedSecretBindings : [])
  ], 512));
  if (credentialBindingIds.some((bindingId?: any) : any =>
    !allowedSecretBindings.has(bindingId) && !dynamicCapabilities.has(`${requiredCapabilities[0]}:${bindingId}`)
  )) return false;
  const grantScopes: any = new Set<any>(normalizeGrantValues(grant.scopes || [], 512));
  const requiredScopes: any = normalizeGrantValues(meta.requiredScopes || [], 128);
  if (requiredScopes.some((scope?: any) : any => !grantScopes.has(scope))) return false;
  const toolRisk: any = normalizeMcpRisk(meta.risk || tool.risk || "read_only");
  const maxRisk: any = inferredGrantMaxRisk(grant, grantScopes);
  if (MCP_RISK_RANK[toolRisk] > MCP_RISK_RANK[maxRisk]) return false;
  const grantToolsets: any = new Set<any>(normalizeGrantValues(grant.toolsets || [], 256));
  const toolsets: any = normalizeGrantValues(meta.toolsets || [], 256);
  if (grantToolsets.size > 0 && !toolsets.some((toolset?: any) : any => grantToolsets.has(toolset))) {
    return false;
  }
  return true;
}

function grantCanDiscoverUpstreamMcpService(service: Record<string, any> = {}, grant: any = null) : any {
  if (!grant) return false;
  const serviceId: any = String(service.serviceId || "").trim();
  if (!serviceId || String(service.serviceProtocol || "") !== "mcp") return false;
  const allowedServiceIds: any = new Set<any>(normalizeGrantValues([
    ...(Array.isArray(grant.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(grant.metadata?.allowedServiceIds) ? grant.metadata.allowedServiceIds : [])
  ], 512));
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(serviceId)) return false;
  const dynamicCapabilities: any = grantDynamicCapabilities(grant);
  const normalizedServiceId: any = serviceId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "service";
  const serviceCapabilityPrefix: any = `cap:upstream:${normalizedServiceId}:`;
  if (![...dynamicCapabilities].some((capability?: any) : any => capability.startsWith(serviceCapabilityPrefix))) return false;
  const grantScopes: any = new Set<any>(normalizeGrantValues(grant.scopes || [], 512));
  if (!grantScopes.has("gateway:read") && !grantScopes.has("gateway:write") && !grantScopes.has("gateway:admin")) {
    return false;
  }
  const allowedSecretBindings: any = new Set<any>(normalizeGrantValues([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(grant.metadata?.allowedSecretBindings) ? grant.metadata.allowedSecretBindings : [])
  ], 512));
  return normalizeGrantValues(service.credentialBindingIds || [], 128).every((bindingId?: any) : any =>
    allowedSecretBindings.has(bindingId) || [...dynamicCapabilities].some((capability?: any) : any =>
      capability.startsWith(serviceCapabilityPrefix) && capability.endsWith(`:${bindingId}`)
    )
  );
}

function apiKeyRestrictionFromAuthorization(authorization: any = null) : any {
  return authorization?.credentialKind === "scoped_api_key" &&
    authorization?.restriction &&
    typeof authorization.restriction === "object" &&
    !Array.isArray(authorization.restriction)
    ? authorization.restriction
    : null;
}

function restrictionCapabilities(restriction: any = null) : Set<any> {
  return new Set<any>(normalizeGrantValues([
    ...(Array.isArray(restriction?.capabilities) ? restriction.capabilities : []),
    ...(Array.isArray(restriction?.dynamicCapabilities) ? restriction.dynamicCapabilities : [])
  ], 512));
}

function restrictionCanDiscoverUpstreamMcpService(service: Record<string, any> = {}, restriction: any = null) : any {
  if (!restriction) return false;
  const serviceId: any = String(service.serviceId || "").trim();
  if (!serviceId || String(service.serviceProtocol || "") !== "mcp") return false;
  const allowedServiceIds: any = new Set<any>(normalizeGrantValues(restriction.allowedServiceIds || [], 512));
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(serviceId)) return false;
  const capabilities: any = restrictionCapabilities(restriction);
  const normalizedServiceId: any = serviceId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "service";
  const serviceCapabilityPrefix: any = `cap:upstream:${normalizedServiceId}:`;
  if (![...capabilities].some((capability?: any) : any => capability.startsWith(serviceCapabilityPrefix))) return false;
  const scopes: any = new Set<any>(normalizeGrantValues(restriction.scopes || [], 512));
  if (!scopes.has("gateway:read") && !scopes.has("gateway:write") && !scopes.has("gateway:admin")) return false;
  const allowedSecretBindings: any = new Set<any>(normalizeGrantValues(restriction.allowedSecretBindings || [], 512));
  return normalizeGrantValues(service.credentialBindingIds || [], 128).every((bindingId?: any) : any =>
    allowedSecretBindings.has(bindingId) || [...capabilities].some((capability?: any) : any =>
      capability.startsWith(serviceCapabilityPrefix) && capability.endsWith(`:${bindingId}`)
    )
  );
}

function restrictionCanSeeUpstreamMcpTool(tool: Record<string, any> = {}, restriction: any = null) : any {
  if (!tool || !restriction || !isUpstreamMcpToolName(tool.name)) return false;
  const meta: any = upstreamMcpToolMeta(tool);
  const toolName: any = String(tool.name || "").trim();
  const deniedTools: any = new Set<any>(normalizeGrantValues(restriction.toolDeny || [], 512));
  if (deniedTools.has(toolName)) return false;
  const allowedTools: any = new Set<any>(normalizeGrantValues(restriction.toolAllow || [], 512));
  if (allowedTools.size > 0 && !allowedTools.has(toolName)) return false;
  const capabilities: any = restrictionCapabilities(restriction);
  const requiredCapabilities: any = normalizeGrantValues(meta.requiredCapabilities || meta.capabilityId || [], 128);
  if (requiredCapabilities.length === 0 || requiredCapabilities.some((capability?: any) : any => !capabilities.has(capability))) return false;
  const dynamicCapability: any = meta.dynamicCapability && typeof meta.dynamicCapability === "object" && !Array.isArray(meta.dynamicCapability)
    ? meta.dynamicCapability
    : {};
  const allowedSecretBindings: any = new Set<any>(normalizeGrantValues(restriction.allowedSecretBindings || [], 512));
  if (normalizeGrantValues(dynamicCapability.credentialBindingIds || [], 128)
    .some((bindingId?: any) : any => !allowedSecretBindings.has(bindingId))) return false;
  const scopes: any = new Set<any>(normalizeGrantValues(restriction.scopes || [], 512));
  if (normalizeGrantValues(meta.requiredScopes || [], 128).some((scope?: any) : any => !scopes.has(scope))) return false;
  const toolRisk: any = normalizeMcpRisk(meta.risk || tool.risk || "read_only");
  if (MCP_RISK_RANK[toolRisk] > MCP_RISK_RANK[normalizeMcpRisk(restriction.maxRisk)]) return false;
  const allowedToolsets: any = new Set<any>(normalizeGrantValues(restriction.toolsets || [], 256));
  const toolsets: any = normalizeGrantValues(meta.toolsets || [], 256);
  if (allowedToolsets.size > 0 && !toolsets.some((toolset?: any) : any => allowedToolsets.has(toolset))) return false;
  return true;
}

export async function listVisibleUpstreamMcpTools({
  upstreamGatewayRegistry = null,
  operationPermissionTools = [],
  authorization = null,
  signal = null
}: Record<string, any> = {}) : Promise<any> {
  const projected: any = (Array.isArray(operationPermissionTools) ? operationPermissionTools : [])
    .filter((tool?: any) : any => tool?.upstreamProjectedOperation === true)
    .map(publicProjectedUpstreamTool);
  const grant: any = authorization?.grant || null;
  const restriction: any = apiKeyRestrictionFromAuthorization(authorization);
  const subject: any = restriction ? authorization?.subject || null : null;
  const allowedServiceIds: any = new Set<any>(normalizeGrantValues([
    ...(Array.isArray(grant?.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(grant?.metadata?.allowedServiceIds) ? grant.metadata.allowedServiceIds : []),
    ...(Array.isArray(restriction?.allowedServiceIds) ? restriction.allowedServiceIds : [])
  ], 512));
  const listedServices: any = typeof upstreamGatewayRegistry?.listServices === "function"
    ? upstreamGatewayRegistry.listServices().items || []
    : null;
  let listedItems: any[] = [];
  if (listedServices && typeof upstreamGatewayRegistry?.listMcpTools === "function") {
    const candidateServiceIds: any = listedServices
      .filter((service?: any) : any => restriction
        ? restrictionCanDiscoverUpstreamMcpService(service, restriction)
        : grantCanDiscoverUpstreamMcpService(service, grant))
      .map((service?: any) : any => String(service.serviceId || "").trim())
      .filter(Boolean)
      .filter((serviceId?: any) : any => allowedServiceIds.size === 0 || allowedServiceIds.has(serviceId));
    const responses: any = await Promise.all(candidateServiceIds.map((serviceId?: any) : any =>
      upstreamGatewayRegistry.listMcpTools({ serviceId }, { signal })
    ));
    listedItems = responses.flatMap((response?: any) : any => response?.items || []);
  } else if (typeof upstreamGatewayRegistry?.listMcpTools === "function") {
    listedItems = (await upstreamGatewayRegistry.listMcpTools({}, { signal })).items || [];
  }
  const discoveredMcp: any = listedItems
    .filter((tool?: any) : any => tool?._meta?.upstreamMcp === true)
    .filter((tool?: any) : any => restriction
      ? restrictionCanSeeUpstreamMcpTool(tool, restriction)
      : grantCanSeeUpstreamMcpTool(tool, grant))
    .filter((tool?: any) : any => typeof upstreamGatewayRegistry?.evaluateDiscoveredMcpToolAudience !== "function" ||
      upstreamGatewayRegistry.evaluateDiscoveredMcpToolAudience({
        grant,
        restriction,
        subject,
        tool,
        purpose: "discovery"
      })?.allowed === true);
  return [...new Map<any, any>([...projected, ...discoveredMcp].map((tool?: any) : any => [tool.name, tool])).values()];
}
