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
} from "./catalog.ts";

export const DEFAULT_RATE_LIMIT_PER_MINUTE: any = 0;
export const LOCAL_MCP_GRANT_ISSUER: any = "meshrix-mcp-local-pairing";
export function nowIso() : any {
  return new Date().toISOString();
}

export function randomId(prefix?: any) : any {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

export function redactedTraceRef(request: any = null) : any {
  const raw: any = String(request?.__meshrixTraceContext?.traceId || request?.__meshrixRequestId || "");
  return raw ? `trace:${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}` : "";
}

export function isEnabled(value: any = "") : any {
  return /^(1|true|yes|on|command|helper)$/i.test(String(value || "").trim());
}

export function hashToken(token?: any) : any {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function safeCompare(left?: any, right?: any) : any {
  const leftBuffer: any = Buffer.from(String(left || ""), "utf8");
  const rightBuffer: any = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function readBearerToken(request?: any) : any {
  const authorization: any = String(request?.headers?.authorization || "");
  const match: any = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) {
    return match[1].trim();
  }
  return String(request?.headers?.["x-meshrix-tool-token"] || "").trim();
}

export function parseJson(value?: any, fallback?: any) : any {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export function stringifyJson(value?: any) : any {
  return JSON.stringify(value ?? null);
}

export function normalizeStringList(value?: any) : any {
  if (Array.isArray(value)) {
    return [...new Set<any>(value.map((item?: any) : any => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return normalizeStringList(value.split(","));
  }
  return [];
}

const DYNAMIC_UPSTREAM_CAPABILITY_PATTERN: any = /^cap:upstream(?:-tuple)?:[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/iu;

export function normalizeDynamicUpstreamCapabilities(value?: any) : any {
  return normalizeStringList(value)
    .filter((capability?: any) : any => DYNAMIC_UPSTREAM_CAPABILITY_PATTERN.test(capability))
    .slice(0, 512);
}

export function rejectInvalidDynamicUpstreamCapabilities(value?: any) : any {
  const requested: any = normalizeStringList(value);
  const normalized: any = normalizeDynamicUpstreamCapabilities(requested);
  if (requested.length !== normalized.length) {
    throw new Error("Dynamic upstream capabilities must use canonical cap:upstream:* identifiers.");
  }
  return normalized;
}

export function firstString(...values: any[]) : any {
  for (const value of values) {
    const text: any = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function normalizeMcpTarget(value?: any) : any {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

export function mcpTargetHeaderFromRequest(request?: any) : any {
  const headerTarget: any = normalizeMcpTarget(headerValue(
    request,
    "x-meshrix.js-mcp-target",
    "x-meshrix-client-target",
    "x-meshrix-tool-target",
    "x-meshrix-client-id"
  ));
  if (headerTarget) {
    return headerTarget;
  }
  try {
    const parsed: any = new URL(String(request?.url || ""), "http://127.0.0.1");
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

export function normalizeScopes(scopes?: any) : any {
  const valid: any = new Set<any>(OPERATION_PERMISSION_SCOPES.map((scope?: any) : any => scope.id));
  return normalizeStringList(scopes).filter((scope?: any) : any => valid.has(scope));
}

export function normalizeRateLimit(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE };
  }
  return {
    perMinute: Math.max(0, Number(value.perMinute || value.per_minute || 0) || 0)
  };
}

export function normalizePolicyRevisionSnapshot(value: Record<string, any> = {}) : any {
  const revision: any = Number(value?.revision || value?.policyRevision || 0);
  const normalizedRevision: any = Number.isFinite(revision) && revision > 0 ? revision : 0;
  return {
    protocolVersion: String(value?.protocolVersion || value?.protocol_version || "").trim(),
    revision: normalizedRevision,
    updatedAt: String(value?.updatedAt || value?.updated_at || "").trim()
  };
}

export function normalizePendingOperationStatus(value: any = "pending") : any {
  const status: any = String(value || "pending").trim().toLowerCase();
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

export function stampGrantPolicyRevision(metadata: Record<string, any> = {}, policyRevision: Record<string, any> = {}) : any {
  const snapshot: any = normalizePolicyRevisionSnapshot(policyRevision);
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

export function normalizeGrantInput(input: Record<string, any> = {}, fallback: Record<string, any> = {}) : any {
  const explicitScopes: any = normalizeScopes(input.scopes ?? fallback.scopes);
  const toolsets: any = normalizeStringList(input.toolsets ?? fallback.toolsets);
  const scopes: any = explicitScopes.length ? explicitScopes : normalizeScopes(toolsetsToScopes(toolsets));
  const normalizedToolsets: any = toolsets.length ? toolsets : scopesToToolsets(scopes);
  const createdAt: any = fallback.createdAt || nowIso();
  const fallbackMetadata: any = fallback.metadata && typeof fallback.metadata === "object" && !Array.isArray(fallback.metadata)
    ? fallback.metadata
    : {};
  const inputMetadata: any = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const metadata: Record<string, any> = {
    ...fallbackMetadata,
    ...inputMetadata
  };
  const capabilities: any = normalizeKernelCapabilities(
    input.capabilities,
    input.capabilityIds,
    metadata.capabilities,
    metadata.capabilityIds,
    fallback.capabilities,
    fallback.capabilityIds,
    fallbackMetadata.capabilities,
    fallbackMetadata.capabilityIds
  );
  const dynamicCapabilities: any = normalizeDynamicUpstreamCapabilities(
    input.dynamicCapabilities ??
      input.upstreamCapabilities ??
      inputMetadata.dynamicCapabilities ??
      inputMetadata.upstreamCapabilities ??
      fallback.dynamicCapabilities ??
      fallback.upstreamCapabilities ??
      fallbackMetadata.dynamicCapabilities ??
      fallbackMetadata.upstreamCapabilities
  );
  const agentId: any = firstString(input.agentId, input.agent_id, input.agentProfileId, metadata.agentId, metadata.agentProfileId);
  const agentProfileId: any = firstString(input.agentProfileId, input.profileId, input.profile_id, metadata.agentProfileId, metadata.profileId, agentId);
  const boundUserId: any = firstString(input.boundUserId, input.bound_user_id, input.userId, input.user_id, metadata.boundUserId, metadata.userId);
  const teamIds: any = normalizeStringList(input.teamIds ?? input.team_ids ?? metadata.teamIds);
  const allowedWorkspaceIds: any = normalizeStringList(input.allowedWorkspaceIds ?? fallback.allowedWorkspaceIds ?? metadata.allowedWorkspaceIds);
  const allowedDataClasses: any = normalizeStringList(input.allowedDataClasses ?? fallback.allowedDataClasses ?? metadata.allowedDataClasses);
  const allowedEgress: any = normalizeStringList(input.allowedEgress ?? fallback.allowedEgress ?? metadata.allowedEgress);
  const allowedStaticSemanticFamilies: any = normalizeStringList(input.allowedStaticSemanticFamilies ?? fallback.allowedStaticSemanticFamilies ?? metadata.allowedStaticSemanticFamilies);
  const allowedCapabilityDomains: any = normalizeStringList(input.allowedCapabilityDomains ?? fallback.allowedCapabilityDomains ?? metadata.allowedCapabilityDomains);
  const allowedCapabilityVerbs: any = normalizeStringList(input.allowedCapabilityVerbs ?? fallback.allowedCapabilityVerbs ?? metadata.allowedCapabilityVerbs);
  const allowedResourceKinds: any = normalizeStringList(input.allowedResourceKinds ?? fallback.allowedResourceKinds ?? metadata.allowedResourceKinds);
  const allowedEffectKinds: any = normalizeStringList(input.allowedEffectKinds ?? fallback.allowedEffectKinds ?? metadata.allowedEffectKinds);
  const allowedServiceIds: any = normalizeStringList(input.allowedServiceIds ?? fallback.allowedServiceIds ?? metadata.allowedServiceIds);
  const allowedSecretBindings: any = normalizeStringList(input.allowedSecretBindings ?? fallback.allowedSecretBindings ?? metadata.allowedSecretBindings);
  const type: string = String(input.type ?? fallback.type ?? "machine").trim() || "machine";
  const parentGrantId: string = type === "delegated-mcp-child"
    ? firstString(input.parentGrantId, inputMetadata.delegatedMcp?.sourceGrantId, fallback.parentGrantId)
    : "";
  return {
    id: String(input.id || fallback.id || randomId("grant")),
    label: String(input.label ?? fallback.label ?? "Agent Tool Grant").trim() || "Agent Tool Grant",
    type,
    parentGrantId,
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

export function sanitizeGrantMetadata(metadata: Record<string, any> = {}) : any {
  const source: any = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
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

export function rejectUnknownGrantCapabilities(input: Record<string, any> = {}) : any {
  const metadata: any = input?.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const unknown: any = unknownKernelCapabilities(
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

export function credentialFromMetadata(metadata: Record<string, any> = {}) : any {
  const source: any = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const protocolVersion: any = String(source.credentialProtocol || source.protocolVersion || "").trim();
  const credentialId: any = String(source.credentialId || "").trim();
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

export function resolveGrantCapabilities(grant: Record<string, any> = {}, { registry = null, capabilityResolver = null }: Record<string, any> = {}) : any {
  const explicit: any = normalizeKernelCapabilities(
    grant.capabilities,
    grant.capabilityIds,
    grant.metadata?.capabilities,
    grant.metadata?.capabilityIds
  );
  let resolved: any[] = [];
  if (typeof capabilityResolver === "function") {
    const candidateCapabilities: any = capabilityResolver(grant);
    resolved = normalizeStringList([
      ...normalizeKernelCapabilities(candidateCapabilities),
      ...normalizeRegisteredToolCapabilities(candidateCapabilities)
    ]);
  } else if (registry && typeof registry.resolveToolset === "function") {
    const explicitToolsets: any = Array.isArray(grant.toolsets) && grant.toolsets.length > 0;
    const toolsetResolution: any = registry.resolveToolset({
      toolsets: grant.toolsets,
      scopes: explicitToolsets ? [] : grant.scopes,
      toolAllow: grant.toolAllow,
      toolDeny: grant.toolDeny
    });
    const candidateCapabilities: any = (toolsetResolution.tools || [])
      .map((tool?: any) : any => toolExecuteCapabilityId(tool.id));
    resolved = normalizeStringList([
      ...normalizeKernelCapabilities(candidateCapabilities),
      ...normalizeRegisteredToolCapabilities(candidateCapabilities)
    ]);
  }
  const capabilities: any = normalizeStringList([...explicit, ...resolved]);
  return capabilities;
}

export function credentialMetadataFromIssue(issue: Record<string, any> = {}) : any {
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

export function credentialBindingMetadata(binding: Record<string, any> = {}) : any {
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

export function headerValue(request: any, ...names: any[]) : any {
  const headers: any = request?.headers || {};
  for (const name of names) {
    const value: any = headers[name] ?? headers[String(name || "").toLowerCase()];
    const normalized: any = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function bindingContextFromGrant(grant: Record<string, any> = {}) : any {
  const metadata: any = grant.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
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

export function localMcpGrantTargets(grant: Record<string, any> = {}) : any {
  const metadata: any = grant.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return normalizeStringList([
    ...normalizeStringList(metadata.matchedTargets),
    ...normalizeStringList(metadata.targets),
    ...normalizeStringList(metadata.mcpTarget),
    ...normalizeStringList(metadata.clientTarget)
  ]).map(normalizeMcpTarget).filter(Boolean);
}

export function isLocalMcpGrant(grant: Record<string, any> = {}) : any {
  const metadata: any = grant.metadata && typeof grant.metadata === "object" && !Array.isArray(grant.metadata)
    ? grant.metadata
    : {};
  return String(metadata.issuedBy || "").trim() === LOCAL_MCP_GRANT_ISSUER ||
    String(grant.type || "").trim() === "mcp-client";
}

export function localMcpTargetBindingDecision(grant: Record<string, any> = {}, request: any = null) : any {
  if (!isLocalMcpGrant(grant)) {
    return { ok: true };
  }
  const targets: any = localMcpGrantTargets(grant);
  if (targets.length === 0) {
    return { ok: true };
  }
  const requestedTarget: any = mcpTargetHeaderFromRequest(request);
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

export function bindingContextFromRequest({ request = null, context = {} }: Record<string, any> = {}) : any {
  const requestContext: any = context && typeof context === "object" && !Array.isArray(context) ? context : {};
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
      headerValue(request, "x-meshrix-client-id", "x-meshrix-client-name", "x-meshrix.js-mcp-target", "x-meshrix-client-target"),
      mcpTargetHeaderFromRequest(request)
    )
  };
}

export function bindingContextMismatch(boundContext: Record<string, any> = {}, requestContext: Record<string, any> = {}) : any {
  const checks: any[] = [
    [["boundUserId", "userId"], "binding_user_missing", "binding_user_mismatch"],
    [["agentId", "agentProfileId"], "binding_agent_missing", "binding_agent_mismatch"],
    [["clientId"], "binding_client_missing", "binding_client_mismatch"],
    [["namespace"], "binding_namespace_missing", "binding_namespace_mismatch"]
  ];
  for (const [keys, missingReasonCode, mismatchReasonCode] of checks) {
    const boundValue: any = firstString(...keys.map((key?: any) : any => boundContext?.[key]));
    const requestValue: any = firstString(...keys.map((key?: any) : any => requestContext?.[key]));
    if (boundValue && !requestValue) {
      return { ok: false, reasonCode: missingReasonCode, key: keys[0] };
    }
    if (boundValue && requestValue && boundValue !== requestValue) {
      return { ok: false, reasonCode: mismatchReasonCode, key: keys[0] };
    }
  }
  return { ok: true };
}


export function sourceIpFromRequest(request?: any) : any {
  return clientIpFromRequest(request);
}
