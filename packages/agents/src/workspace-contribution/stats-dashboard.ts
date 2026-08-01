import {
  asArray,
  nowIso,
  refreshMetrics,
  shallowObject,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION
} from "./package-validation.ts";

function addCount(target?: any, key?: any, delta: any = 1) : any {
  const normalized: any = text(key || "unknown") || "unknown";
  target[normalized] = (target[normalized] || 0) + Number(delta || 0);
}

function metricValue(contribution: Record<string, any> = {}, key: any = "") : any {
  return Number(shallowObject(contribution.metrics)[key] || 0);
}

function contributionWorkspaceIds(contribution: Record<string, any> = {}) : any {
  const workspaceIds: any = new Set<any>();
  if (contribution.workspaceId) workspaceIds.add(text(contribution.workspaceId));
  for (const event of asArray(contribution.usageEvents)) {
    if (event?.workspaceId) workspaceIds.add(text(event.workspaceId));
  }
  for (const receipt of asArray(contribution.executionReceipts)) {
    if (receipt?.workspaceId) workspaceIds.add(text(receipt.workspaceId));
  }
  for (const event of asArray(contribution.adoptions)) {
    if (event?.targetWorkspaceId) workspaceIds.add(text(event.targetWorkspaceId));
  }
  for (const event of asArray(contribution.grants)) {
    if (event?.targetWorkspaceId) workspaceIds.add(text(event.targetWorkspaceId));
  }
  return [...workspaceIds].filter(Boolean);
}

function topRows(rows: any = [], sortKey: any = "count", limit: any = 10) : any {
  return rows
    .sort((left?: any, right?: any) : any => {
      const scoreDelta: any = Number(right[sortKey] || 0) - Number(left[sortKey] || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(left.id || left.contributorId || left.workspaceId || left.eventType || "")
        .localeCompare(String(right.id || right.contributorId || right.workspaceId || right.eventType || ""));
    })
    .slice(0, Math.max(1, Math.min(Number(limit || 10), 50)));
}

export function buildContributionStatsDashboard({
  items = [],
  auditEvents = [],
  protocolVersion = WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
  workspaceId = "default",
  contributionType = "",
  assetRecordProjector = undefined
}: Record<string, any> = {}) : any {
  const normalizedItems: any = asArray(items).map((item?: any) : any => refreshMetrics(
    item,
    typeof assetRecordProjector === "function" ? { assetRecordProjector } : {}
  ));
  const contributionIds: any = new Set<any>(normalizedItems.map((item?: any) : any => item.contributionId));
  const relevantAuditEvents: any = asArray(auditEvents)
    .filter((event?: any) : any => !contributionIds.size || contributionIds.has(text(event?.payload?.contributionId)));
  const byType: Record<string, any> = {};
  const contributorMap: any = new Map<any, any>();
  const workspaceMap: any = new Map<any, any>();
  const statusBreakdown: Record<string, any> = {};
  const eventBreakdownMap: Record<string, any> = {};
  const actionBreakdown: Record<string, any> = {};

  function contributorRowFor(contribution: Record<string, any> = {}) : any {
    const contributorId: any = text(contribution.contributorId || "anonymous") || "anonymous";
    if (!contributorMap.has(contributorId)) {
      contributorMap.set(contributorId, {
        contributorId,
        contributorKind: text(contribution.contributorKind || "agent") || "agent",
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
        contributionScore: 0
      });
    }
    return contributorMap.get(contributorId);
  }

  function workspaceRowFor(workspaceKey: any = "") : any {
    const id: any = text(workspaceKey || "default") || "default";
    if (!workspaceMap.has(id)) {
      workspaceMap.set(id, {
        workspaceId: id,
        contributionCount: 0,
        usageCount: 0,
        successfulUseCount: 0,
        downloadCount: 0,
        adoptionCount: 0,
        permissionRequestCount: 0,
        permissionGrantCount: 0,
        rankScore: 0
      });
    }
    return workspaceMap.get(id);
  }

  for (const contribution of normalizedItems) {
    addCount(byType, contribution.contributionType);
    addCount(statusBreakdown, contribution.status);
    const contributor: any = contributorRowFor(contribution);
    contributor.contributionCount += 1;
    for (const key of [
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
      "rankScore"
    ]) {
      contributor[key] += metricValue(contribution, key);
    }
    contributor.contributionScore =
      contributor.rankScore +
      contributor.acceptedCount +
      contributor.permissionGrantCount -
      contributor.rollbackCount -
      contributor.revocationCount;

    for (const workspaceKey of contributionWorkspaceIds(contribution)) {
      const workspace: any = workspaceRowFor(workspaceKey);
      if (workspaceKey === contribution.workspaceId) workspace.contributionCount += 1;
      workspace.rankScore += metricValue(contribution, "rankScore");
    }
    for (const event of asArray(contribution.usageEvents)) {
      const workspace: any = workspaceRowFor(event?.workspaceId || contribution.workspaceId);
      workspace.usageCount += 1;
      addCount(actionBreakdown, event?.action || "asset.used");
    }
    for (const receipt of asArray(contribution.executionReceipts)) {
      if (receipt?.status === "succeeded") {
        workspaceRowFor(receipt?.workspaceId || contribution.workspaceId).successfulUseCount += 1;
      }
    }
    for (const event of asArray(contribution.downloadEvents)) {
      workspaceRowFor(event?.workspaceId || contribution.workspaceId).downloadCount += 1;
    }
    for (const event of asArray(contribution.adoptions)) {
      workspaceRowFor(event?.targetWorkspaceId || contribution.workspaceId).adoptionCount += 1;
    }
    for (const event of asArray(contribution.permissionRequests)) {
      workspaceRowFor(event?.targetWorkspaceId || contribution.workspaceId).permissionRequestCount += 1;
    }
    for (const event of asArray(contribution.grants)) {
      workspaceRowFor(event?.targetWorkspaceId || contribution.workspaceId).permissionGrantCount += 1;
    }
  }

  for (const event of relevantAuditEvents) addCount(eventBreakdownMap, event?.eventType || "unknown");

  const usageCount: any = normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "usageCount"), 0);
  const successfulUseCount: any = normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "successfulUseCount"), 0);
  const contributorRows: any = topRows([...contributorMap.values()], "contributionScore", 10);
  const workspaceRows: any = topRows([...workspaceMap.values()], "usageCount", 10);
  const eventBreakdown: any = topRows((Object.entries(eventBreakdownMap) as [string, any][]).map(([eventType, count]: any[]) : any => ({ eventType, count })), "count", 20);
  const usageActionBreakdown: any = topRows((Object.entries(actionBreakdown) as [string, any][]).map(([action, count]: any[]) : any => ({ action, count })), "count", 20);

  return {
    protocolVersion,
    dashboardSchemaVersion: "v0.0.1:workspace-contribution:dashboard-1",
    generatedAt: nowIso(),
    timeRange: "all",
    workspaceId,
    contributionType: contributionType || "",
    contributionCount: normalizedItems.length,
    acceptedCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "acceptedCount"), 0),
    usageCount,
    successfulUseCount,
    successRate: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "executionCount"), 0) > 0
      ? successfulUseCount / normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "executionCount"), 0)
      : 0,
    uniqueWorkspaceAdoptions: new Set<any>(normalizedItems.flatMap(contributionWorkspaceIds)).size,
    executionCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "executionCount"), 0),
    permissionRequestCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "permissionRequestCount"), 0),
    permissionGrantCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "permissionGrantCount"), 0),
    downloadCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "downloadCount"), 0),
    reviewCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "reviewCount"), 0),
    revocationCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "revocationCount"), 0),
    rollbackCount: normalizedItems.reduce((sum?: any, item?: any) : any => sum + metricValue(item, "rollbackCount"), 0),
    contributionTypeBreakdown: contributionType ? { [contributionType]: normalizedItems.length } : byType,
    statusBreakdown,
    contributorBreakdown: Object.fromEntries([...contributorMap.entries()].map(([id, row]: any[]) : any => [id, row.contributionCount])),
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
      eventTypeCount: eventBreakdown.length
    }
  };
}
