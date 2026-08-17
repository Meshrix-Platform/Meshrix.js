import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import { createHash } from "node:crypto";
import {
  asJsonObject,
  isJsonValue,
  type AssetRecord,
  type AssetRecordProjector,
  type CodedError,
  type Contribution,
  type ContributionEvent,
  type ContributionMetrics,
  type ContributionType,
  type ContributionVisibility,
  type ExecutionReceipt,
  type JsonObject,
  type JsonValue,
} from "./types.ts";

export const WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION =
  "v0.0.1:workspace:contribution-2";
export const CONTRIBUTION_TYPES: readonly ContributionType[] = Object.freeze([
  "gatewayPolicy",
  "tool",
  "script",
  "file",
  "sourceCode",
  "codeChange",
]);

export function asArray(value?: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}
export function text(value?: unknown): string {
  return String(value ?? "").trim();
}
export function shallowObject(value?: unknown): JsonObject {
  return asJsonObject(value);
}
export function nonNegativeNumber(value?: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
export function hash(value?: unknown, length = 20): string {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, length);
}
export function stableId(prefix?: unknown, input?: unknown): string {
  return `${text(prefix)}::${hash(JSON.stringify(input))}`;
}
export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeContributionType(value?: unknown): ContributionType {
  const normalized = text(value || "tool");
  const contributionType = CONTRIBUTION_TYPES.find(
    (candidate) => candidate === normalized,
  );
  if (!contributionType) {
    const error: CodedError = new Error("Unsupported core contribution type.");
    error.code = "contribution_type_not_supported";
    throw error;
  }
  return contributionType;
}
export function normalizeVisibility(value?: unknown): ContributionVisibility {
  const normalized = text(value || "workspace");
  return normalized === "private" ||
    normalized === "public" ||
    normalized === "restricted"
    ? normalized
    : "workspace";
}
function stringList(value: unknown): JsonValue[] {
  return asArray(value).map(text).filter(Boolean);
}

export function publicAssetRecord(value: JsonObject = {}): AssetRecord {
  return {
    assetId: text(value.assetId),
    contributionId: text(value.contributionId),
    workspaceId: text(value.workspaceId),
    sourceWorkspaceId: text(value.sourceWorkspaceId),
    contributionType: normalizeContributionType(value.contributionType),
    bucket: text(value.bucket),
    relation: text(value.relation || "canonical"),
    lifecycleState: text(value.lifecycleState || "submitted"),
    assetPath: text(value.assetPath),
    manifestHash: text(value.manifestHash),
    payloadRefs: stringList(value.payloadRefs),
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
  };
}

export function normalizeContribution(
  rawInput: unknown = {},
  rawDefaults: unknown = {},
): Contribution {
  const input = shallowObject(rawInput);
  const defaults = shallowObject(rawDefaults);
  const workspaceId = text(
    input.workspaceId || defaults.workspaceId || "default",
  );
  const payloadRefs = stringList(input.payloadRefs);
  const requestedActions = stringList(
    input.requestedActions || input.actions || ["discover", "read"],
  );
  const license = text(input.license || "UNREVIEWED");
  const packageFingerprint = stableJson({
    payloadRefs,
    requestedActions,
    license,
  });
  const contributionId = text(
    input.contributionId ||
      stableId("contribution", {
        workspaceId,
        contributorId: input.contributorId ?? null,
        contributionType: input.contributionType ?? null,
        payloadRefs,
        title: input.title ?? null,
      }),
  );
  const contributionType = normalizeContributionType(input.contributionType);
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
    externalCollaboratorIds: stringList(
      input.externalCollaboratorIds || input.externalCollaborators,
    ),
    copyPolicy: text(input.copyPolicy || "sameProject"),
    contributorId: text(input.contributorId || "anonymous"),
    contributorKind: text(input.contributorKind || "agent"),
    sourceAgentId: text(
      input.sourceAgentId ||
        input.agentId ||
        input.sourceAgent ||
        input.contributorId ||
        "anonymous",
    ),
    sourceAgentKind: text(
      input.sourceAgentKind ||
        input.agentKind ||
        input.contributorKind ||
        "agent",
    ),
    sourceWorkspaceIds: stringList(input.sourceWorkspaceIds || workspaceId),
    targetWorkspaceIds: stringList(input.targetWorkspaceIds || workspaceId),
    contributionType,
    title: text(input.title || `${contributionType} contribution`),
    payloadRefs,
    packageSize: nonNegativeNumber(
      input.packageSize || input.size,
      Buffer.byteLength(packageFingerprint),
    ),
    packageChecksum: text(
      input.packageChecksum || input.checksum || hash(packageFingerprint, 64),
    ),
    declaredPermissions: stringList(
      input.declaredPermissions || input.permissions || requestedActions,
    ),
    toolSchemaRef: text(input.toolSchemaRef || ""),
    scriptRefs: stringList(input.scriptRefs),
    fileRefs: stringList(input.fileRefs),
    sourceCodeRefs: stringList(input.sourceCodeRefs),
    codeChangeRefs: stringList(input.codeChangeRefs),
    gatewayPolicyRefs: stringList(input.gatewayPolicyRefs),
    license,
    risk: text(input.risk || "medium"),
    requestedVisibility: normalizeVisibility(input.requestedVisibility),
    requestedActions,
    reviewPolicy: shallowObject(input.reviewPolicy),
    status: "submitted",
    statusHistory: [
      {
        state: "submitted",
        at: timestamp,
        actorId: text(input.contributorId || "anonymous"),
        reason: text(input.reason || "initial_submission"),
      },
    ],
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
      rankScore: 0,
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
    auditIds: [
      stableId("audit", { contributionId, event: "contribution.submitted" }),
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function computeRankScore(
  metrics: Partial<ContributionMetrics> = {},
): number {
  const usageCount = Number(metrics.usageCount || 0);
  const executionCount = Number(metrics.executionCount || 0);
  const successRate =
    executionCount > 0
      ? Number(metrics.successfulUseCount || 0) / executionCount
      : 0;
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
function eventList(value: unknown): ContributionEvent[] {
  return asArray(value).map((item) => {
    const event = shallowObject(item);
    return {
      ...event,
      ...(event.workspaceId === undefined
        ? {}
        : { workspaceId: text(event.workspaceId) }),
      ...(event.targetWorkspaceId === undefined
        ? {}
        : { targetWorkspaceId: text(event.targetWorkspaceId) }),
      ...(event.status === undefined ? {} : { status: text(event.status) }),
      ...(event.state === undefined ? {} : { state: text(event.state) }),
      ...(event.action === undefined ? {} : { action: text(event.action) }),
      ...(event.runId === undefined ? {} : { runId: text(event.runId) }),
    };
  });
}
function receiptList(value: unknown): ExecutionReceipt[] {
  return asArray(value).map((item) => {
    const receipt = shallowObject(item);
    return {
      ...receipt,
      receiptId: text(receipt.receiptId),
      runId: text(receipt.runId),
      workloadKind: text(receipt.workloadKind),
      status: text(receipt.status),
      workloadArtifactDigest: text(receipt.workloadArtifactDigest),
      inputDigest: text(receipt.inputDigest),
      packageDigest: text(receipt.packageDigest),
      policyDigest: text(receipt.policyDigest),
      cleanupStatus: text(receipt.cleanupStatus),
      outputDisposition: text(receipt.outputDisposition),
      reasonCode: text(receipt.reasonCode),
      failureStage: text(receipt.failureStage),
      workspaceId: text(receipt.workspaceId),
      createdAt: text(receipt.createdAt),
    };
  });
}

export function refreshMetrics(
  contribution: Contribution,
  {
    assetRecordProjector = publicAssetRecord,
  }: { assetRecordProjector?: AssetRecordProjector } = {},
): Contribution {
  contribution.grants = eventList(contribution.grants);
  contribution.permissionRequests = eventList(contribution.permissionRequests);
  contribution.downloadEvents = eventList(contribution.downloadEvents);
  contribution.usageEvents = eventList(contribution.usageEvents);
  contribution.executionReceipts = receiptList(contribution.executionReceipts);
  contribution.reviews = eventList(contribution.reviews);
  contribution.adoptions = eventList(contribution.adoptions);
  contribution.assetRecords = asArray(contribution.assetRecords).map((item) =>
    assetRecordProjector(shallowObject(item)),
  );
  const adoptionWorkspaces = new Set<string>([
    ...contribution.usageEvents
      .map((event) => text(event.workspaceId))
      .filter(Boolean),
    ...contribution.adoptions
      .map((event) => text(event.targetWorkspaceId))
      .filter(Boolean),
    ...contribution.grants
      .map((event) => text(event.targetWorkspaceId))
      .filter(Boolean),
  ]);
  contribution.metrics.usageCount = contribution.usageEvents.length;
  contribution.metrics.successfulUseCount =
    contribution.executionReceipts.filter(
      (receipt) => receipt.status === "succeeded",
    ).length;
  contribution.metrics.uniqueWorkspaceAdoptions = adoptionWorkspaces.size;
  contribution.metrics.executionCount = contribution.executionReceipts.length;
  contribution.metrics.permissionRequestCount =
    contribution.permissionRequests.length;
  contribution.metrics.permissionGrantCount = contribution.grants.length;
  contribution.metrics.downloadCount = contribution.downloadEvents.length;
  contribution.metrics.reviewCount = contribution.reviews.length;
  contribution.metrics.revocationCount = contribution.statusHistory.filter(
    (event) => event.state === "revoked",
  ).length;
  contribution.metrics.successRate =
    contribution.metrics.executionCount > 0
      ? contribution.metrics.successfulUseCount /
        contribution.metrics.executionCount
      : 0;
  contribution.metrics.rankScore = computeRankScore(contribution.metrics);
  return contribution;
}
export function clone<T extends JsonValue>(value: T): T {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonValue(parsed))
    throw new TypeError("Cloned contribution data is not JSON-compatible.");
  return parsed as T;
}
export { stableJson };
