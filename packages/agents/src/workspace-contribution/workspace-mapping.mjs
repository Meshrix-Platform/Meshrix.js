import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import {
  asArray,
  hash,
  normalizeContributionType,
  nowIso,
  publicAssetRecord,
  stableId,
  stableJson,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION
} from "./package-validation.mjs";
import {
  chmodSyncBestEffort,
  dataRoot,
  PRIVATE_DIRECTORY_MODE,
  storageRoot,
  writeJsonSyncAtomic
} from "./storage-helpers.mjs";

export const ASSET_BUCKET_BY_TYPE = Object.freeze({
  gatewayPolicy: "gateway-policies",
  tool: "tools",
  script: "scripts",
  file: "files",
  sourceCode: "files",
  codeChange: "files"
});

export const FIXED_WORKSPACE_ASSET_BUCKETS = Object.freeze([
  "gateway-policies",
  "tools",
  "scripts",
  "files"
]);

export function safePathSegment(value) {
  return String(value || "asset")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "asset";
}

export function assetBucketForType(contributionType) {
  return ASSET_BUCKET_BY_TYPE[normalizeContributionType(contributionType)];
}

export function workspaceAssetRelativePath({
  workspaceId,
  contributionType,
  contributionId,
  relation = "canonical",
  assetBucketResolver = assetBucketForType
} = {}) {
  const bucket = String(assetBucketResolver(contributionType) || "").trim();
  if (!bucket) {
    throw new Error("Contribution asset bucket resolver returned an empty bucket.");
  }
  return path.join(
    "workspace-contribution",
    "workspaces",
    safePathSegment(workspaceId || "default"),
    bucket,
    safePathSegment(`${relation}-${contributionId || randomUUID()}`),
    "asset.json"
  );
}

export function ensureWorkspaceAssetBuckets(
  userDataPath = "",
  workspaceId = "default",
  assetBuckets = FIXED_WORKSPACE_ASSET_BUCKETS
) {
  if (!userDataPath) {
    return [];
  }
  const safeWorkspaceId = safePathSegment(workspaceId);
  const root = path.join(dataRoot(userDataPath), "workspace-contribution", "workspaces", safeWorkspaceId);
  const paths = [];
  for (const bucket of asArray(assetBuckets).map(text).filter(Boolean)) {
    const bucketPath = path.join(root, bucket);
    fsSync.mkdirSync(bucketPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSyncBestEffort(bucketPath, PRIVATE_DIRECTORY_MODE);
    paths.push(path.relative(dataRoot(userDataPath), bucketPath));
  }
  return paths;
}

export function materializeWorkspaceAsset(contribution, {
  persistenceEnabled = false,
  userDataPath = "",
  lifecycleState = contribution.status || "submitted",
  targetWorkspaceId = contribution.workspaceId,
  relation = "canonical",
  actorId = "",
  reason = "",
  assetBucketResolver = assetBucketForType,
  assetBuckets = FIXED_WORKSPACE_ASSET_BUCKETS,
  assetRecordProjector = publicAssetRecord
} = {}) {
  const bucket = String(assetBucketResolver(contribution.contributionType) || "").trim();
  if (!bucket) {
    throw new Error("Contribution asset bucket resolver returned an empty bucket.");
  }
  const workspaceAssetPaths = ensureWorkspaceAssetBuckets(userDataPath, targetWorkspaceId, assetBuckets);
  const assetPath = workspaceAssetRelativePath({
    workspaceId: targetWorkspaceId,
    contributionType: contribution.contributionType,
    contributionId: contribution.contributionId,
    relation,
    assetBucketResolver
  });
  const timestamp = nowIso();
  const manifest = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    assetKind: "workspace_contribution_asset",
    contributionId: contribution.contributionId,
    workspaceId: targetWorkspaceId,
    sourceWorkspaceId: contribution.workspaceId,
    contributionType: contribution.contributionType,
    bucket,
    relation,
    lifecycleState,
    contributorId: contribution.contributorId,
    contributorKind: contribution.contributorKind,
    sourceAgentId: contribution.sourceAgentId,
    sourceAgentKind: contribution.sourceAgentKind,
    title: contribution.title,
    payloadRefs: contribution.payloadRefs,
    packageSize: contribution.packageSize,
    packageChecksum: contribution.packageChecksum,
    declaredPermissions: contribution.declaredPermissions,
    toolSchemaRef: contribution.toolSchemaRef,
    scriptRefs: contribution.scriptRefs,
    fileRefs: contribution.fileRefs,
    sourceCodeRefs: contribution.sourceCodeRefs,
    codeChangeRefs: contribution.codeChangeRefs,
    gatewayPolicyRefs: contribution.gatewayPolicyRefs,
    license: contribution.license,
    risk: contribution.risk,
    requestedVisibility: contribution.requestedVisibility,
    requestedActions: contribution.requestedActions,
    actorId: text(actorId),
    reason: text(reason),
    createdAt: timestamp
  };
  const manifestHash = hash(stableJson(manifest), 32);
  const record = assetRecordProjector({
    assetId: stableId("workspace_asset", {
      contributionId: contribution.contributionId,
      workspaceId: targetWorkspaceId,
      relation
    }),
    contributionId: contribution.contributionId,
    workspaceId: targetWorkspaceId,
    sourceWorkspaceId: contribution.workspaceId,
    contributionType: contribution.contributionType,
    bucket,
    relation,
    lifecycleState,
    assetPath,
    manifestHash,
    payloadRefs: contribution.payloadRefs,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  if (persistenceEnabled) {
    writeJsonSyncAtomic(path.join(dataRoot(userDataPath), assetPath), {
      ...manifest,
      assetId: record.assetId,
      assetPath,
      manifestHash,
      fixedWorkspaceAssetBuckets: workspaceAssetPaths
    }, { rootPath: storageRoot(userDataPath) });
  }
  const existingIndex = asArray(contribution.assetRecords).findIndex((item) =>
    item.workspaceId === record.workspaceId && item.relation === record.relation
  );
  if (existingIndex >= 0) {
    contribution.assetRecords[existingIndex] = {
      ...contribution.assetRecords[existingIndex],
      ...record,
      createdAt: contribution.assetRecords[existingIndex].createdAt || record.createdAt,
      updatedAt: timestamp
    };
  } else {
    contribution.assetRecords.push(record);
  }
  contribution.currentAssetRef = record;
  contribution.updatedAt = timestamp;
  return record;
}
