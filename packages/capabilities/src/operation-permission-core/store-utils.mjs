import crypto from "node:crypto";
import {
  normalizeKernelCapabilities,
  normalizeRegisteredToolCapabilities,
  toolExecuteCapabilityId,
  unknownKernelCapabilities
} from "@meshrix/foundation/security/authorization/authorization-engine";
import {
  OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION
} from "@meshrix/foundation/security/authorization/opaque-capability-key";
import {
  CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION
} from "@meshrix/foundation/security/authorization/capability-binding-guard";
import { clientIpFromRequest } from "@meshrix/foundation/security/trusted-client-ip";
import {
  OPERATION_PERMISSION_SCOPES,
  scopesToToolsets,
  toolsetsToScopes
} from "./catalog.mjs";

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 0;
export const LOCAL_MCP_GRANT_ISSUER = "meshrix-mcp-local-pairing";
export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

export function redactedTraceRef(request = null) {
  const raw = String(request?.__licoTraceContext?.traceId || request?.__licoRequestId || "");
  return raw ? `trace:${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}` : "";
}

export function isEnabled(value = "") {
  return /^(1|true|yes|on|command|helper)$/i.test(String(value || "").trim());
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function readBearerToken(request) {
  const authorization = String(request?.headers?.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) {
    return match[1].trim();
  }
  return String(request?.headers?.["x-meshrix-tool-token"] || "").trim();
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return normalizeStringList(value.split(","));
  }
  return [];
}

const DYNAMIC_UPSTREAM_CAPABILITY_PATTERN = /^cap:upstream(?:-tuple)?:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/iu;

export function normalizeDynamicUpstreamCapabilities(value) {
  return normalizeStringList(value)
    .filter((capability) => DYNAMIC_UPSTREAM_CAPABILITY_PATTERN.test(capability))
    .slice(0, 512);
}

export function rejectInvalidDynamicUpstreamCapabilities(value) {
  const requested = normalizeStringList(value);
  const normalized = normalizeDynamicUpstreamCapabilities(requested);
  if (requested.length !== normalized.length) {
    throw new Error("Dynamic upstream capabilities must use canonical cap:upstream:* identifiers.");
  }
  return normalized;
}

export function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function normalizeMcpTarget(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

export function mcpTargetHeaderFromRequest(request) {
  const headerTarget = normalizeMcpTarget(headerValue(
    request,
    "x-meshrix-mcp-target",
    "x-meshrix-client-target",
    "x-meshrix-tool-target",
    "x-meshrix-client-id"
  ));
  if (headerTarget) {
    return headerTarget;
  }
  try {
    const parsed = new URL(String(request?.url || ""), "http://127.0.0.1");
    return normalizeMcpTarget(
      parsed.searchParams.get("mcpTarget") ||
      parsed.searchParams.get("mcp-target") ||
      parsed.searchParams.get("target") ||
      parsed.searchParams.get("clientTarget")
    );
  } catch {
    return "";
  }
}

export function normalizeScopes(scopes) {
  const valid = new Set(OPERATION_PERMISSION_SCOPES.map((scope) => scope.id));
  return normalizeStringList(scopes).filter((scope) => valid.has(scope));
}

export function normalizeRateLimit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE };
  }
  return {
    perMinute: Math.max(0, Number(value.perMinute || value.per_minute || 0) || 0)
  };
}

export function normalizePolicyRevisionSnapshot(value = {}) {
  const revision = Number(value?.revision || value?.policyRevision || 0);
  const normalizedRevision = Number.isFinite(revision) && revision > 0 ? revision : 0;
  return {
    protocolVersion: String(value?.protocolVersion || value?.protocol_version || "").trim(),
    revision: normalizedRevision,
    updatedAt: String(value?.updatedAt || value?.updated_at || "").trim()
  };
}

export function normalizePendingOperationStatus(value = "pending") {
  const status = String(value || "pending").trim().toLowerCase();
  if (status === "canceled") {
    return "cancelled";
  }
  if (status === "denied") {
    return "rejected";
  }
  return [
    "pending",
    "approved",
    "rejected",
    "cancelled",
    "expired",
    "completed",
    "failed",
    "payload_mismatch",
    "replayed"
  ].includes(status)
    ? status
    : "pending";
}

export function stampGrantPolicyRevision(metadata = {}, policyRevision = {}) {
  const snapshot = normalizePolicyRevisionSnapshot(policyRevision);
  if (!snapshot.revision) {
    return metadata;
  }
  return {
    ...metadata,
    policyRevision: snapshot.revision,
    policyRevisionUpdatedAt: snapshot.updatedAt,
    policyRevisionProtocolVersion: snapshot.protocolVersion
  };
}

export function normalizeGrantInput(input = {}, fallback = {}) {
  const explicitScopes = normalizeScopes(input.scopes ?? fallback.scopes);
  const toolsets = normalizeStringList(input.toolsets ?? fallback.toolsets);
  const scopes = explicitScopes.length ? explicitScopes : normalizeScopes(toolsetsToScopes(toolsets));
  const normalizedToolsets = toolsets.length ? toolsets : scopesToToolsets(scopes);
  const createdAt = fallback.createdAt || nowIso();
  const fallbackMetadata = fallback.metadata && typeof fallback.metadata === "object" && !Array.isArray(fallback.metadata)
    ? fallback.metadata
    : {};
  const inputMetadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const metadata = {
    ...fallbackMetadata,
    ...inputMetadata
  };
  const capabilities = normalizeKernelCapabilities(
    input.capabilities,
    input.capabilityIds,
    metadata.capabilities,
    metadata.capabilityIds,
    fallback.capabilities,
    fallback.capabilityIds,
    fallbackMetadata.capabilities,
    fallbackMetadata.capabilityIds
  );
  const dynamicCapabilities = normalizeDynamicUpstreamCapabilities(
    input.dynamicCapabilities ??
      input.upstreamCapabilities ??
      inputMetadata.dynamicCapabilities ??
      inputMetadata.upstreamCapabilities ??
      fallback.dynamicCapabilities ??
      fallback.upstreamCapabilities ??
      fallbackMetadata.dynamicCapabilities ??
      fallbackMetadata.upstreamCapabilities
  );
  const agentId = firstString(input.agentId, input.agent_id, input.agentProfileId, metadata.agentId, metadata.agentProfileId);
  const agentProfileId = firstString(input.agentProfileId, input.profileId, input.profile_id, metadata.agentProfileId, metadata.profileId, agentId);
  const boundUserId = firstString(input.boundUserId, input.bound_user_id, input.userId, input.user_id, metadata.boundUserId, metadata.userId);
  const teamIds = normalizeStringList(input.teamIds ?? input.team_ids ?? metadata.teamIds);
  const allowedWorkspaceIds = normalizeStringList(input.allowedWorkspaceIds ?? fallback.allowedWorkspaceIds ?? metadata.allowedWorkspaceIds);
  const allowedDataClasses = normalizeStringList(input.allowedDataClasses ?? fallback.allowedDataClasses ?? metadata.allowedDataClasses);
  const allowedEgress = normalizeStringList(input.allowedEgress ?? fallback.allowedEgress ?? metadata.allowedEgress);
  const allowedStaticSemanticFamilies = normalizeStringList(input.allowedStaticSemanticFamilies ?? fallback.allowedStaticSemanticFamilies ?? metadata.allowedStaticSemanticFamilies);
  const allowedCapabilityDomains = normalizeStringList(input.allowedCapabilityDomains ?? fallback.allowedCapabilityDomains ?? metadata.allowedCapabilityDomains);
  const allowedCapabilityVerbs = normalizeStringList(input.allowedCapabilityVerbs ?? fallback.allowedCapabilityVerbs ?? metadata.allowedCapabilityVerbs);
  const allowedResourceKinds = normalizeStringList(input.allowedResourceKinds ?? fallback.allowedResourceKinds ?? metadata.allowedResourceKinds);
  const allowedEffectKinds = normalizeStringList(input.allowedEffectKinds ?? fallback.allowedEffectKinds ?? metadata.allowedEffectKinds);
  const allowedServiceIds = normalizeStringList(input.allowedServiceIds ?? fallback.allowedServiceIds ?? metadata.allowedServiceIds);
  const allowedSecretBindings = normalizeStringList(input.allowedSecretBindings ?? fallback.allowedSecretBindings ?? metadata.allowedSecretBindings);
  return {
    id: String(input.id || fallback.id || randomId("grant")),
    label: String(input.label ?? fallback.label ?? "Agent Tool Grant").trim() || "Agent Tool Grant",
    type: String(input.type ?? fallback.type ?? "machine").trim() || "machine",
    enabled: input.enabled !== undefined ? input.enabled !== false : fallback.enabled !== false,
    toolsets: normalizedToolsets,
    toolAllow: normalizeStringList(input.toolAllow ?? fallback.toolAllow),
    toolDeny: normalizeStringList(input.toolDeny ?? fallback.toolDeny),
    scopes,
    capabilities,
    dynamicCapabilities,
    expiresAt: String(input.expiresAt ?? fallback.expiresAt ?? ""),
    maxUses: Math.max(0, Number(input.maxUses ?? fallback.maxUses ?? 0) || 0),
    rateLimit: normalizeRateLimit(input.rateLimit ?? fallback.rateLimit),
    allowedOrigins: normalizeStringList(input.allowedOrigins ?? fallback.allowedOrigins),
    allowedCidrs: normalizeStringList(input.allowedCidrs ?? fallback.allowedCidrs),
    allowedWorkspaceIds,
    allowedDataClasses,
    allowedEgress,
    allowedStaticSemanticFamilies,
    allowedCapabilityDomains,
    allowedCapabilityVerbs,
    allowedResourceKinds,
    allowedEffectKinds,
    allowedServiceIds,
    allowedSecretBindings,
    metadata: {
      ...metadata,
      dynamicCapabilities,
      allowedWorkspaceIds,
      allowedDataClasses,
      allowedEgress,
      allowedStaticSemanticFamilies,
      allowedCapabilityDomains,
      allowedCapabilityVerbs,
      allowedResourceKinds,
      allowedEffectKinds,
      allowedServiceIds,
      allowedSecretBindings,
      ...(agentId ? { agentId } : {}),
      ...(agentProfileId ? { agentProfileId, profileId: agentProfileId } : {}),
      ...(boundUserId ? { boundUserId, userId: boundUserId } : {}),
      ...(teamIds.length ? { teamIds } : {})
    },
    reason: String(input.reason ?? fallback.reason ?? ""),
    tokenHash: String(input.tokenHash ?? fallback.tokenHash ?? ""),
    tokenPrefix: String(input.tokenPrefix ?? fallback.tokenPrefix ?? ""),
    tokenFamilyId: String(input.tokenFamilyId ?? fallback.tokenFamilyId ?? randomId("token_family")),
    useCount: Math.max(0, Number(input.useCount ?? fallback.useCount ?? 0) || 0),
    createdAt,
    updatedAt: String(input.updatedAt ?? fallback.updatedAt ?? createdAt),
    revokedAt: String(input.revokedAt ?? fallback.revokedAt ?? ""),
    lastUsedAt: String(input.lastUsedAt ?? fallback.lastUsedAt ?? "")
  };
}

export function sanitizeGrantMetadata(metadata = {}) {
  const source = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const {
    capabilities,
    capabilityIds,
    permissions,
    ...safeMetadata
  } = source;
  void capabilities;
  void capabilityIds;
  void permissions;
  return safeMetadata;
}

export function rejectUnknownGrantCapabilities(input = {}) {
  const metadata = input?.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const unknown = unknownKernelCapabilities(
    input?.capabilities,
    input?.capabilityIds,
    metadata.capabilities,
    metadata.capabilityIds
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown tool grant capability permission: ${unknown.join(", ")}`);
  }
  rejectInvalidDynamicUpstreamCapabilities(
    input?.dynamicCapabilities ??
      input?.upstreamCapabilities ??
      metadata.dynamicCapabilities ??
      metadata.upstreamCapabilities ??
      []
  );
}

export function credentialFromMetadata(metadata = {}) {
  const source = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const protocolVersion = String(source.credentialProtocol || source.protocolVersion || "").trim();
  const credentialId = String(source.credentialId || "").trim();
  if (!protocolVersion && !credentialId) {
    return null;
  }
  return {
    protocolVersion,
    credentialId,
    capabilitySetHash: String(source.capabilitySetHash || "").trim(),
    capabilityCount: Math.max(0, Number(source.capabilityCount || 0) || 0),
    runtimeLookupGeneration: Math.max(0, Number(source.runtimeLookupGeneration || 0) || 0),
    bindingProtocol: String(source.credentialBindingProtocol || "").trim(),
    bindingStrength: String(source.credentialBindingStrength || "").trim(),
    bindingRequiredUser: source.credentialBindingRequiredUser === true,
    bindingRequiredAgent: source.credentialBindingRequiredAgent === true,
    issuedAt: String(source.credentialIssuedAt || "").trim(),
    expiresAt: String(source.credentialExpiresAt || "").trim()
  };
}

export function resolveGrantCapabilities(grant = {}, { registry = null, capabilityResolver = null } = {}) {
  const explicit = normalizeKernelCapabilities(
    grant.capabilities,
    grant.capabilityIds,
    grant.metadata?.capabilities,
    grant.metadata?.capabilityIds
  );
  let resolved = [];
  if (typeof capabilityResolver === "function") {
    const candidateCapabilities = capabilityResolver(grant);
    resolved = normalizeStringList([
      ...normalizeKernelCapabilities(candidateCapabilities),
      ...normalizeRegisteredToolCapabilities(candidateCapabilities)
    ]);
  } else if (registry && typeof registry.resolveToolset === "function") {
    const explicitToolsets = Array.isArray(grant.toolsets) && grant.toolsets.length > 0;
    const toolsetResolution = registry.resolveToolset({
      toolsets: grant.toolsets,
      scopes: explicitToolsets ? [] : grant.scopes,
      toolAllow: grant.toolAllow,
      toolDeny: grant.toolDeny
    });
    const candidateCapabilities = (toolsetResolution.tools || [])
      .map((tool) => toolExecuteCapabilityId(tool.id));
    resolved = normalizeStringList([
      ...normalizeKernelCapabilities(candidateCapabilities),
      ...normalizeRegisteredToolCapabilities(candidateCapabilities)
    ]);
  }
  const capabilities = normalizeStringList([...explicit, ...resolved]);
  return capabilities;
}

export function credentialMetadataFromIssue(issue = {}) {
  return sanitizeGrantMetadata({
    credentialProtocol: issue.protocolVersion || OPAQUE_CAPABILITY_KEY_PROTOCOL_VERSION,
    credentialId: issue.credentialId || "",
    capabilitySetHash: issue.capabilitySetHash || "",
    capabilityCount: issue.capabilityCount || 0,
    runtimeLookupGeneration: issue.runtimeLookupGeneration || 0,
    credentialIssuedAt: nowIso(),
    credentialExpiresAt: issue.expiresAt || ""
  });
}

export function credentialBindingMetadata(binding = {}) {
  if (!binding || typeof binding !== "object") {
    return {};
  }
  return sanitizeGrantMetadata({
    credentialBindingProtocol: binding.protocolVersion || CAPABILITY_BINDING_GUARD_PROTOCOL_VERSION,
    credentialBindingId: binding.bindingId || "",
    credentialBindingStrength: binding.bindingStrength || "",
    credentialBindingRequiredUser: binding.requireUser === true,
    credentialBindingRequiredAgent: binding.requireAgent === true,
    credentialBindingRequiredClient: binding.requireClient === true
  });
}

export function headerValue(request, ...names) {
  const headers = request?.headers || {};
  for (const name of names) {
    const value = headers[name] ?? headers[String(name || "").toLowerCase()];
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function bindingContextFromGrant(grant = {}) {
  const metadata = grant.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return {
    namespace: "operation-permission",
    agentId: firstString(grant.agentId, metadata.agentId, metadata.agentProfileId, metadata.profileId),
    agentProfileId: firstString(grant.agentProfileId, metadata.agentProfileId, metadata.profileId, metadata.agentId),
    userId: firstString(grant.boundUserId, grant.userId, metadata.boundUserId, metadata.userId),
    boundUserId: firstString(grant.boundUserId, grant.userId, metadata.boundUserId, metadata.userId),
    clientId: firstString(grant.clientId, metadata.clientId, metadata.clientName)
  };
}

export function localMcpGrantTargets(grant = {}) {
  const metadata = grant.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return normalizeStringList([
    ...normalizeStringList(metadata.matchedTargets),
    ...normalizeStringList(metadata.targets),
    ...normalizeStringList(metadata.mcpTarget),
    ...normalizeStringList(metadata.clientTarget)
  ]).map(normalizeMcpTarget).filter(Boolean);
}

export function isLocalMcpGrant(grant = {}) {
  const metadata = grant.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return String(metadata.issuedBy || "").trim() === LOCAL_MCP_GRANT_ISSUER ||
    String(grant.type || "").trim() === "mcp-client";
}

export function localMcpTargetBindingDecision(grant = {}, request = null) {
  if (!isLocalMcpGrant(grant)) {
    return { ok: true };
  }
  const targets = localMcpGrantTargets(grant);
  if (targets.length === 0) {
    return { ok: true };
  }
  const requestedTarget = mcpTargetHeaderFromRequest(request);
  if (!requestedTarget) {
    return {
      ok: false,
      reasonCode: "mcp_target_binding_missing",
      requestedTarget,
      allowedTargets: targets
    };
  }
  if (!targets.includes(requestedTarget)) {
    return {
      ok: false,
      reasonCode: "mcp_target_binding_mismatch",
      requestedTarget,
      allowedTargets: targets
    };
  }
  return {
    ok: true,
    requestedTarget,
    allowedTargets: targets
  };
}

export function bindingContextFromRequest({ request = null, context = {} } = {}) {
  const requestContext = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  return {
    namespace: firstString(
      requestContext.namespace,
      requestContext.bindingNamespace,
      headerValue(request, "x-meshrix-binding-namespace", "x-meshrix-namespace"),
      "operation-permission"
    ),
    agentId: firstString(
      requestContext.agentId,
      requestContext.agentProfileId,
      requestContext.profileId,
      headerValue(request, "x-meshrix-agent-id", "x-meshrix-agent-profile-id", "x-meshrix-profile-id")
    ),
    agentProfileId: firstString(
      requestContext.agentProfileId,
      requestContext.profileId,
      requestContext.agentId,
      headerValue(request, "x-meshrix-agent-profile-id", "x-meshrix-profile-id", "x-meshrix-agent-id")
    ),
    userId: firstString(
      requestContext.boundUserId,
      requestContext.userId,
      requestContext.subjectId,
      headerValue(request, "x-meshrix-bound-user-id", "x-meshrix-user-id", "x-meshrix-subject-id")
    ),
    boundUserId: firstString(
      requestContext.boundUserId,
      requestContext.userId,
      requestContext.subjectId,
      headerValue(request, "x-meshrix-bound-user-id", "x-meshrix-user-id", "x-meshrix-subject-id")
    ),
    clientId: firstString(
      requestContext.clientId,
      requestContext.clientName,
      headerValue(request, "x-meshrix-client-id", "x-meshrix-client-name", "x-meshrix-mcp-target", "x-meshrix-client-target"),
      mcpTargetHeaderFromRequest(request)
    )
  };
}

export function bindingContextMismatch(boundContext = {}, requestContext = {}) {
  const checks = [
    [["boundUserId", "userId"], "binding_user_missing", "binding_user_mismatch"],
    [["agentId", "agentProfileId"], "binding_agent_missing", "binding_agent_mismatch"],
    [["clientId"], "binding_client_missing", "binding_client_mismatch"],
    [["namespace"], "binding_namespace_missing", "binding_namespace_mismatch"]
  ];
  for (const [keys, missingReasonCode, mismatchReasonCode] of checks) {
    const boundValue = firstString(...keys.map((key) => boundContext?.[key]));
    const requestValue = firstString(...keys.map((key) => requestContext?.[key]));
    if (boundValue && !requestValue) {
      return { ok: false, reasonCode: missingReasonCode, key: keys[0] };
    }
    if (boundValue && requestValue && boundValue !== requestValue) {
      return { ok: false, reasonCode: mismatchReasonCode, key: keys[0] };
    }
  }
  return { ok: true };
}


export function sourceIpFromRequest(request) {
  return clientIpFromRequest(request);
}
