import { createHash } from "node:crypto";
import { evaluateUniversalTagPolicy, hasUniversalTagPolicyRules } from "@meshrix/foundation/security/authorization/universal-tag-policy";

export const AUDIENCE_PUBLICATION_SCHEMA_VERSION: any = "v0.0.1:upstream-gateway:audience-publication-1";
export const AUDIENCE_PUBLICATION_TOPIC: any = "upstream.audiences_published";

function digest(value?: any) : any {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function text(value?: any) : any {
  return String(value || "").trim();
}

function uniqueStrings(values: any = []) : any {
  return [...new Set<any>((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
}

function plainObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function freezeEntries(map: any = new Map<any, any>()) : any {
  return Object.freeze([...map.entries()].map(([key, value]: any[]) : any => Object.freeze([key, Object.freeze(value)])));
}

function operationAudienceFingerprint(operation: Record<string, any> = {}) : any {
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
  serverIdentity = "meshrix",
  audienceDigest = ""
}: Record<string, any> = {}) : any {
  const grant: any = text(grantId);
  if (!grant) {
    throw new TypeError("Audience partition key requires an opaque grant id.");
  }
  return digest(`${text(serverIdentity)}\0${grant}\0${text(audienceDigest)}`);
}

function grantEntityRefs(grant: Record<string, any> = {}, subject: Record<string, any> = {}) : any {
  const metadata: any = plainObject(grant.metadata);
  const explicit: any = Array.isArray(grant.entityRefs)
    ? grant.entityRefs
    : Array.isArray(metadata.entityRefs)
      ? metadata.entityRefs
      : [];
  if (explicit.length > 0) {
    return explicit.map((entry?: any) : any => ({
      entityType: text(entry?.entityType || entry?.type),
      entityId: text(entry?.entityId || entry?.id)
    })).filter((entry?: any) : any => entry.entityType && entry.entityId);
  }
  const refs: any[] = [];
  const subjectId: any = text(subject.subjectId || grant.subjectId || metadata.subjectId);
  if (subjectId) refs.push({ entityType: "subject", entityId: subjectId });
  const organizationId: any = text(
    subject.organizationNodeId || subject.organizationId || grant.organizationId || metadata.organizationId
  );
  if (organizationId) refs.push({ entityType: "organization", entityId: organizationId });
  const teamId: any = text(grant.teamId || metadata.teamId);
  if (teamId) refs.push({ entityType: "team", entityId: teamId });
  const roleId: any = text(grant.roleId || metadata.roleId);
  if (roleId) refs.push({ entityType: "role", entityId: roleId });
  return refs;
}

function grantScopeSet(grant: Record<string, any> = {}) : any {
  return new Set<any>(uniqueStrings(grant.scopes || grant.requiredScopes || []));
}

function grantToolsetSet(grant: Record<string, any> = {}) : any {
  return new Set<any>(uniqueStrings(grant.toolsets || []));
}

function grantCapabilitySet(grant: Record<string, any> = {}) : any {
  const metadata: any = plainObject(grant.metadata);
  return new Set<any>(uniqueStrings([
    ...(Array.isArray(grant.dynamicCapabilities) ? grant.dynamicCapabilities : []),
    ...(Array.isArray(grant.upstreamCapabilities) ? grant.upstreamCapabilities : []),
    ...(Array.isArray(metadata.dynamicCapabilities) ? metadata.dynamicCapabilities : []),
    ...(Array.isArray(metadata.upstreamCapabilities) ? metadata.upstreamCapabilities : [])
  ]));
}

function grantAllowedServiceIds(grant: Record<string, any> = {}) : any {
  const metadata: any = plainObject(grant.metadata);
  const values: any[] = [
    ...(Array.isArray(grant.allowedServiceIds) ? grant.allowedServiceIds : []),
    ...(Array.isArray(metadata.allowedServiceIds) ? metadata.allowedServiceIds : [])
  ];
  return new Set<any>(uniqueStrings(values));
}

function grantAllowedSecretBindings(grant: Record<string, any> = {}) : any {
  const metadata: any = plainObject(grant.metadata);
  return new Set<any>(uniqueStrings([
    ...(Array.isArray(grant.allowedSecretBindings) ? grant.allowedSecretBindings : []),
    ...(Array.isArray(metadata.allowedSecretBindings) ? metadata.allowedSecretBindings : [])
  ]));
}

function riskRank(risk: any = "read_only") : any {
  const ranks: Record<string, any> = { read_only: 0, safe_write: 1, repair_write: 2, destructive: 3 };
  return ranks[text(risk)] ?? 0;
}

function grantMaxRisk(grant: Record<string, any> = {}) : any {
  const metadata: any = plainObject(grant.metadata);
  const explicit: any = text(grant.maxRisk || grant.max_risk || metadata.maxRisk || metadata.max_risk);
  if (explicit) return explicit;
  return grantScopeSet(grant).has("gateway:write") ? "safe_write" : "read_only";
}

/**
 * Pure fail-closed audience decision shared by discovery and execution.
 * Deny tags take precedence. Stale tag policy fails closed when required.
 */
export function evaluateAudienceDecision({
  grant = null,
  restriction = null,
  subject = null,
  operation = null,
  service = null,
  tagStore = null,
  purpose = "discovery"
}: Record<string, any> = {}) : any {
  const mode: any = purpose === "execution" ? "execution" : "discovery";
  const authorizationPolicy: any = grant || restriction;
  if (!authorizationPolicy || authorizationPolicy.revoked === true || authorizationPolicy.status === "revoked") {
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

  const serviceId: any = text(service.serviceId || operation._meta?.serviceId);
  const allowedServices: any = grantAllowedServiceIds(authorizationPolicy);
  if (allowedServices.size > 0 && serviceId && !allowedServices.has(serviceId)) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_service_not_granted",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const capability: any = plainObject(operation._meta?.dynamicCapability || operation.dynamicCapability);
  const capabilityId: any = text(capability.capabilityId || operation._meta?.capabilityId);
  const capabilities: any = grantCapabilitySet(authorizationPolicy);
  if (capabilityId && (capabilities.size === 0 || !capabilities.has(capabilityId))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_capability_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const requiredScopes: any = uniqueStrings(operation.requiredScopes || capability.requiredScopes || []);
  const scopes: any = grantScopeSet(authorizationPolicy);
  if (requiredScopes.some((scope?: any) : any => !scopes.has(scope))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_scope_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const toolsets: any = uniqueStrings(operation.toolsets || capability.toolsets || []);
  const grantToolsets: any = grantToolsetSet(authorizationPolicy);
  if (grantToolsets.size > 0 && toolsets.length > 0 && !toolsets.some((toolset?: any) : any => grantToolsets.has(toolset))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_toolset_missing",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const risk: any = text(capability.risk || operation.safety?.risk || operation._meta?.risk || "read_only");
  if (riskRank(risk) > riskRank(grantMaxRisk(authorizationPolicy))) {
    return Object.freeze({
      allowed: false,
      reasonCode: "audience_risk_exceeded",
      purpose: mode,
      visibleMetadata: false
    });
  }

  const credentialBindingIds: any = uniqueStrings(capability.credentialBindingIds || []);
  const allowedBindings: any = grantAllowedSecretBindings(authorizationPolicy);
  if (credentialBindingIds.some((bindingId?: any) : any =>
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

  const tagPolicy: any = plainObject(service.tagPolicy);
  if (hasUniversalTagPolicyRules(tagPolicy)) {
    const entityRefs: any = grantEntityRefs(authorizationPolicy, subject || {});
    if (entityRefs.length === 0 && uniqueStrings(tagPolicy.entityRefs || tagPolicy.entities).length === 0) {
      return Object.freeze({
        allowed: false,
        reasonCode: "audience_entity_refs_required",
        purpose: mode,
        visibleMetadata: false
      });
    }
    const decision: any = evaluateUniversalTagPolicy({
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
  restriction = null,
  subject = null,
  operation = null,
  service = null,
  tagStore = null
}: Record<string, any> = {}) : any {
  const discovery: any = evaluateAudienceDecision({ grant, restriction, subject, operation, service, tagStore, purpose: "discovery" });
  const execution: any = evaluateAudienceDecision({ grant, restriction, subject, operation, service, tagStore, purpose: "execution" });
  return Object.freeze({
    identical: discovery.allowed === execution.allowed && discovery.reasonCode === execution.reasonCode,
    discovery,
    execution
  });
}

function partitionAudienceDigest({ grantId, visibleOperationIds = [] }: Record<string, any>) : any {
  return digest(JSON.stringify({
    grantId: text(grantId),
    operations: [...visibleOperationIds].sort()
  }));
}

function serviceByIdFromSnapshot(snapshot: Record<string, any> = {}) : any {
  const map: any = new Map<any, any>();
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
  serverIdentity = "meshrix"
}: Record<string, any> = {}) : any {
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    throw new TypeError("Audience projection requires a monotonic source revision.");
  }
  const services: any = serviceByIdFromSnapshot(snapshot || { serviceEntries: [] });
  const activeGrants: any = (Array.isArray(grants) ? grants : [])
    .filter((grant?: any) : any => grant && grant.revoked !== true && grant.status !== "revoked");
  const partitions: any = new Map<any, any>();
  const policyToPartitions: any = new Map<any, any>();
  const operationToPartitions: any = new Map<any, any>();
  const operationFingerprints: any = new Map<any, any>(
    projectedOperations.map((operation?: any) : any => [text(operation.id), operationAudienceFingerprint(operation)])
  );

  for (const grant of activeGrants) {
    const grantId: any = text(grant.id || grant.grantId);
    if (!grantId) continue;
    const visibleOperationIds: any[] = [];
    for (const operation of projectedOperations) {
      const serviceId: any = text(operation._meta?.serviceId);
      const service: any = services.get(serviceId) || {
        serviceId,
        disabled: false,
        tagPolicy: operation._meta?.tagPolicy || {}
      };
      const decision: any = evaluateAudienceDecision({
        grant,
        operation,
        service,
        tagStore,
        purpose: "discovery"
      });
      const execution: any = evaluateAudienceDecision({
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
    const audienceDigest: any = partitionAudienceDigest({ grantId, visibleOperationIds });
    const partitionKey: any = opaqueAudiencePartitionKey({
      grantId,
      serverIdentity,
      audienceDigest
    });
    const partition: Readonly<Record<string, any>> = Object.freeze({
      partitionKey,
      grantIdDigest: digest(grantId),
      audienceDigest,
      visibleOperationIds: Object.freeze([...visibleOperationIds]),
      visibleOperationCount: visibleOperationIds.length
    });
    partitions.set(partitionKey, partition);

    const policyKey: any = digest(JSON.stringify({
      policyRevision: Number(policyRevision) || 0,
      tagRevision: Number(tagRevision) || 0,
      grantDigest: digest(grantId)
    }));
    const existing: any = policyToPartitions.get(policyKey) || [];
    existing.push(partitionKey);
    policyToPartitions.set(policyKey, existing);

    for (const operationId of visibleOperationIds) {
      const bucket: any = operationToPartitions.get(operationId) || [];
      bucket.push(partitionKey);
      operationToPartitions.set(operationId, bucket);
    }
  }

  const partitionSnapshot: any = Object.freeze(
    [...partitions.entries()]
      .sort(([left]: any[], [right]: any[]) : any => left.localeCompare(right))
      .map(([key, value]: any[]) : any => Object.freeze([key, value]))
  );
  const projectionDigest: any = digest(JSON.stringify({
    sourceRevision,
    sourceDigest,
    catalogFingerprint,
    catalogRevision,
    policyRevision,
    tagRevision,
    partitions: partitionSnapshot.map(([key, value]: any[]) : any => [key, value.audienceDigest, value.visibleOperationIds])
  }));

  const previousRevision: any = Number.isSafeInteger(previousProjection?.audienceRevision)
    ? previousProjection.audienceRevision
    : 0;
  const previousDigest: any = text(previousProjection?.projectionDigest);
  const unchanged: any = previousDigest === projectionDigest && previousRevision > 0;
  const audienceRevision: any = unchanged ? previousRevision : previousRevision + 1;

  const previousKeys: any = new Set<any>(
    (previousProjection?.partitionSnapshot || []).map(([key]: any[]) : any => key)
  );
  const nextKeys: any = new Set<any>(partitionSnapshot.map(([key]: any[]) : any => key));
  const changedOperationIds: any = new Set<any>([
    ...[...operationFingerprints.entries()]
      .filter(([operationId, fingerprint]: any[]) : any => previousProjection?.operationFingerprints?.get?.(operationId) !== fingerprint)
      .map(([operationId]: any[]) : any => operationId),
    ...[...(previousProjection?.operationFingerprints?.keys?.() || [])]
      .filter((operationId?: any) : any => !operationFingerprints.has(operationId))
  ]);
  const changedOperationPartitions: any = new Set<any>();
  for (const operationId of changedOperationIds) {
    for (const key of operationToPartitions.get(operationId) || []) changedOperationPartitions.add(key);
    for (const key of previousProjection?.operationToPartitions?.get?.(operationId) || []) changedOperationPartitions.add(key);
  }
  const affectedPartitions: any = Object.freeze([
    ...new Set<any>([
      ...[...nextKeys].filter((key?: any) : any => !previousKeys.has(key)),
      ...[...previousKeys].filter((key?: any) : any => !nextKeys.has(key)),
      ...changedOperationPartitions,
      ...partitionSnapshot
        .filter(([key, value]: any[]) : any => {
          const prior: any = previousProjection?.partitions?.get?.(key);
          return prior && prior.audienceDigest !== value.audienceDigest;
        })
        .map(([key]: any[]) : any => key)
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
    partitions: Object.freeze(new Map<any, any>(partitionSnapshot)),
    partitionSnapshot,
    policyToPartitions: Object.freeze(new Map<any, any>(
      [...policyToPartitions.entries()].map(([key, values]: any[]) : any => [key, Object.freeze([...new Set<any>(values)].sort())])
    )),
    operationToPartitions: Object.freeze(new Map<any, any>(
      [...operationToPartitions.entries()].map(([key, values]: any[]) : any => [key, Object.freeze([...new Set<any>(values)].sort())])
    )),
    operationFingerprints: Object.freeze(new Map<any, any>(operationFingerprints)),
    replayed: unchanged === true
  });
}

export function createAudiencePublicationEvent(projection: Record<string, any> = {}, { now = () : any => new Date().toISOString() }: Record<string, any> = {}) : any {
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
