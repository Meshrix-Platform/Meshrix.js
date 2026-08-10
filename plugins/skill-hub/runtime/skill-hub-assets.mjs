import {
  asArray,
  hash,
  nowIso,
  stableId,
  stableJson,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
} from "./skill-hub-contracts.mjs";
import {
  projectSkillHubAssetRecord,
  SKILL_HUB_ASSET_BUCKETS,
  skillHubAssetBucketForType
} from "./skill-hub-contribution.mjs";
import {
  SKILL_HUB_SKILL_STORAGE_DIR,
  SKILL_HUB_STORAGE_ROOT_DIR,
  skillHubAssetRelativePath,
  skillHubSandboxPolicy
} from "./skill-hub-storage.mjs";

function safePathSegment(value) {
  return String(value || "asset")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "asset";
}

export function materializeSkillHubAsset(contribution, {
  persistenceEnabled = false,
  pluginData = null,
  schedulePersistence = null,
  lifecycleState = contribution.status || "submitted",
  targetWorkspaceId = contribution.workspaceId,
  relation = "canonical",
  actorId = "",
  reason = "",
  assetRecordProjector = projectSkillHubAssetRecord,
  assetBucketResolver = skillHubAssetBucketForType,
  assetBuckets = SKILL_HUB_ASSET_BUCKETS
} = {}) {
  const bucket = text(assetBucketResolver(contribution.contributionType));
  if (bucket !== "skills" || !asArray(assetBuckets).includes(bucket)) {
    const error = new Error("Skill Hub asset mapping must resolve to the registered skills bucket.");
    error.code = "skill_hub_asset_bucket_invalid";
    throw error;
  }
  const storageDirectories = [SKILL_HUB_STORAGE_ROOT_DIR, SKILL_HUB_SKILL_STORAGE_DIR];
  const assetPath = skillHubAssetRelativePath({
    workspaceId: targetWorkspaceId,
    contributionId: contribution.contributionId,
    relation,
    safePathSegment
  });
  if (!contribution.opaqueCustodyRef) {
    throw new Error("Skill Hub assets require an opaque custody bundle.");
  }
  const packageRoot = "";
  const packageBundle = {
    path: text(contribution.packageBundle?.path),
    digest: text(contribution.packageBundle?.digest),
    size: Number(contribution.packageBundle?.size || 0),
    custodyRef: text(contribution.packageBundle?.custodyRef),
    envelopeDigest: text(contribution.packageBundle?.envelopeDigest)
  };
  const timestamp = nowIso();
  const manifest = {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    assetKind: "skill_hub_asset",
    contributionId: contribution.contributionId,
    workspaceId: targetWorkspaceId,
    sourceWorkspaceId: contribution.workspaceId,
    contributionType: "skill",
    bucket,
    relation,
    lifecycleState,
    contributorId: contribution.contributorId,
    contributorKind: contribution.contributorKind,
    sourceAgentId: contribution.sourceAgentId,
    sourceAgentKind: contribution.sourceAgentKind,
    title: contribution.title,
    payloadRefs: contribution.payloadRefs,
    skillManifestRef: contribution.skillManifestRef,
    skillPackageRef: contribution.skillPackageRef,
    runtimeKind: contribution.runtimeKind,
    entryPoint: contribution.entryPoint,
    packageSize: contribution.packageSize,
    packageChecksum: contribution.packageChecksum,
    packageRoot,
    packageBundle,
    opaqueCustodyRef: text(contribution.opaqueCustodyRef),
    opaqueContentDigest: text(contribution.opaqueContentDigest),
    opaqueEnvelopeDigest: text(contribution.opaqueEnvelopeDigest),
    custodyState: text(contribution.custodyState),
    executionState: text(contribution.executionState),
    declaredPermissions: contribution.declaredPermissions,
    license: contribution.license,
    risk: contribution.risk,
    requestedVisibility: contribution.requestedVisibility,
    requestedActions: contribution.requestedActions,
    actorId: text(actorId),
    reason: text(reason),
    sandboxPolicy: skillHubSandboxPolicy(),
    createdAt: timestamp
  };
  const manifestHash = hash(stableJson(manifest), 32);
  const record = assetRecordProjector({
    assetId: stableId("skill_hub_asset", {
      contributionId: contribution.contributionId,
      workspaceId: targetWorkspaceId,
      relation
    }),
    contributionId: contribution.contributionId,
    workspaceId: targetWorkspaceId,
    sourceWorkspaceId: contribution.workspaceId,
    contributionType: "skill",
    bucket,
    relation,
    lifecycleState,
    assetPath,
    manifestHash,
    packageRoot,
    packageBundle,
    opaqueCustodyRef: text(contribution.opaqueCustodyRef),
    opaqueContentDigest: text(contribution.opaqueContentDigest),
    opaqueEnvelopeDigest: text(contribution.opaqueEnvelopeDigest),
    custodyState: text(contribution.custodyState),
    executionState: text(contribution.executionState),
    payloadRefs: contribution.payloadRefs,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  if (persistenceEnabled) {
    if (!pluginData || typeof pluginData.writeFile !== "function" || typeof schedulePersistence !== "function") {
      throw new TypeError("Skill Hub asset persistence requires an opaque plugin data capability.");
    }
    const persistedManifest = {
      ...manifest,
      assetId: record.assetId,
      assetPath,
      manifestHash,
      fixedSkillHubAssetBuckets: storageDirectories
    };
    schedulePersistence(() => pluginData.writeFile(
      assetPath,
      `${JSON.stringify(persistedManifest, null, 2)}\n`,
      "utf8"
    ));
  }
  contribution.packageBundle = packageBundle;
  contribution.assetRecords = asArray(contribution.assetRecords);
  const existingIndex = contribution.assetRecords.findIndex((item) =>
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
