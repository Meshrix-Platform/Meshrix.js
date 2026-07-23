import { normalizeGrantValues } from "./http-mcp-adapter-session.mjs";

export function isUpstreamMcpToolName(value = "") {
  return String(value || "").startsWith("upstream.");
}

function publicProjectedUpstreamTool(tool = {}) {
  const dynamicCapability = tool.dynamicCapability && typeof tool.dynamicCapability === "object" && !Array.isArray(tool.dynamicCapability)
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

function upstreamMcpToolMeta(tool = {}) {
  return tool?._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta)
    ? tool._meta
    : {};
}

function grantDynamicCapabilities(grant = {}) {
  const metadata = grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return new Set(normalizeGrantValues([
    ...(Array.isArray(grant.dynamicCapabilities) ? grant.dynamicCapabilities : []),
    ...(Array.isArray(grant.upstreamCapabilities) ? grant.upstreamCapabilities : []),
    ...(Array.isArray(metadata.dynamicCapabilities) ? metadata.dynamicCapabilities : []),
    ...(Array.isArray(metadata.upstreamCapabilities) ? metadata.upstreamCapabilities : [])
  ], 512));
}

const MCP_RISK_RANK = Object.freeze({
  read_only: 0,
  safe_write: 1,
  repair_write: 2,
  destructive: 3
});

function normalizeMcpRisk(value = "read_only") {
  const risk = String(value || "").trim();
  return Object.hasOwn(MCP_RISK_RANK, risk) ? risk : "read_only";
}

function inferredGrantMaxRisk(grant = {}, grantScopes = new Set()) {
  const metadata = grant?.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  const explicit = normalizeMcpRisk(grant.maxRisk || grant.max_risk || grant.risk || metadata.maxRisk || metadata.max_risk || "");
  if (explicit !== "read_only" || grant.maxRisk || grant.max_risk || grant.risk || metadata.maxRisk || metadata.max_risk) {
    return explicit;
  }
  return grantScopes.has("gateway:write") ? "safe_write" : "read_only";
}

function grantCanSeeUpstreamMcpTool(tool = {}, grant = null) {
  if (!tool || !grant) return false;
  const toolName = String(tool.name || "").trim();
  if (!isUpstreamMcpToolName(toolName)) return false;
  const deniedTools = new Set(normalizeGrantValues(grant.toolDeny || [], 512));
  if (deniedTools.has(toolName)) return false;
  const allowedTools = new Set(normalizeGrantValues(grant.toolAllow || [], 512));
  if (allowedTools.size > 0 && !allowedTools.has(toolName)) return false;
  const meta = upstreamMcpToolMeta(tool);
  const dynamicCapabilities = grantDynamicCapabilities(grant);
  const requiredCapabilities = normalizeGrantValues(meta.requiredCapabilities || meta.capabilityId || [], 128);
  if (requiredCapabilities.length === 0 || requiredCapabilities.some((capability) => !dynamicCapabilities.has(capability))) return false;
  const dynamicCapability = meta.dynamicCapability && typeof meta.dynamicCapability === "object" && !Array.isArray(meta.dynamicCapability)
    ? meta.dynamicCapability
    : {};
  const credentialBindingIds = normalizeGrantValues(dynamicCapability.credentialBindingIds || [], 128);
  const allowedSecretBindings = new Set(normalizeGrantValues([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(grant.metadata?.allowedSecretBindings) ? grant.metadata.allowedSecretBindings : [])
  ], 512));
  if (credentialBindingIds.some((bindingId) =>
    !allowedSecretBindings.has(bindingId) && !dynamicCapabilities.has(`${requiredCapabilities[0]}:${bindingId}`)
  )) return false;
  const grantScopes = new Set(normalizeGrantValues(grant.scopes || [], 512));
  const requiredScopes = normalizeGrantValues(meta.requiredScopes || [], 128);
  if (requiredScopes.some((scope) => !grantScopes.has(scope))) return false;
  const toolRisk = normalizeMcpRisk(meta.risk || tool.risk || "read_only");
  const maxRisk = inferredGrantMaxRisk(grant, grantScopes);
  if (MCP_RISK_RANK[toolRisk] > MCP_RISK_RANK[maxRisk]) return false;
  const grantToolsets = new Set(normalizeGrantValues(grant.toolsets || [], 256));
  const toolsets = normalizeGrantValues(meta.toolsets || [], 256);
  if (grantToolsets.size > 0 && !toolsets.some((toolset) => grantToolsets.has(toolset))) {
    return false;
  }
  return true;
}

function grantCanDiscoverUpstreamMcpService(service = {}, grant = null) {
  if (!grant) return false;
  const serviceId = String(service.serviceId || "").trim();
  if (!serviceId || String(service.serviceProtocol || "") !== "mcp") return false;
  const allowedServiceIds = new Set(normalizeGrantValues([
    ...(Array.isArray(grant.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(grant.metadata?.allowedServiceIds) ? grant.metadata.allowedServiceIds : [])
  ], 512));
  if (allowedServiceIds.size > 0 && !allowedServiceIds.has(serviceId)) return false;
  const dynamicCapabilities = grantDynamicCapabilities(grant);
  const normalizedServiceId = serviceId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "service";
  const serviceCapabilityPrefix = `cap:upstream:${normalizedServiceId}:`;
  if (![...dynamicCapabilities].some((capability) => capability.startsWith(serviceCapabilityPrefix))) return false;
  const grantScopes = new Set(normalizeGrantValues(grant.scopes || [], 512));
  if (!grantScopes.has("gateway:read") && !grantScopes.has("gateway:write") && !grantScopes.has("gateway:admin")) {
    return false;
  }
  const allowedSecretBindings = new Set(normalizeGrantValues([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(grant.metadata?.allowedSecretBindings) ? grant.metadata.allowedSecretBindings : [])
  ], 512));
  return normalizeGrantValues(service.credentialBindingIds || [], 128).every((bindingId) =>
    allowedSecretBindings.has(bindingId) || [...dynamicCapabilities].some((capability) =>
      capability.startsWith(serviceCapabilityPrefix) && capability.endsWith(`:${bindingId}`)
    )
  );
}

export async function listVisibleUpstreamMcpTools({
  upstreamGatewayRegistry = null,
  operationPermissionTools = [],
  authorization = null,
  signal = null
} = {}) {
  const projected = (Array.isArray(operationPermissionTools) ? operationPermissionTools : [])
    .filter((tool) => tool?.upstreamProjectedOperation === true)
    .map(publicProjectedUpstreamTool);
  const grant = authorization?.grant || null;
  const allowedServiceIds = new Set(normalizeGrantValues([
    ...(Array.isArray(grant?.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(grant?.metadata?.allowedServiceIds) ? grant.metadata.allowedServiceIds : [])
  ], 512));
  const listedServices = typeof upstreamGatewayRegistry?.listServices === "function"
    ? upstreamGatewayRegistry.listServices().items || []
    : null;
  let listedItems = [];
  if (listedServices && typeof upstreamGatewayRegistry?.listMcpTools === "function") {
    const candidateServiceIds = listedServices
      .filter((service) => grantCanDiscoverUpstreamMcpService(service, grant))
      .map((service) => String(service.serviceId || "").trim())
      .filter(Boolean)
      .filter((serviceId) => allowedServiceIds.size === 0 || allowedServiceIds.has(serviceId));
    const responses = await Promise.all(candidateServiceIds.map((serviceId) =>
      upstreamGatewayRegistry.listMcpTools({ serviceId }, { signal })
    ));
    listedItems = responses.flatMap((response) => response?.items || []);
  } else if (typeof upstreamGatewayRegistry?.listMcpTools === "function") {
    listedItems = (await upstreamGatewayRegistry.listMcpTools({}, { signal })).items || [];
  }
  const discoveredMcp = listedItems
    .filter((tool) => tool?._meta?.upstreamMcp === true)
    .filter((tool) => grantCanSeeUpstreamMcpTool(tool, grant))
    .filter((tool) => typeof upstreamGatewayRegistry?.evaluateDiscoveredMcpToolAudience !== "function" ||
      upstreamGatewayRegistry.evaluateDiscoveredMcpToolAudience({
        grant,
        tool,
        purpose: "discovery"
      })?.allowed === true);
  return [...new Map([...projected, ...discoveredMcp].map((tool) => [tool.name, tool])).values()];
}
