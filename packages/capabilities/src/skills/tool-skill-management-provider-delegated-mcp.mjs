import {
  compactText,
  grantMetadata,
  normalizeGrantValues,
  parseTime,
  positiveInteger
} from "./tool-skill-management-provider-grant-utils.mjs";

const DEFAULT_DELEGATED_MCP_GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_DELEGATED_MCP_GRANT_TTL_MS = 60 * 60 * 1000;
const REQUIRED_DELEGATION_FIELDS = Object.freeze([
  "issuer",
  "binding",
  "sessionId",
  "turnId",
  "subjectId",
  "targetId",
  "parentOperationId",
  "workspaceId",
  "traceId"
]);
const DELEGATED_GRANT_SUBSET_FIELDS = Object.freeze([
  Object.freeze({ field: "scopes", inputFields: ["scopes"], parentEmptyIsUnbounded: false }),
  Object.freeze({ field: "toolsets", inputFields: ["toolsets"], parentEmptyIsUnbounded: false }),
  Object.freeze({ field: "toolAllow", inputFields: ["toolAllow"], parentEmptyIsUnbounded: true }),
  Object.freeze({ field: "capabilities", inputFields: ["capabilities"], parentEmptyIsUnbounded: false }),
  Object.freeze({
    field: "dynamicCapabilities",
    inputFields: ["dynamicCapabilities", "upstreamCapabilities"],
    parentEmptyIsUnbounded: false
  }),
  Object.freeze({
    field: "allowedWorkspaceIds",
    inputFields: ["allowedWorkspaceIds", "workspaceIds", "workspaceId"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({ field: "allowedDataClasses", inputFields: ["allowedDataClasses"], parentEmptyIsUnbounded: true }),
  Object.freeze({ field: "allowedEgress", inputFields: ["allowedEgress"], parentEmptyIsUnbounded: true }),
  Object.freeze({
    field: "allowedStaticSemanticFamilies",
    inputFields: ["allowedStaticSemanticFamilies"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({
    field: "allowedCapabilityDomains",
    inputFields: ["allowedCapabilityDomains"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({
    field: "allowedCapabilityVerbs",
    inputFields: ["allowedCapabilityVerbs"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({
    field: "allowedResourceKinds",
    inputFields: ["allowedResourceKinds"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({
    field: "allowedEffectKinds",
    inputFields: ["allowedEffectKinds"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({
    field: "allowedServiceIds",
    inputFields: ["allowedServiceIds", "upstreamServiceIds"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({
    field: "allowedSecretBindings",
    inputFields: ["allowedSecretBindings", "credentialBindingIds"],
    parentEmptyIsUnbounded: true
  }),
  Object.freeze({ field: "allowedOrigins", inputFields: ["allowedOrigins"], parentEmptyIsUnbounded: true }),
  Object.freeze({ field: "allowedCidrs", inputFields: ["allowedCidrs"], parentEmptyIsUnbounded: true })
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstDefinedField(input = {}, fields = []) {
  for (const field of fields) {
    if (input[field] !== undefined) {
      return input[field];
    }
  }
  return undefined;
}

function canonicalGrantField(grant = {}, field = "") {
  if (grant[field] !== undefined) {
    return grant[field];
  }
  return grantMetadata(grant)[field];
}

function strictSubsetValues(requestedValue, parentValue, {
  parentEmptyIsUnbounded = false
} = {}) {
  const requested = normalizeGrantValues(requestedValue, Number.MAX_SAFE_INTEGER);
  const parent = normalizeGrantValues(parentValue, Number.MAX_SAFE_INTEGER);
  if (requested.length === 0) {
    return { values: parent, outsideParent: [] };
  }
  if (parent.length === 0) {
    return parentEmptyIsUnbounded
      ? { values: requested, outsideParent: [] }
      : { values: [], outsideParent: requested };
  }
  const parentSet = new Set(parent);
  const outsideParent = requested.filter((value) => !parentSet.has(value));
  return {
    values: outsideParent.length === 0 ? requested : [],
    outsideParent
  };
}

function sameGrantValues(leftValue, rightValue) {
  const left = normalizeGrantValues(leftValue, Number.MAX_SAFE_INTEGER).sort();
  const right = normalizeGrantValues(rightValue, Number.MAX_SAFE_INTEGER).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceGrantSnapshotMatches(authorizedGrant = {}, canonicalGrant = {}) {
  for (const field of ["type", "expiresAt", "revokedAt"]) {
    if (compactText(authorizedGrant[field]) !== compactText(canonicalGrant[field])) {
      return false;
    }
  }
  if (authorizedGrant.enabled !== canonicalGrant.enabled) {
    return false;
  }
  return [
    ...DELEGATED_GRANT_SUBSET_FIELDS.map(({ field }) => field),
    "toolDeny"
  ].every((field) => sameGrantValues(
    canonicalGrantField(authorizedGrant, field),
    canonicalGrantField(canonicalGrant, field)
  ));
}

function delegatedGrantConstraints(input = {}, sourceGrant = {}) {
  const constraints = {};
  const outsideParentFields = [];
  for (const descriptor of DELEGATED_GRANT_SUBSET_FIELDS) {
    const narrowed = strictSubsetValues(
      firstDefinedField(input, descriptor.inputFields),
      canonicalGrantField(sourceGrant, descriptor.field),
      descriptor
    );
    constraints[descriptor.field] = narrowed.values;
    if (narrowed.outsideParent.length > 0) {
      outsideParentFields.push(descriptor.field);
    }
  }
  constraints.toolDeny = normalizeGrantValues([
    ...normalizeGrantValues(canonicalGrantField(sourceGrant, "toolDeny"), Number.MAX_SAFE_INTEGER),
    ...normalizeGrantValues(input.toolDeny, Number.MAX_SAFE_INTEGER)
  ], Number.MAX_SAFE_INTEGER);
  return {
    constraints,
    outsideParentFields
  };
}

function sourceGrantStateError(sourceGrant = {}, nowMs = Date.now()) {
  if (compactText(sourceGrant.revokedAt)) {
    return {
      code: "delegated_mcp_source_grant_revoked",
      message: "The source Operation Permission grant is revoked."
    };
  }
  if (sourceGrant.enabled !== true) {
    return {
      code: "delegated_mcp_source_grant_disabled",
      message: "The source Operation Permission grant is disabled."
    };
  }
  const expiresAt = compactText(sourceGrant.expiresAt);
  const expiresAtMs = parseTime(expiresAt);
  if (expiresAt && !expiresAtMs) {
    return {
      code: "delegated_mcp_source_grant_invalid",
      message: "The source Operation Permission grant has an invalid expiry."
    };
  }
  if (expiresAtMs && expiresAtMs <= nowMs) {
    return {
      code: "delegated_mcp_source_grant_expired",
      message: "The source Operation Permission grant is expired."
    };
  }
  return null;
}

function normalizedDelegation(value = {}) {
  const input = asObject(value);
  return Object.freeze(Object.fromEntries([
    ...REQUIRED_DELEGATION_FIELDS,
    "sourceId",
    "sourceSessionId",
    "sourceSubjectId",
    "requestId"
  ]
    .map((field) => [field, compactText(input[field])])
    .filter(([, fieldValue]) => fieldValue)));
}

function delegationValidationError(delegation = {}) {
  const missingFields = REQUIRED_DELEGATION_FIELDS.filter((field) => !compactText(delegation[field]));
  if (missingFields.length === 0) return null;
  return {
    ok: false,
    status: 400,
    error: {
      code: "delegated_mcp_binding_required",
      message: "Delegated MCP grants require a complete child-operation binding.",
      details: { missingFields }
    }
  };
}

export function resolveDelegatedMcpGrantExpiry({
  input = {},
  sourceGrant = {},
  nowMs = Date.now()
} = {}) {
  const defaultTtlMs = positiveInteger(
    input.defaultTtlMs ?? process.env.MESHRIX_DELEGATED_MCP_GRANT_TTL_MS,
    DEFAULT_DELEGATED_MCP_GRANT_TTL_MS
  );
  const maxTtlMs = positiveInteger(
    input.maxTtlMs ?? process.env.MESHRIX_DELEGATED_MCP_GRANT_MAX_TTL_MS,
    MAX_DELEGATED_MCP_GRANT_TTL_MS
  );
  const requestedTtlMs = positiveInteger(input.ttlMs, 0);
  const requestedExpiresAtMs = parseTime(input.expiresAt);
  const sourceExpiresAtMs = parseTime(sourceGrant.expiresAt);
  const baseExpiryMs = requestedExpiresAtMs ||
    nowMs + Math.min(requestedTtlMs || defaultTtlMs, maxTtlMs);
  const caps = [
    baseExpiryMs,
    nowMs + maxTtlMs,
    ...(sourceExpiresAtMs ? [sourceExpiresAtMs] : [])
  ].filter((value) => Number.isFinite(value) && value > 0);
  const expiresAtMs = Math.min(...caps);
  return {
    ok: expiresAtMs > nowMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    ttlMs: Math.max(0, expiresAtMs - nowMs),
    requestedExpiresAt: requestedExpiresAtMs ? new Date(requestedExpiresAtMs).toISOString() : "",
    sourceExpiresAt: sourceExpiresAtMs ? new Date(sourceExpiresAtMs).toISOString() : "",
    maxTtlMs
  };
}

export function delegatedMcpGrantReuseAllowed(existingGrant, {
  delegation = {},
  sourceGrantId = "",
} = {}) {
  if (!existingGrant) {
    return true;
  }
  const metadata = grantMetadata(existingGrant);
  const existingDelegation = asObject(metadata.delegatedMcp);
  if (compactText(existingGrant.type) !== "delegated-mcp-child") {
    return false;
  }
  if (compactText(existingDelegation.sourceGrantId) !== compactText(sourceGrantId)) {
    return false;
  }
  return REQUIRED_DELEGATION_FIELDS
    .every((field) => compactText(existingDelegation[field]) === compactText(delegation[field]));
}

export function delegatedMcpGrantCollisionError(existingGrant, {
  delegation = {}
} = {}) {
  const metadata = grantMetadata(existingGrant);
  const existingDelegation = asObject(metadata.delegatedMcp);
  const mismatchFields = REQUIRED_DELEGATION_FIELDS
    .filter((field) => compactText(existingDelegation[field]) !== compactText(delegation[field]));
  return {
    ok: false,
    status: 409,
    error: {
      code: "delegated_mcp_grant_id_collision",
      message: "Delegated MCP child grant id is already bound to another owner.",
      details: {
        existingType: compactText(existingGrant?.type),
        mismatchFields
      }
    }
  };
}

export async function createDelegatedMcpGrantForPlatform(current, input = {}) {
  const delegation = normalizedDelegation(input.delegation);
  const invalidDelegation = delegationValidationError(delegation);
  if (invalidDelegation) return invalidDelegation;
  const sourceAuthorization = asObject(input.sourceAuthorization);
  const authorizedSourceGrant = asObject(sourceAuthorization.grant);
  const sourceGrantId = compactText(authorizedSourceGrant.id);
  const authorizedProjectionFingerprint = compactText(authorizedSourceGrant.projectionFingerprint);
  if (
    sourceAuthorization.ok !== true ||
    sourceAuthorization.authorizationDecision?.allowed === false ||
    !sourceGrantId ||
    !authorizedProjectionFingerprint
  ) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_source_grant_required",
        message: "A verified source Operation Permission grant is required before issuing a delegated MCP grant."
      }
    };
  }

  if (typeof current?.store?.getGrant !== "function") {
    return {
      ok: false,
      status: 503,
      error: {
        code: "delegated_mcp_source_grant_store_unavailable",
        message: "The canonical Operation Permission grant store is unavailable."
      }
    };
  }
  let sourceGrant;
  try {
    sourceGrant = asObject(await current.store.getGrant(sourceGrantId));
  } catch {
    return {
      ok: false,
      status: 503,
      error: {
        code: "delegated_mcp_source_grant_store_unavailable",
        message: "The canonical Operation Permission grant store is unavailable."
      }
    };
  }
  if (!compactText(sourceGrant.id)) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_source_grant_not_found",
        message: "The source Operation Permission grant does not exist."
      }
    };
  }
  const canonicalProjectionFingerprint = compactText(sourceGrant.projectionFingerprint);
  if (
    compactText(sourceGrant.id) !== sourceGrantId ||
    !canonicalProjectionFingerprint ||
    canonicalProjectionFingerprint !== authorizedProjectionFingerprint ||
    !sourceGrantSnapshotMatches(authorizedSourceGrant, sourceGrant)
  ) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_source_grant_mismatch",
        message: "The source Operation Permission authorization no longer matches the canonical grant."
      }
    };
  }
  const nowMs = Date.now();
  const invalidSourceGrant = sourceGrantStateError(sourceGrant, nowMs);
  if (invalidSourceGrant) {
    return {
      ok: false,
      status: 403,
      error: invalidSourceGrant
    };
  }

  const { constraints, outsideParentFields } = delegatedGrantConstraints(input, sourceGrant);
  if (outsideParentFields.length > 0) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_source_grant_subset_violation",
        message: "Delegated MCP grant constraints must remain within the source grant.",
        details: { fields: outsideParentFields }
      }
    };
  }
  if (
    constraints.toolsets.length === 0 &&
    constraints.toolAllow.length === 0 &&
    constraints.capabilities.length === 0 &&
    constraints.dynamicCapabilities.length === 0
  ) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_source_grant_empty",
        message: "The source Operation Permission grant has no delegable execution boundary."
      }
    };
  }
  if (
    constraints.allowedWorkspaceIds.length > 0 &&
    !constraints.allowedWorkspaceIds.includes(delegation.workspaceId)
  ) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_workspace_not_allowed",
        message: "The delegated MCP workspace is outside the source grant."
      }
    };
  }

  const requestedGrantId = compactText(input.grantId);
  const existingGrant = requestedGrantId && typeof current.store.getGrant === "function"
    ? await current.store.getGrant(requestedGrantId)
    : null;
  if (existingGrant && !delegatedMcpGrantReuseAllowed(existingGrant, {
    delegation,
    sourceGrantId
  })) {
    return delegatedMcpGrantCollisionError(existingGrant, {
      delegation
    });
  }
  const expiry = resolveDelegatedMcpGrantExpiry({ input, sourceGrant, nowMs });
  if (!expiry.ok) {
    return {
      ok: false,
      status: 403,
      error: {
        code: "delegated_mcp_grant_expired",
        message: "Delegated MCP child grant expiry is already elapsed or outside the source grant validity window.",
        details: {
          sourceGrantId: compactText(sourceGrant.id),
          sourceExpiresAt: expiry.sourceExpiresAt,
          requestedExpiresAt: expiry.requestedExpiresAt
        }
      }
    };
  }
  const grantResult = await current.store.createGrant({
    ...(requestedGrantId ? { id: requestedGrantId } : {}),
    label: compactText(input.label) || `Delegated MCP ${delegation.subjectId} -> ${delegation.targetId}`,
    type: "delegated-mcp-child",
    enabled: true,
    scopes: constraints.scopes,
    toolsets: constraints.toolsets,
    toolAllow: constraints.toolAllow,
    toolDeny: constraints.toolDeny,
    ...(constraints.capabilities.length ? { capabilities: constraints.capabilities } : {}),
    dynamicCapabilities: constraints.dynamicCapabilities,
    allowedWorkspaceIds: constraints.allowedWorkspaceIds,
    allowedDataClasses: constraints.allowedDataClasses,
    allowedEgress: constraints.allowedEgress,
    allowedStaticSemanticFamilies: constraints.allowedStaticSemanticFamilies,
    allowedCapabilityDomains: constraints.allowedCapabilityDomains,
    allowedCapabilityVerbs: constraints.allowedCapabilityVerbs,
    allowedResourceKinds: constraints.allowedResourceKinds,
    allowedEffectKinds: constraints.allowedEffectKinds,
    allowedServiceIds: constraints.allowedServiceIds,
    allowedSecretBindings: constraints.allowedSecretBindings,
    allowedOrigins: constraints.allowedOrigins,
    allowedCidrs: constraints.allowedCidrs,
    expiresAt: expiry.expiresAt,
    metadata: {
      delegatedMcp: {
        ...delegation,
        sourceGrantId: compactText(sourceGrant.id),
        sourceGrantType: compactText(sourceGrant.type),
        grantTtlMs: expiry.ttlMs,
        grantMaxTtlMs: expiry.maxTtlMs,
        grantExpiresAt: expiry.expiresAt
      }
    },
    reason: compactText(input.reason) || `Delegated MCP grant for ${delegation.binding} session ${delegation.sessionId}`
  });
  return {
    ok: true,
    status: 201,
    grant: grantResult.grant,
    token: grantResult.token
  };
}

export async function revokeDelegatedMcpGrantForPlatform(current, input = {}) {
  const grantId = compactText(input.grantId);
  if (!grantId) {
    return null;
  }
  const grant = typeof current.store.getGrant === "function" ? current.store.getGrant(grantId) : null;
  if (grant) {
    const metadata = grantMetadata(grant);
    const existingDelegation = asObject(metadata.delegatedMcp);
    const delegation = normalizedDelegation(input.delegation);
    const bindingMatches = REQUIRED_DELEGATION_FIELDS.every((field) => (
      compactText(delegation[field]) &&
      compactText(delegation[field]) === compactText(existingDelegation[field])
    ));
    if (compactText(grant.type) !== "delegated-mcp-child" || !bindingMatches) {
      return {
        ok: false,
        status: 403,
        error: {
          code: "delegated_mcp_revoke_binding_mismatch",
          message: "Delegated MCP grant revocation binding does not match the grant owner."
        }
      };
    }
  }
  return current.store.revokeGrant(grantId, input.reason || "Delegated MCP child grant revoked.");
}
