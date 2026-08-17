import {
  nowIso,
  refreshMetrics,
  shallowObject,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
} from "./package-validation.ts";
import {
  type AssetRecordProjector,
  type AuditEvent,
  type Contribution,
  isContribution,
  type JsonObject,
} from "./types.ts";

interface RankedRow extends JsonObject {
  [key: string]: string | number;
}
interface ContributorRow extends RankedRow {
  contributorId: string;
  contributorKind: string;
  contributionCount: number;
  acceptedCount: number;
  usageCount: number;
  successfulUseCount: number;
  downloadCount: number;
  permissionRequestCount: number;
  permissionGrantCount: number;
  reviewCount: number;
  rollbackCount: number;
  revocationCount: number;
  uniqueWorkspaceAdoptions: number;
  rankScore: number;
  contributionScore: number;
}
interface WorkspaceRow extends RankedRow {
  workspaceId: string;
  contributionCount: number;
  usageCount: number;
  successfulUseCount: number;
  downloadCount: number;
  adoptionCount: number;
  permissionRequestCount: number;
  permissionGrantCount: number;
  rankScore: number;
}
export interface ContributionDashboardOptions {
  items?: Contribution[];
  auditEvents?: AuditEvent[];
  protocolVersion?: string;
  workspaceId?: string;
  contributionType?: string;
  assetRecordProjector?: AssetRecordProjector;
}
export interface ContributionDashboard extends JsonObject {
  acceptedCount: number;
  usageCount: number;
  successfulUseCount: number;
  uniqueWorkspaceAdoptions: number;
  executionCount: number;
  permissionRequestCount: number;
  permissionGrantCount: number;
  downloadCount: number;
  reviewCount: number;
  revocationCount: number;
  rollbackCount: number;
  contributionTypeBreakdown: JsonObject;
  contributorBreakdown: JsonObject;
}

function addCount(
  target: Record<string, number>,
  key: unknown,
  delta = 1,
): void {
  const normalized = text(key || "unknown") || "unknown";
  target[normalized] = (target[normalized] || 0) + Number(delta || 0);
}
function metricValue(
  contribution: Contribution,
  key: keyof Contribution["metrics"],
): number {
  return Number(contribution.metrics[key] || 0);
}
function contributionWorkspaceIds(contribution: Contribution): string[] {
  const ids = new Set<string>();
  if (contribution.workspaceId) ids.add(contribution.workspaceId);
  for (const event of contribution.usageEvents)
    if (event.workspaceId) ids.add(text(event.workspaceId));
  for (const receipt of contribution.executionReceipts)
    if (receipt.workspaceId) ids.add(text(receipt.workspaceId));
  for (const event of contribution.adoptions)
    if (event.targetWorkspaceId) ids.add(text(event.targetWorkspaceId));
  for (const event of contribution.grants)
    if (event.targetWorkspaceId) ids.add(text(event.targetWorkspaceId));
  return [...ids].filter(Boolean);
}
function topRows<T extends RankedRow>(
  rows: T[],
  sortKey = "count",
  limit = 10,
): T[] {
  return rows
    .sort((left, right) => {
      const scoreDelta =
        Number(right[sortKey] || 0) - Number(left[sortKey] || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(
        left.id ||
          left.contributorId ||
          left.workspaceId ||
          left.eventType ||
          "",
      ).localeCompare(
        String(
          right.id ||
            right.contributorId ||
            right.workspaceId ||
            right.eventType ||
            "",
        ),
      );
    })
    .slice(0, Math.max(1, Math.min(Number(limit || 10), 50)));
}
function asContribution(value: unknown): Contribution {
  if (!isContribution(value))
    throw new TypeError("Dashboard contribution is invalid.");
  return value;
}
function asAuditEvent(value: unknown): AuditEvent {
  const object = shallowObject(value);
  return {
    auditId: text(object.auditId),
    eventType: text(object.eventType),
    workspaceId: text(object.workspaceId),
    payload: shallowObject(object.payload),
    createdAt: text(object.createdAt),
  };
}

export function buildContributionStatsDashboard({
  items = [],
  auditEvents = [],
  protocolVersion = WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
  workspaceId = "default",
  contributionType = "",
  assetRecordProjector,
}: ContributionDashboardOptions = {}): ContributionDashboard {
  const normalizedItems = items
    .map(asContribution)
    .map((item) =>
      refreshMetrics(
        item,
        assetRecordProjector ? { assetRecordProjector } : {},
      ),
    );
  const contributionIds = new Set(
    normalizedItems.map((item) => item.contributionId),
  );
  const relevantAuditEvents = auditEvents
    .map(asAuditEvent)
    .filter(
      (event) =>
        !contributionIds.size ||
        contributionIds.has(text(event.payload.contributionId)),
    );
  const byType: Record<string, number> = {};
  const statusBreakdown: Record<string, number> = {};
  const eventBreakdownMap: Record<string, number> = {};
  const actionBreakdown: Record<string, number> = {};
  const contributorMap = new Map<string, ContributorRow>();
  const workspaceMap = new Map<string, WorkspaceRow>();
  const contributorRowFor = (contribution: Contribution): ContributorRow => {
    const id = text(contribution.contributorId || "anonymous") || "anonymous";
    let row = contributorMap.get(id);
    if (!row) {
      row = {
        contributorId: id,
        contributorKind:
          text(contribution.contributorKind || "agent") || "agent",
        contributionCount: 0,
        acceptedCount: 0,
        usageCount: 0,
        successfulUseCount: 0,
        downloadCount: 0,
        permissionRequestCount: 0,
        permissionGrantCount: 0,
        reviewCount: 0,
        rollbackCount: 0,
        revocationCount: 0,
        uniqueWorkspaceAdoptions: 0,
        rankScore: 0,
        contributionScore: 0,
      };
      contributorMap.set(id, row);
    }
    return row;
  };
  const workspaceRowFor = (workspaceKey: unknown): WorkspaceRow => {
    const id = text(workspaceKey || "default") || "default";
    let row = workspaceMap.get(id);
    if (!row) {
      row = {
        workspaceId: id,
        contributionCount: 0,
        usageCount: 0,
        successfulUseCount: 0,
        downloadCount: 0,
        adoptionCount: 0,
        permissionRequestCount: 0,
        permissionGrantCount: 0,
        rankScore: 0,
      };
      workspaceMap.set(id, row);
    }
    return row;
  };
  const contributorMetricKeys: (keyof Contribution["metrics"])[] = [
    "acceptedCount",
    "usageCount",
    "successfulUseCount",
    "downloadCount",
    "permissionRequestCount",
    "permissionGrantCount",
    "reviewCount",
    "rollbackCount",
    "revocationCount",
    "uniqueWorkspaceAdoptions",
    "rankScore",
  ];
  for (const contribution of normalizedItems) {
    addCount(byType, contribution.contributionType);
    addCount(statusBreakdown, contribution.status);
    const contributor = contributorRowFor(contribution);
    contributor.contributionCount += 1;
    for (const key of contributorMetricKeys)
      contributor[key] =
        Number(contributor[key]) + metricValue(contribution, key);
    contributor.contributionScore =
      contributor.rankScore +
      contributor.acceptedCount +
      contributor.permissionGrantCount -
      contributor.rollbackCount -
      contributor.revocationCount;
    for (const id of contributionWorkspaceIds(contribution)) {
      const row = workspaceRowFor(id);
      if (id === contribution.workspaceId) row.contributionCount += 1;
      row.rankScore += metricValue(contribution, "rankScore");
    }
    for (const event of contribution.usageEvents) {
      workspaceRowFor(
        event.workspaceId || contribution.workspaceId,
      ).usageCount += 1;
      addCount(actionBreakdown, event.action || "asset.used");
    }
    for (const receipt of contribution.executionReceipts)
      if (receipt.status === "succeeded")
        workspaceRowFor(
          receipt.workspaceId || contribution.workspaceId,
        ).successfulUseCount += 1;
    for (const event of contribution.downloadEvents)
      workspaceRowFor(
        event.workspaceId || contribution.workspaceId,
      ).downloadCount += 1;
    for (const event of contribution.adoptions)
      workspaceRowFor(
        event.targetWorkspaceId || contribution.workspaceId,
      ).adoptionCount += 1;
    for (const event of contribution.permissionRequests)
      workspaceRowFor(
        event.targetWorkspaceId || contribution.workspaceId,
      ).permissionRequestCount += 1;
    for (const event of contribution.grants)
      workspaceRowFor(
        event.targetWorkspaceId || contribution.workspaceId,
      ).permissionGrantCount += 1;
  }
  for (const event of relevantAuditEvents)
    addCount(eventBreakdownMap, event.eventType || "unknown");
  const total = (key: keyof Contribution["metrics"]): number =>
    normalizedItems.reduce((sum, item) => sum + metricValue(item, key), 0);
  const usageCount = total("usageCount");
  const successfulUseCount = total("successfulUseCount");
  const executionCount = total("executionCount");
  const contributorRows = topRows(
    [...contributorMap.values()],
    "contributionScore",
    10,
  );
  const workspaceRows = topRows([...workspaceMap.values()], "usageCount", 10);
  const eventBreakdown = topRows(
    Object.entries(eventBreakdownMap).map(([eventType, count]) => ({
      eventType,
      count,
    })),
    "count",
    20,
  );
  const usageActionBreakdown = topRows(
    Object.entries(actionBreakdown).map(([action, count]) => ({
      action,
      count,
    })),
    "count",
    20,
  );
  return {
    protocolVersion,
    dashboardSchemaVersion: "v0.0.1:workspace-contribution:dashboard-1",
    generatedAt: nowIso(),
    timeRange: "all",
    workspaceId,
    contributionType,
    contributionCount: normalizedItems.length,
    acceptedCount: total("acceptedCount"),
    usageCount,
    successfulUseCount,
    successRate: executionCount > 0 ? successfulUseCount / executionCount : 0,
    uniqueWorkspaceAdoptions: new Set(
      normalizedItems.flatMap(contributionWorkspaceIds),
    ).size,
    executionCount,
    permissionRequestCount: total("permissionRequestCount"),
    permissionGrantCount: total("permissionGrantCount"),
    downloadCount: total("downloadCount"),
    reviewCount: total("reviewCount"),
    revocationCount: total("revocationCount"),
    rollbackCount: total("rollbackCount"),
    contributionTypeBreakdown: contributionType
      ? { [contributionType]: normalizedItems.length }
      : byType,
    statusBreakdown,
    contributorBreakdown: Object.fromEntries(
      [...contributorMap].map(([id, row]) => [id, row.contributionCount]),
    ),
    contributorRows,
    workspaceRows,
    eventBreakdown,
    usageActionBreakdown,
    auditEventCount: relevantAuditEvents.length,
    dashboardSummary: {
      contributorCount: contributorMap.size,
      workspaceCount: workspaceMap.size,
      topContributorId: contributorRows[0]?.contributorId || "",
      topWorkspaceId: workspaceRows[0]?.workspaceId || "",
      eventTypeCount: eventBreakdown.length,
    },
  };
}
