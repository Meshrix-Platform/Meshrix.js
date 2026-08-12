import {
  asArray,
  hash,
  normalizeVisibility,
  nowIso,
  shallowObject,
  stableId,
  stableJson,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION
} from "./skill-hub-contracts.mjs";

export const SKILL_HUB_CONTRIBUTION_TYPE = "skill";
export const SKILL_HUB_ASSET_BUCKET = "skills";
export const SKILL_HUB_ASSET_BUCKETS = Object.freeze([SKILL_HUB_ASSET_BUCKET]);

const PUBLIC_METRIC_FIELDS = Object.freeze([
  "acceptedCount",
  "usageCount",
  "successfulUseCount",
  "uniqueWorkspaceAdoptions",
  "executionCount",
  "permissionRequestCount",
  "permissionGrantCount",
  "downloadCount",
  "reviewCount",
  "revocationCount",
  "rollbackCount",
  "maintenanceFreshness",
  "successRate",
  "rankScore"
]);

function assertSkillContributionType(value) {
  const contributionType = text(value || SKILL_HUB_CONTRIBUTION_TYPE);
  if (contributionType !== SKILL_HUB_CONTRIBUTION_TYPE) {
    const error = new Error("Skill Hub accepts only skill contributions.");
    error.code = "contribution_type_not_supported";
    throw error;
  }
  return contributionType;
}

export function skillHubAssetBucketForType(contributionType) {
  assertSkillContributionType(contributionType);
  return SKILL_HUB_ASSET_BUCKET;
}

export function projectSkillHubAssetRecord(record = {}) {
  const contributionType = assertSkillContributionType(record.contributionType);
  const bucket = text(record.bucket || skillHubAssetBucketForType(contributionType));
  if (bucket !== SKILL_HUB_ASSET_BUCKET) {
    const error = new Error("Skill Hub asset records must use the skills bucket.");
    error.code = "skill_hub_asset_bucket_invalid";
    throw error;
  }
  return {
    assetId: text(record.assetId),
    contributionId: text(record.contributionId),
    workspaceId: text(record.workspaceId),
    sourceWorkspaceId: text(record.sourceWorkspaceId),
    contributionType,
    bucket,
    relation: text(record.relation || "canonical"),
    lifecycleState: text(record.lifecycleState || "submitted"),
    assetPath: text(record.assetPath),
    manifestHash: text(record.manifestHash),
    packageRoot: text(record.packageRoot),
    packageBundle: {
      path: text(record.packageBundle?.path),
      digest: text(record.packageBundle?.digest),
      size: Number(record.packageBundle?.size || 0),
      custodyRef: text(record.packageBundle?.custodyRef),
      envelopeDigest: text(record.packageBundle?.envelopeDigest)
    },
    packageCustodyRef: text(record.packageCustodyRef),
    packageContentDigest: text(record.packageContentDigest),
    packageEnvelopeDigest: text(record.packageEnvelopeDigest),
    custodyState: text(record.custodyState),
    executionState: text(record.executionState),
    payloadRefs: asArray(record.payloadRefs).map(text).filter(Boolean),
    createdAt: text(record.createdAt),
    updatedAt: text(record.updatedAt)
  };
}

export function projectPublicSkillHubContribution(record = {}) {
  assertSkillContributionType(record.contributionType);
  const metrics = {};
  for (const field of PUBLIC_METRIC_FIELDS) metrics[field] = Number(record.metrics?.[field] || 0);
  return {
    protocolVersion: text(record.protocolVersion),
    contributionId: text(record.contributionId),
    contributionType: SKILL_HUB_CONTRIBUTION_TYPE,
    title: text(record.title),
    status: text(record.status),
    packageSize: Number(record.packageSize || 0),
    packageChecksum: text(record.packageChecksum),
    declaredPermissions: asArray(record.declaredPermissions).map(text).filter(Boolean),
    skillManifestRef: text(record.skillManifestRef),
    skillPackageRef: text(record.skillPackageRef),
    runtimeKind: text(record.runtimeKind),
    entryPoint: text(record.entryPoint),
    license: text(record.license),
    risk: text(record.risk),
    requestedVisibility: text(record.requestedVisibility),
    requestedActions: asArray(record.requestedActions).map(text).filter(Boolean),
    metrics,
    createdAt: text(record.createdAt),
    updatedAt: text(record.updatedAt)
  };
}

function emptySkillHubMetrics() {
  return {
    acceptedCount: 0,
    usageCount: 0,
    successfulUseCount: 0,
    uniqueWorkspaceAdoptions: 0,
    executionCount: 0,
    permissionRequestCount: 0,
    permissionGrantCount: 0,
    downloadCount: 0,
    reviewCount: 0,
    revocationCount: 0,
    rollbackCount: 0,
    maintenanceFreshness: 1,
    successRate: 0,
    rankScore: 0
  };
}

export function normalizeSkillHubContribution(input = {}, defaults = {}) {
  const contributionType = assertSkillContributionType(input.contributionType);
  const workspaceId = text(input.workspaceId || defaults.workspaceId || "default");
  const payloadRefs = asArray(input.payloadRefs).map(text).filter(Boolean);
  const requestedActions = asArray(input.requestedActions || input.actions || ["discover", "read"])
    .map(text)
    .filter(Boolean);
  const skillManifestRef = text(input.skillManifestRef || input.manifestRef);
  const skillPackageRef = text(input.skillPackageRef || input.packageRef);
  const runtimeKind = text(input.runtimeKind);
  const entryPoint = text(input.entryPoint);
  const packageBundle = {
    path: text(input.packageBundle?.path),
    digest: text(input.packageBundle?.digest),
    size: Number(input.packageBundle?.size || 0),
    custodyRef: text(input.packageBundle?.custodyRef),
    envelopeDigest: text(input.packageBundle?.envelopeDigest)
  };
  const license = text(input.license || "UNREVIEWED");
  const packageCustodyRef = text(input.packageCustodyRef);
  const packageContentDigest = text(input.packageContentDigest);
  const packageEnvelopeDigest = text(input.packageEnvelopeDigest);
  const packageFingerprint = stableJson({
    license,
    payloadRefs,
    requestedActions,
    skillManifestRef,
    skillPackageRef,
    runtimeKind,
    entryPoint
  });
  const contributionId = text(input.contributionId || stableId("skill_contribution", {
    workspaceId,
    contributorId: input.contributorId,
    payloadRefs,
    skillManifestRef,
    title: input.title
  }));
  const contributorId = text(input.contributorId || "anonymous");
  const timestamp = nowIso();
  return {
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    contributionId,
    workspaceId,
    organizationId: text(input.organizationId || defaults.organizationId || ""),
    projectId: text(input.projectId || defaults.projectId || ""),
    dataClass: text(input.dataClass || defaults.dataClass || "internal"),
    retention: shallowObject(input.retention || defaults.retention),
    legalHold: shallowObject(input.legalHold || defaults.legalHold),
    externalCollaboratorIds: asArray(input.externalCollaboratorIds || input.externalCollaborators)
      .map(text)
      .filter(Boolean),
    copyPolicy: text(input.copyPolicy || "sameProject"),
    contributorId,
    contributorKind: text(input.contributorKind || "agent"),
    sourceAgentId: text(input.sourceAgentId || input.agentId || input.sourceAgent || contributorId),
    sourceAgentKind: text(input.sourceAgentKind || input.agentKind || input.contributorKind || "agent"),
    sourceWorkspaceIds: asArray(input.sourceWorkspaceIds || workspaceId).map(text).filter(Boolean),
    targetWorkspaceIds: asArray(input.targetWorkspaceIds || workspaceId).map(text).filter(Boolean),
    contributionType,
    title: text(input.title || "skill contribution"),
    payloadRefs,
    packageSize: Number(input.packageSize || Buffer.byteLength(packageFingerprint)),
    packageChecksum: text(input.packageChecksum || hash(packageFingerprint, 64)),
    packageBundle,
    packageCustodyRef,
    packageContentDigest,
    packageEnvelopeDigest,
    custodyState: text(input.custodyState || (packageCustodyRef ? "blocked" : "")),
    executionState: text(input.executionState || (packageCustodyRef ? "blocked" : "")),
    declaredPermissions: asArray(input.declaredPermissions || input.permissions || requestedActions)
      .map(text)
      .filter(Boolean),
    skillManifestRef,
    skillPackageRef,
    runtimeKind,
    entryPoint,
    license,
    risk: text(input.risk || "medium"),
    requestedVisibility: normalizeVisibility(input.requestedVisibility),
    requestedActions,
    reviewPolicy: shallowObject(input.reviewPolicy),
    status: "submitted",
    statusHistory: [{
      state: "submitted",
      at: timestamp,
      actorId: contributorId,
      reason: text(input.reason || "initial_submission")
    }],
    metrics: emptySkillHubMetrics(),
    grants: [],
    permissionRequests: [],
    downloadEvents: [],
    usageEvents: [],
    executionReceipts: [],
    reviews: [],
    adoptions: [],
    assetRecords: [],
    currentAssetRef: null,
    auditIds: [stableId("audit", { contributionId, event: "contribution.submitted" })],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
