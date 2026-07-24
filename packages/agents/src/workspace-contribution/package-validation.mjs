import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";

export const WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION = "v0.0.1:workspace:contribution-2";

export const CONTRIBUTION_TYPES = Object.freeze([
  "gatewayPolicy",
  "tool",
  "script",
  "file",
  "sourceCode",
  "codeChange"
]);

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

export function text(value) {
  return String(value ?? "").trim();
}

export function shallowObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function hash(value, length = 20) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

export function stableId(prefix, input) {
  return `${prefix}::${hash(JSON.stringify(input))}`;
}

export function nowIso() {
  return new Date().toISOString();
}


export function normalizeContributionType(value) {
  const normalized = text(value || "tool");
  if (!CONTRIBUTION_TYPES.includes(normalized)) {
    const error = new Error("Unsupported core contribution type.");
    error.code = "contribution_type_not_supported";
    throw error;
  }
  return normalized;
}

export function normalizeVisibility(value) {
  const normalized = text(value || "workspace");
  return ["private", "workspace", "public", "restricted"].includes(normalized) ? normalized : "workspace";
}

export function publicAssetRecord(record = {}) {
  return {
    assetId: text(record.assetId),
    contributionId: text(record.contributionId),
    workspaceId: text(record.workspaceId),
    sourceWorkspaceId: text(record.sourceWorkspaceId),
    contributionType: normalizeContributionType(record.contributionType),
    bucket: text(record.bucket),
    relation: text(record.relation || "canonical"),
    lifecycleState: text(record.lifecycleState || "submitted"),
    assetPath: text(record.assetPath),
    manifestHash: text(record.manifestHash),
    payloadRefs: asArray(record.payloadRefs).map(text).filter(Boolean),
    createdAt: text(record.createdAt),
    updatedAt: text(record.updatedAt)
  };
}

export function normalizeContribution(input = {}, defaults = {}) {
  const workspaceId = text(input.workspaceId || defaults.workspaceId || "default");
  const payloadRefs = asArray(input.payloadRefs).map(text).filter(Boolean);
  const requestedActions = asArray(input.requestedActions || input.actions || ["discover", "read"]).map(text).filter(Boolean);
  const license = text(input.license || "UNREVIEWED");
  const packageFingerprint = stableJson({
    payloadRefs,
    requestedActions,
    license
  });
  const contributionId = text(input.contributionId || stableId("contribution", {
    workspaceId,
    contributorId: input.contributorId,
    contributionType: input.contributionType,
    payloadRefs,
    title: input.title
  }));
  const contributionType = normalizeContributionType(input.contributionType);
  return {
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    contributionId,
    workspaceId,
    organizationId: text(input.organizationId || defaults.organizationId || ""),
    projectId: text(input.projectId || defaults.projectId || ""),
    dataClass: text(input.dataClass || defaults.dataClass || "internal"),
    retention: shallowObject(input.retention || defaults.retention),
    legalHold: shallowObject(input.legalHold || defaults.legalHold),
    externalCollaboratorIds: asArray(input.externalCollaboratorIds || input.externalCollaborators).map(text).filter(Boolean),
    copyPolicy: text(input.copyPolicy || "sameProject"),
    contributorId: text(input.contributorId || "anonymous"),
    contributorKind: text(input.contributorKind || "agent"),
    sourceAgentId: text(input.sourceAgentId || input.agentId || input.sourceAgent || input.contributorId || "anonymous"),
    sourceAgentKind: text(input.sourceAgentKind || input.agentKind || input.contributorKind || "agent"),
    sourceWorkspaceIds: asArray(input.sourceWorkspaceIds || workspaceId).map(text).filter(Boolean),
    targetWorkspaceIds: asArray(input.targetWorkspaceIds || workspaceId).map(text).filter(Boolean),
    contributionType,
    title: text(input.title || `${contributionType} contribution`),
    payloadRefs,
    packageSize: nonNegativeNumber(input.packageSize || input.size, Buffer.byteLength(packageFingerprint)),
    packageChecksum: text(input.packageChecksum || input.checksum || hash(packageFingerprint, 64)),
    declaredPermissions: asArray(input.declaredPermissions || input.permissions || requestedActions).map(text).filter(Boolean),
    toolSchemaRef: text(input.toolSchemaRef || ""),
    scriptRefs: asArray(input.scriptRefs).map(text).filter(Boolean),
    fileRefs: asArray(input.fileRefs).map(text).filter(Boolean),
    sourceCodeRefs: asArray(input.sourceCodeRefs).map(text).filter(Boolean),
    codeChangeRefs: asArray(input.codeChangeRefs).map(text).filter(Boolean),
    gatewayPolicyRefs: asArray(input.gatewayPolicyRefs).map(text).filter(Boolean),
    license,
    risk: text(input.risk || "medium"),
    requestedVisibility: normalizeVisibility(input.requestedVisibility),
    requestedActions,
    reviewPolicy: shallowObject(input.reviewPolicy),
    status: "submitted",
    statusHistory: [{
      state: "submitted",
      at: nowIso(),
      actorId: text(input.contributorId || "anonymous"),
      reason: text(input.reason || "initial_submission")
    }],
    metrics: {
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
    },
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
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

export function computeRankScore(metrics = {}) {
  const usageCount = Number(metrics.usageCount || 0);
  const executionCount = Number(metrics.executionCount || 0);
  const successRate = executionCount > 0 ? Number(metrics.successfulUseCount || 0) / executionCount : 0;
  return (
    usageCount +
    executionCount * successRate +
    Number(metrics.uniqueWorkspaceAdoptions || 0) +
    Number(metrics.downloadCount || 0) * 0.5 +
    Number(metrics.reviewCount || 0) +
    Number(metrics.permissionGrantCount || 0) -
    Number(metrics.rollbackCount || 0) -
    Number(metrics.revocationCount || 0)
  );
}

export function refreshMetrics(contribution, { assetRecordProjector = publicAssetRecord } = {}) {
  contribution.grants = asArray(contribution.grants);
  contribution.permissionRequests = asArray(contribution.permissionRequests);
  contribution.downloadEvents = asArray(contribution.downloadEvents);
  contribution.usageEvents = asArray(contribution.usageEvents);
  contribution.executionReceipts = asArray(contribution.executionReceipts);
  contribution.reviews = asArray(contribution.reviews);
  contribution.adoptions = asArray(contribution.adoptions);
  contribution.assetRecords = asArray(contribution.assetRecords).map(assetRecordProjector);
  const adoptionWorkspaces = new Set([
    ...contribution.usageEvents.map((event) => event.workspaceId).filter(Boolean),
    ...contribution.adoptions.map((event) => event.targetWorkspaceId).filter(Boolean),
    ...contribution.grants.map((event) => event.targetWorkspaceId).filter(Boolean)
  ]);
  contribution.metrics.usageCount = contribution.usageEvents.length;
  contribution.metrics.successfulUseCount = contribution.executionReceipts.filter((receipt) => receipt.status === "succeeded").length;
  contribution.metrics.uniqueWorkspaceAdoptions = adoptionWorkspaces.size;
  contribution.metrics.executionCount = contribution.executionReceipts.length;
  contribution.metrics.permissionRequestCount = contribution.permissionRequests.length;
  contribution.metrics.permissionGrantCount = contribution.grants.length;
  contribution.metrics.downloadCount = contribution.downloadEvents.length;
  contribution.metrics.reviewCount = contribution.reviews.length;
  contribution.metrics.revocationCount = asArray(contribution.statusHistory).filter((event) => event.state === "revoked").length;
  contribution.metrics.successRate =
    contribution.metrics.executionCount > 0
      ? contribution.metrics.successfulUseCount / contribution.metrics.executionCount
      : 0;
  contribution.metrics.rankScore = computeRankScore(contribution.metrics);
  return contribution;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export { stableJson };
