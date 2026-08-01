import crypto from "node:crypto";
import { normalizeKernelCapabilities } from "@meshrix/foundation/security/authorization/authorization-engine";
import { redactOperationAuditValue } from "@meshrix/foundation/security/operation-audit";
import { clientIpFromRequest } from "@meshrix/foundation/security/trusted-client-ip";
import {
  credentialFromMetadata,
  normalizeDynamicUpstreamCapabilities,
  normalizeRateLimit,
  normalizeStringList,
  parseJson,
  sanitizeGrantMetadata
} from "./store-utils.ts";

function parseStoredJson(value?: any, fallback?: any, expectedType?: any) : any {
  try {
    const parsed: any = JSON.parse(String(value ?? ""));
    const valid: any = expectedType === "array"
      ? Array.isArray(parsed)
      : expectedType === "object"
        ? Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed))
        : true;
    return { value: valid ? parsed : fallback, valid };
  } catch {
    return { value: fallback, valid: false };
  }
}

export function rowToGrant(row?: any) : any {
  if (!row) {
    return null;
  }
  const storedPolicy: Record<string, any> = {
    metadata: parseStoredJson(row.metadata_json, {}, "object"),
    toolsets: parseStoredJson(row.toolsets_json, [], "array"),
    toolAllow: parseStoredJson(row.tool_allow_json, [], "array"),
    toolDeny: parseStoredJson(row.tool_deny_json, [], "array"),
    scopes: parseStoredJson(row.scopes_json, [], "array"),
    rateLimit: parseStoredJson(row.rate_limit_json, {}, "object"),
    allowedOrigins: parseStoredJson(row.allowed_origins_json, [], "array"),
    allowedCidrs: parseStoredJson(row.allowed_cidrs_json, [], "array")
  };
  const metadata: any = storedPolicy.metadata.value;
  const invalidFields: any = (Object.entries(storedPolicy) as [string, any][])
    .filter(([, result]: any[]) : any => result.valid !== true)
    .map(([field]: any[]) : any => field);
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    enabled: Boolean(row.enabled),
    toolsets: storedPolicy.toolsets.value,
    toolAllow: storedPolicy.toolAllow.value,
    toolDeny: storedPolicy.toolDeny.value,
    scopes: storedPolicy.scopes.value,
    capabilities: normalizeKernelCapabilities(metadata.capabilities, metadata.capabilityIds),
    dynamicCapabilities: normalizeDynamicUpstreamCapabilities(metadata.dynamicCapabilities),
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    rateLimit: storedPolicy.rateLimit.value,
    allowedOrigins: storedPolicy.allowedOrigins.value,
    allowedCidrs: storedPolicy.allowedCidrs.value,
    allowedWorkspaceIds: normalizeStringList(metadata.allowedWorkspaceIds),
    allowedDataClasses: normalizeStringList(metadata.allowedDataClasses),
    allowedEgress: normalizeStringList(metadata.allowedEgress),
    allowedStaticSemanticFamilies: normalizeStringList(metadata.allowedStaticSemanticFamilies),
    allowedCapabilityDomains: normalizeStringList(metadata.allowedCapabilityDomains),
    allowedCapabilityVerbs: normalizeStringList(metadata.allowedCapabilityVerbs),
    allowedResourceKinds: normalizeStringList(metadata.allowedResourceKinds),
    allowedEffectKinds: normalizeStringList(metadata.allowedEffectKinds),
    allowedServiceIds: normalizeStringList(metadata.allowedServiceIds),
    allowedSecretBindings: normalizeStringList(metadata.allowedSecretBindings),
    metadata,
    reason: row.reason,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    tokenFamilyId: row.token_family_id,
    useCount: row.use_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    policyIntegrity: {
      valid: invalidFields.length === 0,
      invalidFields
    }
  };
}

export function publicGrant(grant?: any, { catalogFingerprint = "" }: Record<string, any> = {}) : any {
  if (!grant) {
    return null;
  }
  const { tokenHash, policyIntegrity, ownerIntegrity, ...rest } = grant;
  const metadata: any = sanitizeGrantMetadata(rest.metadata);
  const projection: any = grantProjectionDescriptor(rest, {
    metadata,
    catalogFingerprint
  });
  return {
    ...rest,
    metadata,
    capabilities: [],
    credential: credentialFromMetadata(metadata),
    projection,
    projectionFingerprint: projection.fingerprint,
    catalogFingerprintAtRead: projection.catalogFingerprint,
    policyIntegrity: { valid: policyIntegrity?.valid !== false },
    ownerIntegrity: { valid: ownerIntegrity?.valid === true },
    hasToken: Boolean(tokenHash)
  };
}

export function grantProjectionDescriptor(grant: Record<string, any> = {}, {
  metadata = {},
  catalogFingerprint = ""
}: Record<string, any> = {}) : any {
  const normalizedMetadata: any = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
  const projection: Record<string, any> = {
    protocolVersion: "v0.0.1:operation-permission:grant-projection-1",
    grantId: String(grant.id || ""),
    type: String(grant.type || ""),
    enabled: grant.enabled !== false,
    toolsets: normalizeStringList(grant.toolsets).sort(),
    toolAllow: normalizeStringList(grant.toolAllow).sort(),
    toolDeny: normalizeStringList(grant.toolDeny).sort(),
    scopes: normalizeStringList(grant.scopes).sort(),
    dynamicCapabilities: normalizeDynamicUpstreamCapabilities(grant.dynamicCapabilities).sort(),
    allowedServiceIds: normalizeStringList(grant.allowedServiceIds).sort(),
    allowedSecretBindings: normalizeStringList(grant.allowedSecretBindings).sort(),
    allowedOrigins: normalizeStringList(grant.allowedOrigins).sort(),
    allowedCidrs: normalizeStringList(grant.allowedCidrs).sort(),
    maxUses: grant.maxUses === null || grant.maxUses === undefined ? null : Number(grant.maxUses || 0),
    rateLimit: normalizeRateLimit(grant.rateLimit),
    policyRevision: Math.max(0, Number(normalizedMetadata.policyRevision || 0) || 0),
    credentialProtocol: String(normalizedMetadata.credentialProtocol || "").trim(),
    credentialId: String(normalizedMetadata.credentialId || "").trim(),
    owners: (Array.isArray(grant.owners) ? grant.owners : [])
      .map((owner?: any) : any => ({
        ownerKind: String(owner?.ownerKind || ""),
        ownerId: String(owner?.ownerId || ""),
        ownerGeneration: String(owner?.ownerGeneration || "")
      }))
      .filter((owner?: any) : any => owner.ownerKind && owner.ownerId && owner.ownerGeneration)
      .sort((left?: any, right?: any) : any =>
        `${left.ownerKind}:${left.ownerId}:${left.ownerGeneration}`
          .localeCompare(`${right.ownerKind}:${right.ownerId}:${right.ownerGeneration}`)
      ),
    catalogFingerprint: String(catalogFingerprint || "").trim()
  };
  return {
    ...projection,
    fingerprint: hashValue(projection)
  };
}

function sourceIpFromRequest(request?: any) : any {
  return clientIpFromRequest(request);
}

export function hashValue(value?: any) : any {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export function summarizeValue(value?: any) : any {
  const redacted: any = redactOperationAuditValue(value);
  if (redacted === null || redacted === undefined) {
    return {};
  }
  if (Buffer.isBuffer(redacted)) {
    return { type: "buffer", byteLength: redacted.length, sha256: crypto.createHash("sha256").update(redacted).digest("hex") };
  }
  if (typeof redacted !== "object") {
    return { value: redacted };
  }
  if (Array.isArray(redacted)) {
    return { type: "array", length: redacted.length };
  }
  const summary: Record<string, any> = {};
  for (const [key, nested] of (Object.entries(redacted) as [string, any][]).slice(0, 40)) {
    if (/token|secret|password|authorization|cookie|api[-_]?key|source[-_]?path|local[-_]?path|dir[-_]?path|content[-_]?base64|file[-_]?content|raw[-_]?content|^content$/i.test(key)) {
      summary[key] = "<redacted>";
    } else if (/^(body|bodyJson|payload|params|rpcParams|headers)$/i.test(key)) {
      summary[key] = summarizeMetadataOnlyValue(nested);
    } else if (Array.isArray(nested)) {
      summary[key] = { type: "array", length: nested.length };
    } else if (nested && typeof nested === "object") {
      summary[key] = { type: "object", keys: Object.keys(nested).slice(0, 20) };
    } else {
      summary[key] = nested;
    }
  }
  return summary;
}

function summarizeMetadataOnlyValue(value?: any) : any {
  if (value === null || value === undefined) {
    return { type: "empty", metadataOnly: true };
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex"),
      metadataOnly: true
    };
  }
  if (typeof value === "string") {
    return {
      type: "string",
      byteLength: Buffer.byteLength(value, "utf8"),
      sha256: crypto.createHash("sha256").update(value).digest("hex"),
      metadataOnly: true
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      metadataOnly: true
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).slice(0, 20),
      metadataOnly: true
    };
  }
  return {
    type: typeof value,
    metadataOnly: true
  };
}

function delegatedChildOperationSummary(value: any = null) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const text: any = (field?: any) : any => String(value[field] || "").trim();
  const mismatches: any = Array.isArray(value.requestBindingMismatches)
    ? value.requestBindingMismatches.map((item?: any) : any => String(item || "").trim()).filter(Boolean).slice(0, 16)
    : [];
  const missingBindings: any = Array.isArray(value.missingRequestBindings)
    ? value.missingRequestBindings.map((item?: any) : any => String(item || "").trim()).filter(Boolean).slice(0, 16)
    : [];
  const summary: Record<string, any> = {
    schemaVersion: "v0.0.1:schema:definition-1",
    issuer: text("issuer"),
    binding: text("binding"),
    delegatedSessionId: text("delegatedSessionId"),
    delegatedTurnId: text("delegatedTurnId"),
    delegatedSubjectId: text("delegatedSubjectId"),
    delegatedTargetId: text("delegatedTargetId"),
    delegatedWorkspaceId: text("delegatedWorkspaceId"),
    delegatedMcpGrantId: text("delegatedMcpGrantId"),
    grantType: text("grantType"),
    grantBindingVerified: value.grantBindingVerified === true,
    missingRequestBindings: missingBindings,
    requestBindingMismatches: mismatches,
    traceId: text("traceId"),
    parentOperationId: text("parentOperationId"),
    operationId: text("operationId")
  };
  if (!summary.delegatedMcpGrantId && !summary.delegatedSessionId && !summary.delegatedTurnId) {
    return null;
  }
  return summary;
}

export function executionResultSummary(entry: Record<string, any> = {}) : any {
  const base: any = entry.resultSummary !== undefined
    ? entry.resultSummary
    : summarizeValue(entry.result || {});
  const delegatedChildOperation: any = delegatedChildOperationSummary(
    {
      ...(entry.delegatedChildOperation ||
        entry.context?.delegatedChildOperation ||
        (base && typeof base === "object" && !Array.isArray(base) ? base.delegatedChildOperation : null) ||
        {}),
      operationId: entry.operationId || entry.delegatedChildOperation?.operationId || entry.context?.delegatedChildOperation?.operationId
    }
  );
  if (!delegatedChildOperation) {
    return base;
  }
  if (base && typeof base === "object" && !Array.isArray(base)) {
    return {
      ...base,
      delegatedChildOperation
    };
  }
  return {
    type: "summary",
    value: base,
    delegatedChildOperation
  };
}

export function rowToPendingOperation(row?: any, { includeOriginalInput = false }: Record<string, any> = {}) : any {
  if (!row) {
    return null;
  }
  const resultSummary: any = parseJson(row.result_summary_json, {});
  const executionOutcome: any = [
    "continued_pending_approval",
    "executed_once",
    "execution_failed"
  ].includes(String(resultSummary?.executionOutcome || ""))
    ? String(resultSummary.executionOutcome)
    : "";
  const pending: Record<string, any> = {
    pendingOperationId: row.pending_operation_id,
    traceId: row.trace_id,
    toolExecutionId: row.tool_execution_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    toolsetIds: parseJson(row.toolset_ids_json, []),
    operationId: row.operation_id,
    risk: row.risk,
    approvalScope: row.approval_scope,
    requiredApproval: parseJson(row.approval_requirements_json, {}),
    approvalLayers: parseJson(row.approval_layers_json, []),
    grantId: row.grant_id,
    agentId: row.agent_id,
    profileId: row.profile_id,
    idempotencyKey: row.idempotency_key,
    reasonCode: row.reason_code,
    riskReason: row.risk_reason,
    redactedInput: parseJson(row.redacted_input_json, {}),
    context: parseJson(row.context_json, {}),
    status: row.status,
    resultSummary,
    ...(executionOutcome ? { executionOutcome } : {}),
    errorCode: row.error_code,
    resolvedBy: row.resolved_by,
    resolutionReason: row.resolution_reason,
    resumedToolExecutionId: row.resumed_tool_execution_id,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    completedAt: row.completed_at
  };
  if (includeOriginalInput) {
    pending.originalInput = parseJson(row.resume_input_json || row.original_input_json, {});
  }
  return pending;
}
