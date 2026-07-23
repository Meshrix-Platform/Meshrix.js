import { createHash } from "node:crypto";
import { evaluateUniversalTagPolicy, hasUniversalTagPolicyRules } from "@lico/foundation/security/authorization/universal-tag-policy";

export const AUDIENCE_PUBLICATION_SCHEMA_VERSION = "v0.0.1:upstream-gateway:audience-publication-1";
export const AUDIENCE_PUBLICATION_TOPIC = "upstream.audiences_published";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function text(value) {
  return String(value || "").trim();
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function freezeEntries(map = new Map()) {
  return Object.freeze([...map.entries()].map(([key, value]) => Object.freeze([key, Object.freeze(value)])));
}

function operationAudienceFingerprint(operation = {}) {
  return digest(JSON.stringify({
    id: text(operation.id),
    toolId: text(operation.toolId),
    requiredScopes: uniqueStrings(operation.requiredScopes || operation._meta?.dynamicCapability?.requiredScopes || []).sort(),
    toolsets: uniqueStrings(operation.toolsets || operation._meta?.dynamicCapability?.toolsets || []).sort(),
    risk: text(operation.safety?.risk || operation._meta?.dynamicCapability?.risk || operation._meta?.risk),
    dynamicCapability: plainObject(operation._meta?.dynamicCapability || operation.dynamicCapability),
    inputSchema: plainObject(operation.inputSchema)
  }));
}

/**
 * Opaque partition key for downstream invalidation. Never embeds raw subjects or tags.
 */
export function opaqueAudiencePartitionKey({
  grantId = "",
  serverIdentity = "lico",
  audienceDigest = ""
} = {}) {
  const grant = text(grantId);
  if (!grant) {
    throw new TypeError("Audience partition key requires an opaque grant id.");
  }
  return digest(`${text(serverIdentity)}\0${grant}\0${text(audienceDigest)}`);
}

function grantEntityRefs(grant = {}) {
  const metadata = plainObject(grant.metadata);
  const explicit = Array.isArray(grant.entityRefs)
    ? grant.entityRefs
    : Array.isArray(metadata.entityRefs)
      ? metadata.entityRefs
      : [];
  if (explicit.length > 0) {
    return explicit.map((entry) => ({
      entityType: text(entry?.entityType || entry?.type),
      entityId: text(entry?.entityId || entry?.id)
    })).filter((entry) => entry.entityType && entry.entityId);
  }
  const refs = [];
  const subjectId = text(grant.subjectId || metadata.subjectId);
  if (subjectId) refs.push({ entityType: "subject", entityId: subjectId });
  const organizationId = text(grant.organizationId || metadata.organizationId);
  if (organizationId) refs.push({ entityType: "organization", entityId: organizationId });
  const teamId = text(grant.teamId || metadata.teamId);
  if (teamId) refs.push({ entityType: "team", entityId: teamId });
  const roleId = text(grant.roleId || metadata.roleId);
  if (roleId) refs.push({ entityType: "role", entityId: roleId });
  return refs;
}

function grantScopeSet(grant = {}) {
  return new Set(uniqueStrings(grant.scopes || grant.requiredScopes || []));
}

function grantToolsetSet(grant = {}) {
  return new Set(uniqueStrings(grant.toolsets || []));
}

function grantCapabilitySet(grant = {}) {
  const metadata = plainObject(grant.metadata);
  return new Set(uniqueStrings([
    ...(Array.isArray(grant.dynamicCapabilities) ? grant.dynamicCapabilities : []),
    ...(Array.isArray(grant.upstreamCapabilities) ? grant.upstreamCapabilities : []),
    ...(Array.isArray(metadata.dynamicCapabilities) ? metadata.dynamicCapabilities : []),
    ...(Array.isArray(metadata.upstreamCapabilities) ? metadata.upstreamCapabilities : [])
  ]));
}

function grantAllowedServiceIds(grant = {}) {
  const metadata = plainObject(grant.metadata);
  const values = [
    ...(Array.isArray(grant.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(metadata.allowedServiceIds) ? metadata.allowedServiceIds : [])
  ];
  return new Set(uniqueStrings(values));
}

function grantAllowedSecretBindings(grant = {}) {
  const metadata = plainObject(grant.metadata);
  return new Set(uniqueStrings([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(metadata.allowedSecretBindings) ? metadata.allowedSecretBindings : [])
  ]));
}

function riskRank(risk = "read_only") {
  const ranks = { read_only: 0, safe_write: 1, repair_write: 2, destructive: 3 };
  return ranks[text(risk)] ?? 0;
}

function grantMaxRisk(grant = {}) {
  const metadata = plainObject(grant.metadata);
  const explicit = text(grant.maxRisk || grant.max_risk || metadata.maxRisk || metadata.max_risk);
  if (explicit) return explicit;
  return grantScopeSet(grant).has("gateway:write") ? "safe_write" : "read_only";
}

/**
 * Pure fail-closed audience decision shared by discovery and execution.
 * Deny tags take precedence. Stale tag policy fails closed when required.
 */
export function evaluateAudienceDecision({
  grant = null,
  operation = null,
  service = null,
  tagStore = null,
  purpose = "discovery"
} = {}) {
  const mode = purpose === "execution" ? "execution" : "discovery";
  if (!grant || grant.revoked === true || grant.status === "revoked") {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_grant_unavailable",
      purpose: mode,
      visibleMetadata: false
    });
  }
  if (!operation || !service) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_operation_unavailable",
      purpose: mode,
      visibleMetadata: false
    });
  }
  if (service.disabled === true) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_service_disabled",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const serviceId = text(service.serviceId || operation._meta?.serviceId);
  const allowedServices = grantAllowedServiceIds(grant);
  if (allowedServices.size > 0 && serviceId && !allowedServices.has(serviceId)) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_service_not_granted",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const capability = plainObject(operation._meta?.dynamicCapability || operation.dynamicCapability);
  const capabilityId = text(capability.capabilityId || operation._meta?.capabilityId);
  const capabilities = grantCapabilitySet(grant);
  if (capabilityId && (capabilities.size === 0 || !capabilities.has(capabilityId))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_capability_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const requiredScopes = uniqueStrings(operation.requiredScopes || capability.requiredScopes || []);
  const scopes = grantScopeSet(grant);
  if (requiredScopes.some((scope) => !scopes.has(scope))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_scope_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const toolsets = uniqueStrings(operation.toolsets || capability.toolsets || []);
  const grantToolsets = grantToolsetSet(grant);
  if (grantToolsets.size > 0 && toolsets.length > 0 && !toolsets.some((toolset) => grantToolsets.has(toolset))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_toolset_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const risk = text(capability.risk || operation.safety?.risk || operation._meta?.risk || "read_only");
  if (riskRank(risk) > riskRank(grantMaxRisk(grant))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_risk_exceeded",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const credentialBindingIds = uniqueStrings(capability.credentialBindingIds || []);
  const allowedBindings = grantAllowedSecretBindings(grant);
  if (credentialBindingIds.some((bindingId) =>
    !allowedBindings.has(bindingId) &&
    !(capabilityId && capabilities.has(`${capabilityId}:${bindingId}`))
  )) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_credential_binding_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const tagPolicy = plainObject(service.tagPolicy);
  if (hasUniversalTagPolicyRules(tagPolicy)) {
    const entityRefs = grantEntityRefs(grant);
    if (entityRefs.length === 0 && uniqueStrings(tagPolicy.entityRefs || tagPolicy.entities).length === 0) {
      return Object.freeze({
        allowed: false,
        reasonCode: "audience_entity_refs_required",
        purpose: mode,
        visibleMetadata: false
      });
    }
    const decision = evaluateUniversalTagPolicy({
      tagStore,
      entityRefs: entityRefs.length > 0 ? entityRefs : tagPolicy.entityRefs,
      denyTags: tagPolicy.denyTags,
      allowTags: tagPolicy.allowTags,
      requiredTags: tagPolicy.requiredTags,
      policyRevision: tagPolicy.policyRevision,
      failOnStale: tagPolicy.failOnStale === true || tagPolicy.requireFreshRevision === true,
      requireFreshRevision: tagPolicy.requireFreshRevision === true
    });
    if (decision.allowed !== true) {
      return Object.freeze({
        allowed: false,
        reasonCode: text(decision.reasonCode || "audience_tag_policy_denied"),
        purpose: mode,
        visibleMetadata: false,
        stale: decision.stale === true
      });
    }
  }

  return Object.freeze({
    allowed: true,
    reasonCode: "audience_allowed",
    purpose: mode,
    visibleMetadata: true,
    operationId: text(operation.id),
    toolId: text(operation.toolId),
    capabilityId
  });
}

/**
 * Discovery and execution must share one decision object for the same grant/operation.
 */
export function evaluateAudienceParity({
  grant = null,
  operation = null,
  service = null,
  tagStore = null
} = {}) {
  const discovery = evaluateAudienceDecision({ grant, operation, service, tagStore, purpose: "discovery" });
  const execution = evaluateAudienceDecision({ grant, operation, service, tagStore, purpose: "execution" });
  return Object.freeze({
    identical: discovery.allowed === execution.allowed && discovery.reasonCode === execution.reasonCode,
    discovery,
    execution
  });
}

function partitionAudienceDigest({ grantId, visibleOperationIds = [] }) {
  return digest(JSON.stringify({
    grantId: text(grantId),
    operations: [...visibleOperationIds].sort()
  }));
}

function serviceByIdFromSnapshot(snapshot = {}) {
  const map = new Map();
  for (const [serviceId, service] of snapshot.serviceEntries || []) {
    map.set(serviceId, service);
  }
  return map;
}

/**
 * Compile a revisioned audience projection with reverse indexes from policy facts
 * to opaque partition keys. Events carry only opaque keys and revisions.
 */
export function compileAudienceProjection({
  sourceRevision = 0,
  sourceDigest = "",
  catalogFingerprint = "",
  catalogRevision = "",
  snapshot = null,
  projectedOperations = [],
  grants = [],
  tagStore = null,
  previousProjection = null,
  policyRevision = 0,
  tagRevision = 0,
  serverIdentity = "lico"
} = {}) {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new TypeError("Audience projection requires a monotonic source revision.");
  }
  const services = serviceByIdFromSnapshot(snapshot || { serviceEntries: [] });
  const activeGrants = (Array.isArray(grants) ? grants : [])
    .filter((grant) => grant && grant.revoked !== true && grant.status !== "revoked");
  const partitions = new Map();
  const policyToPartitions = new Map();
  const operationToPartitions = new Map();
  const operationFingerprints = new Map(
    projectedOperations.map((operation) => [text(operation.id), operationAudienceFingerprint(operation)])
  );

  for (const grant of activeGrants) {
    const grantId = text(grant.id || grant.grantId);
    if (!grantId) continue;
    const visibleOperationIds = [];
    for (const operation of projectedOperations) {
      const serviceId = text(operation._meta?.serviceId);
      const service = services.get(serviceId) || {
        serviceId,
        disabled: false,
        tagPolicy: operation._meta?.tagPolicy || {}
      };
      const decision = evaluateAudienceDecision({
        grant,
        operation,
        service,
        tagStore,
        purpose: "discovery"
      });
      const execution = evaluateAudienceDecision({
        grant,
        operation,
        service,
        tagStore,
        purpose: "execution"
      });
      if (decision.allowed !== execution.allowed || decision.reasonCode !== execution.reasonCode) {
        throw new Error("Audience discovery and execution decisions diverged.");
      }
      if (decision.allowed === true) {
        visibleOperationIds.push(operation.id);
      }
    }
    visibleOperationIds.sort();
    const audienceDigest = partitionAudienceDigest({ grantId, visibleOperationIds });
    const partitionKey = opaqueAudiencePartitionKey({
      grantId,
      serverIdentity,
      audienceDigest
    });
    const partition = Object.freeze({
      partitionKey,
      grantIdDigest: digest(grantId),
      audienceDigest,
      visibleOperationIds: Object.freeze([...visibleOperationIds]),
      visibleOperationCount: visibleOperationIds.length
    });
    partitions.set(partitionKey, partition);

    const policyKey = digest(JSON.stringify({
      policyRevision: Number(policyRevision) || 0,
      tagRevision: Number(tagRevision) || 0,
      grantDigest: digest(grantId)
    }));
    const existing = policyToPartitions.get(policyKey) || [];
    existing.push(partitionKey);
    policyToPartitions.set(policyKey, existing);

    for (const operationId of visibleOperationIds) {
      const bucket = operationToPartitions.get(operationId) || [];
      bucket.push(partitionKey);
      operationToPartitions.set(operationId, bucket);
    }
  }

  const partitionSnapshot = Object.freeze(
    [...partitions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => Object.freeze([key, value]))
  );
  const projectionDigest = digest(JSON.stringify({
    sourceRevision,
    sourceDigest,
    catalogFingerprint,
    catalogRevision,
    policyRevision,
    tagRevision,
    partitions: partitionSnapshot.map(([key, value]) => [key, value.audienceDigest, value.visibleOperationIds])
  }));

  const previousRevision = Number.isSafeInteger(previousProjection?.audienceRevision)
    ? previousProjection.audienceRevision
    : 0;
  const previousDigest = text(previousProjection?.projectionDigest);
  const unchanged = previousDigest === projectionDigest && previousRevision > 0;
  const audienceRevision = unchanged ? previousRevision : previousRevision + 1;

  const previousKeys = new Set(
    (previousProjection?.partitionSnapshot || []).map(([key]) => key)
  );
  const nextKeys = new Set(partitionSnapshot.map(([key]) => key));
  const changedOperationIds = new Set([
    ...[...operationFingerprints.entries()]
      .filter(([operationId, fingerprint]) => previousProjection?.operationFingerprints?.get?.(operationId) !== fingerprint)
      .map(([operationId]) => operationId),
    ...[...(previousProjection?.operationFingerprints?.keys?.() || [])]
      .filter((operationId) => !operationFingerprints.has(operationId))
  ]);
  const changedOperationPartitions = new Set();
  for (const operationId of changedOperationIds) {
    for (const key of operationToPartitions.get(operationId) || []) changedOperationPartitions.add(key);
    for (const key of previousProjection?.operationToPartitions?.get?.(operationId) || []) changedOperationPartitions.add(key);
  }
  const affectedPartitions = Object.freeze([
    ...new Set([
      ...[...nextKeys].filter((key) => !previousKeys.has(key)),
      ...[...previousKeys].filter((key) => !nextKeys.has(key)),
      ...changedOperationPartitions,
      ...partitionSnapshot
        .filter(([key, value]) => {
          const prior = previousProjection?.partitions?.get?.(key);
          return prior && prior.audienceDigest !== value.audienceDigest;
        })
        .map(([key]) => key)
    ])
  ].sort());

  return Object.freeze({
    ready: true,
    sourceRevision,
    sourceDigest: text(sourceDigest),
    catalogFingerprint: text(catalogFingerprint),
    catalogRevision: text(catalogRevision || catalogFingerprint),
    audienceRevision,
    projectionDigest,
    policyRevision: Number(policyRevision) || 0,
    tagRevision: Number(tagRevision) || 0,
    partitionCount: partitionSnapshot.length,
    affectedPartitions,
    partitions: Object.freeze(new Map(partitionSnapshot)),
    partitionSnapshot,
    policyToPartitions: Object.freeze(new Map(
      [...policyToPartitions.entries()].map(([key, values]) => [key, Object.freeze([...new Set(values)].sort())])
    )),
    operationToPartitions: Object.freeze(new Map(
      [...operationToPartitions.entries()].map(([key, values]) => [key, Object.freeze([...new Set(values)].sort())])
    )),
    operationFingerprints: Object.freeze(new Map(operationFingerprints)),
    replayed: unchanged === true
  });
}

export function createAudiencePublicationEvent(projection = {}, { now = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    schemaVersion: AUDIENCE_PUBLICATION_SCHEMA_VERSION,
    source: "upstream-gateway",
    type: AUDIENCE_PUBLICATION_TOPIC,
    reasonCode: "upstream_audiences_published",
    sourceRevision: projection.sourceRevision,
    sourceDigest: projection.sourceDigest,
    catalogRevision: projection.catalogRevision,
    catalogFingerprint: projection.catalogFingerprint,
    audienceRevision: projection.audienceRevision,
    projectionDigest: projection.projectionDigest,
    affectedPartitions: Object.freeze([...(projection.affectedPartitions || [])]),
    at: now()
  });
}
