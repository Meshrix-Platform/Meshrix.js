import { randomUUID } from "node:crypto";

import {
  asArray,
  clone,
  nowIso,
  refreshSkillHubMetrics,
  shallowObject,
  stableId,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION
} from "./skill-hub-contracts.mjs";
import { requiredWorkspaceId } from "./operation-helpers.mjs";

const EVENT_BY_STATE = Object.freeze({
  preview: "contribution.preview",
  scanned: "contribution.scan_passed",
  reviewed: "contribution.review_approved",
  published: "contribution.publish",
  adopted: "contribution.adopt",
  deprecated: "contribution.deprecate",
  revoked: "contribution.revoke"
});

function normalizedState(value = {}) {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    updatedAt: text(value.updatedAt || nowIso()),
    contributions: shallowObject(value.contributions),
    auditEvents: asArray(value.auditEvents)
  };
}

function addCount(target, key, delta = 1) {
  const normalized = text(key || "unknown") || "unknown";
  target[normalized] = Number(target[normalized] || 0) + Number(delta || 0);
}

function topRows(rows, key, limit) {
  return rows.sort((left, right) => Number(right[key] || 0) - Number(left[key] || 0) ||
    String(left.id || left.contributorId || left.workspaceId || left.eventType || "")
      .localeCompare(String(right.id || right.contributorId || right.workspaceId || right.eventType || "")))
    .slice(0, limit);
}

export function buildSkillHubStatsDashboard({ items = [], auditEvents = [], workspaceId = "", assetRecordProjector } = {}) {
  const contributions = asArray(items).map((item) => refreshSkillHubMetrics(item, { assetRecordProjector }));
  const contributorMap = new Map();
  const workspaceMap = new Map();
  const statusBreakdown = {};
  const eventCounts = {};
  const actionCounts = {};
  for (const contribution of contributions) {
    addCount(statusBreakdown, contribution.status);
    const contributorId = text(contribution.contributorId || "anonymous") || "anonymous";
    const contributor = contributorMap.get(contributorId) || {
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
    };
    contributor.contributionCount += 1;
    for (const key of ["acceptedCount", "usageCount", "successfulUseCount", "downloadCount", "permissionRequestCount",
      "permissionGrantCount", "reviewCount", "rollbackCount", "revocationCount", "uniqueWorkspaceAdoptions", "rankScore"]) {
      contributor[key] += Number(contribution.metrics?.[key] || 0);
    }
    contributor.contributionScore = contributor.rankScore + contributor.acceptedCount + contributor.permissionGrantCount -
      contributor.rollbackCount - contributor.revocationCount;
    contributorMap.set(contributorId, contributor);
    const workspaceIds = new Set([contribution.workspaceId]);
    const partitionedEvents = [
      [contribution.usageEvents, "workspaceId", "usageCount"],
      [contribution.downloadEvents, "workspaceId", "downloadCount"],
      [contribution.adoptions, "targetWorkspaceId", "adoptionCount"],
      [contribution.permissionRequests, "targetWorkspaceId", "permissionRequestCount"],
      [contribution.grants, "targetWorkspaceId", "permissionGrantCount"]
    ];
    for (const [events, workspaceField] of partitionedEvents) {
      for (const event of asArray(events)) workspaceIds.add(event[workspaceField]);
    }
    const rowsByWorkspace = new Map();
    for (const id of workspaceIds) {
      if (!id) continue;
      const row = workspaceMap.get(id) || { workspaceId: id, contributionCount: 0, usageCount: 0, successfulUseCount: 0,
        downloadCount: 0, adoptionCount: 0, permissionRequestCount: 0, permissionGrantCount: 0, rankScore: 0 };
      if (id === contribution.workspaceId) row.contributionCount += 1;
      row.rankScore += Number(contribution.metrics?.rankScore || 0);
      workspaceMap.set(id, row);
      rowsByWorkspace.set(id, row);
    }
    for (const [events, workspaceField, countField] of partitionedEvents) {
      for (const event of asArray(events)) {
        const row = rowsByWorkspace.get(event[workspaceField]);
        if (row) row[countField] += 1;
      }
    }
    for (const event of asArray(contribution.usageEvents)) addCount(actionCounts, event.action || "asset.used");
  }
  for (const event of asArray(auditEvents)) addCount(eventCounts, event.eventType);
  const sum = (field) => contributions.reduce((total, item) => total + Number(item.metrics?.[field] || 0), 0);
  const executionCount = sum("executionCount");
  const successfulUseCount = sum("successfulUseCount");
  const contributorRows = topRows([...contributorMap.values()], "contributionScore", 10);
  const workspaceRows = topRows([...workspaceMap.values()], "usageCount", 10);
  const eventBreakdown = topRows(Object.entries(eventCounts).map(([eventType, count]) => ({ eventType, count })), "count", 20);
  const usageActionBreakdown = topRows(Object.entries(actionCounts).map(([action, count]) => ({ action, count })), "count", 20);
  return {
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    dashboardSchemaVersion: "v0.0.1:workspace-contribution:dashboard-1",
    generatedAt: nowIso(),
    timeRange: "all",
    workspaceId,
    contributionType: "skill",
    contributionCount: contributions.length,
    acceptedCount: sum("acceptedCount"),
    usageCount: sum("usageCount"),
    successfulUseCount,
    successRate: executionCount > 0 ? successfulUseCount / executionCount : 0,
    uniqueWorkspaceAdoptions: new Set(contributions.flatMap((item) => asArray(item.adoptions).map((event) => event.targetWorkspaceId).filter(Boolean))).size,
    executionCount,
    permissionRequestCount: sum("permissionRequestCount"),
    permissionGrantCount: sum("permissionGrantCount"),
    downloadCount: sum("downloadCount"),
    reviewCount: sum("reviewCount"),
    revocationCount: sum("revocationCount"),
    rollbackCount: sum("rollbackCount"),
    contributionTypeBreakdown: { skill: contributions.length },
    statusBreakdown,
    contributorBreakdown: Object.fromEntries([...contributorMap].map(([id, row]) => [id, row.contributionCount])),
    contributorRows,
    workspaceRows,
    eventBreakdown,
    usageActionBreakdown,
    auditEventCount: auditEvents.length,
    dashboardSummary: {
      contributorCount: contributorMap.size,
      workspaceCount: workspaceMap.size,
      topContributorId: contributorRows[0]?.contributorId || "",
      topWorkspaceId: workspaceRows[0]?.workspaceId || "",
      eventTypeCount: eventBreakdown.length
    }
  };
}

export function createSkillHubContributionRegistry({
  workspaceId,
  initialPersistedState,
  schedulePersistence,
  serviceData,
  registryRelativePath,
  contributionNormalizer,
  materializeAsset,
  assetRecordProjector,
  lifecycleDefinition
} = {}) {
  if (!lifecycleDefinition?.machineId || !Array.isArray(lifecycleDefinition.totalMatrix)) {
    throw new TypeError("Skill Hub contribution registry requires an explicit lifecycle definition.");
  }
  const matrix = new Map(lifecycleDefinition.totalMatrix.map((entry) => [`${entry.from}::${entry.event}`, entry]));
  const loaded = normalizedState(initialPersistedState);
  const contributions = new Map(Object.values(loaded.contributions).filter((item) => item?.contributionId)
    .map((item) => [item.contributionId, refreshSkillHubMetrics(item, { assetRecordProjector })]));
  const auditEvents = loaded.auditEvents;

  function materialize(contribution, input) {
    return materializeAsset(contribution, {
      ...input,
      persistenceEnabled: true,
      serviceData,
      schedulePersistence,
      assetRecordProjector
    });
  }

  function persist() {
    const state = {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
      updatedAt: nowIso(),
      contributions: Object.fromEntries(contributions),
      auditEvents
    };
    schedulePersistence(() => serviceData.writeFile(registryRelativePath, `${JSON.stringify(state, null, 2)}\n`, "utf8"));
  }

  function get(id) {
    const contribution = contributions.get(text(id));
    if (!contribution) throw Object.assign(new Error(`Contribution not found: ${id}`), { code: "contribution_not_found" });
    return contribution;
  }

  function audit(eventType, payload = {}) {
    const value = { auditId: stableId("audit", { eventType, payload, nonce: randomUUID() }), eventType,
      workspaceId: text(payload.workspaceId || workspaceId), payload, createdAt: nowIso() };
    auditEvents.push(value);
    return value;
  }

  function transition(id, nextState, input = {}) {
    const contribution = get(id);
    const event = text(input.lifecycleEvent || EVENT_BY_STATE[nextState]);
    const decision = matrix.get(`${contribution.status}::${event}`);
    if (decision?.result === "ignored_idempotent_event") return { contribution: clone(contribution), audit: null, lifecycleDecision: decision };
    if (decision?.result !== "legal_transition" || decision.to !== nextState) {
      throw Object.assign(new Error(`Invalid contribution state transition: ${contribution.status} --${event}--> ${nextState}`),
        { code: decision?.errorCode || "INVALID_TRANSITION" });
    }
    const evidence = audit(`contribution.${nextState}`, { workspaceId: contribution.workspaceId, contributionId: id,
      actorId: input.actorId || "", reason: input.reason || "", lifecycleEvent: event });
    contribution.status = nextState;
    contribution.updatedAt = nowIso();
    contribution.statusHistory.push({ state: nextState, event, at: contribution.updatedAt,
      actorId: text(input.actorId), reason: text(input.reason) });
    contribution.auditIds.push(evidence.auditId);
    if (["published", "adopted"].includes(nextState)) contribution.metrics.acceptedCount += 1;
    materialize(contribution, { lifecycleState: nextState, targetWorkspaceId: contribution.workspaceId,
      relation: "canonical", actorId: input.actorId || "", reason: input.reason || "" });
    persist();
    return { contribution: clone(refreshSkillHubMetrics(contribution, { assetRecordProjector })), audit: evidence, lifecycleDecision: decision };
  }

  function currentGrantFor(contribution, { actorId, workspaceId: targetWorkspaceId, action = "use" } = {}) {
    const normalizedActorId = text(actorId);
    const normalizedWorkspaceId = requiredWorkspaceId(targetWorkspaceId, "workspaceId");
    const normalizedAction = text(action || "use");
    const now = Date.now();
    return contribution.grants.find((grant) =>
      grant.granteeId === normalizedActorId && grant.targetWorkspaceId === normalizedWorkspaceId &&
      grant.actions.includes(normalizedAction) &&
      (!grant.expiresAt || (Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > now))
    ) || null;
  }

  const registry = {
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    submitContribution(input = {}) {
      const contribution = contributionNormalizer(input, { workspaceId });
      if (contributions.has(contribution.contributionId)) throw Object.assign(new Error("Contribution already exists."), { code: "contribution_exists" });
      materialize(contribution, { lifecycleState: "submitted", targetWorkspaceId: contribution.workspaceId,
        relation: "canonical", actorId: contribution.contributorId, reason: "initial_submission" });
      contributions.set(contribution.contributionId, contribution);
      const evidence = audit("contribution.submitted", { workspaceId: contribution.workspaceId,
        contributionId: contribution.contributionId, contributorId: contribution.contributorId,
        contributionType: contribution.contributionType, assetId: contribution.currentAssetRef?.assetId || "" });
      contribution.auditIds.push(evidence.auditId);
      persist();
      return { contribution: clone(refreshSkillHubMetrics(contribution, { assetRecordProjector })), assetRecord: clone(contribution.currentAssetRef) };
    },
    scanContribution(id, input = {}) {
      const contribution = get(id);
      const receipt = shallowObject(input.scanReceipt);
      if (!text(receipt.runId) || !text(receipt.workloadKind).endsWith("scan") || receipt.status !== "succeeded" ||
          receipt.cleanupStatus !== "destroyed" || !text(receipt.inputDigest) || receipt.packageDigest !== contribution.packageChecksum) {
        throw Object.assign(new Error("Contribution scan requires a successful, cleaned-up receipt for the current package input."),
          { code: "contribution_scan_receipt_invalid" });
      }
      const steps = [];
      if (contribution.status === "submitted") steps.push(transition(id, "preview", { ...input, reason: "scan_requires_preview" }));
      if (get(id).status === "preview") steps.push(transition(id, "scanned", { ...input, lifecycleEvent: "contribution.scan_passed" }));
      return { ...steps.at(-1), steps };
    },
    reviewContribution(id, input = {}) {
      const contribution = get(id);
      if (contribution.status !== "scanned") throw Object.assign(new Error("Contribution review requires a completed scan receipt."), { code: "contribution_review_requires_scan" });
      if (text(input.decision) !== "approved") throw Object.assign(new Error("Contribution approval requires an explicit approved decision."), { code: "contribution_review_decision_required" });
      const reviewerId = text(input.reviewerId || input.actorId);
      if (!reviewerId || reviewerId === contribution.contributorId) {
        throw Object.assign(new Error("Contribution review requires an independent reviewer."), { code: "contribution_review_separation_required" });
      }
      const review = { reviewId: stableId("contribution_review", { id, reviewerId, nonce: randomUUID() }),
        contributionId: id, reviewerId, decision: "approved",
        reasons: asArray(input.reasons || input.reason).map(text).filter(Boolean), createdAt: nowIso() };
      contribution.reviews.push(review);
      return { ...transition(id, "reviewed", { ...input, lifecycleEvent: "contribution.review_approved" }), review: clone(review), steps: [] };
    },
    publishContribution: (id, input = {}) => transition(id, "published", { ...input, lifecycleEvent: "contribution.publish" }),
    adoptContribution(id, input = {}) {
      const contribution = get(id);
      const targetWorkspaceId = requiredWorkspaceId(input.targetWorkspaceId, "targetWorkspaceId");
      const adoption = { adoptionId: stableId("contribution_adoption", { id, targetWorkspaceId, nonce: randomUUID() }),
        contributionId: id, sourceWorkspaceId: contribution.workspaceId, targetWorkspaceId,
        adopterId: text(input.adopterId || input.actorId), status: "adopted", createdAt: nowIso() };
      contribution.adoptions.push(adoption);
      const assetRecord = materialize(contribution, { lifecycleState: "adopted", targetWorkspaceId,
        relation: "adoption", actorId: adoption.adopterId, reason: input.reason || "cross_workspace_adoption" });
      return { ...transition(id, "adopted", { ...input, lifecycleEvent: "contribution.adopt" }), adoption: clone(adoption), assetRecord: clone(assetRecord) };
    },
    deprecateContribution: (id, input = {}) => transition(id, "deprecated", { ...input, lifecycleEvent: "contribution.deprecate" }),
    revokeContribution(id, input = {}) {
      const steps = [];
      if (["published", "adopted"].includes(get(id).status)) steps.push(registry.deprecateContribution(id, input));
      const result = transition(id, "revoked", { ...input, lifecycleEvent: "contribution.revoke" });
      persist();
      return { ...result, contribution: clone(refreshSkillHubMetrics(get(id), { assetRecordProjector })), steps };
    },
    requestPermission(id, input = {}) {
      const contribution = get(id);
      const targetWorkspaceId = requiredWorkspaceId(input.targetWorkspaceId, "targetWorkspaceId");
      const permissionRequest = { permissionRequestId: stableId("contribution_permission_request", { id, ...input }),
        contributionId: id, requesterId: text(input.requesterId), targetWorkspaceId,
        actions: asArray(input.actions || ["read"]).map(text).filter(Boolean), purpose: text(input.purpose), status: "requested", createdAt: nowIso() };
      const evidence = audit("contribution.permission.requested", permissionRequest);
      contribution.permissionRequests.push(permissionRequest); contribution.auditIds.push(evidence.auditId); persist();
      return { permissionRequest: clone(permissionRequest), audit: evidence };
    },
    async grantPermission(id, input = {}) {
      const contribution = get(id);
      if (contribution.status === "revoked") throw Object.assign(new Error("Revoked contributions cannot receive grants."), { code: "contribution_grant_revoked" });
      const targetWorkspaceId = requiredWorkspaceId(input.targetWorkspaceId, "targetWorkspaceId");
      const actions = [...new Set(asArray(input.actions || contribution.requestedActions).map(text).filter(Boolean))].sort();
      const permissionRequest = [...contribution.permissionRequests].reverse().find((request) =>
        request.status === "requested" && request.targetWorkspaceId === targetWorkspaceId &&
        actions.every((action) => request.actions.includes(action))
      );
      if (!permissionRequest) throw Object.assign(new Error("Contribution grant requires a matching permission request."), { code: "contribution_grant_request_required" });
      const contributionGrant = { contributionGrantId: stableId("contribution_grant", { id, ...input }), contributionId: id,
        granteeId: text(input.granteeId), targetWorkspaceId,
        actions, expiresAt: text(input.expiresAt),
        revocationPolicy: text(input.revocationPolicy || "revoke-on-policy-change"), createdAt: nowIso() };
      const loanRecord = { loanRecordId: stableId("contribution_loan_record", contributionGrant), ...contributionGrant,
        workspaceId: contribution.workspaceId, canShare: input.canShare === true, canRetain: input.canRetain === true };
      if (typeof input.recordPluginGrant !== "function") {
        throw Object.assign(new Error("Operation Permission grant recording is unavailable."), {
          code: "skill_hub_operation_permission_unavailable"
        });
      }
      const hostReceipt = await input.recordPluginGrant({ loanRecord });
      if (hostReceipt?.ok !== true || !text(hostReceipt.receiptId)) {
        throw Object.assign(new Error("Operation Permission grant recording was not accepted."), {
          code: "skill_hub_operation_permission_denied"
        });
      }
      permissionRequest.status = "granted";
      permissionRequest.grantedAt = nowIso();
      const evidence = audit("contribution.permission.granted", { ...contributionGrant, loanRecordId: loanRecord.loanRecordId });
      contribution.grants.push(contributionGrant); contribution.auditIds.push(evidence.auditId); persist();
      return {
        contributionGrant: clone(contributionGrant),
        loanRecord,
        operationPermissionReceipt: { receiptId: text(hostReceipt.receiptId) },
        audit: evidence
      };
    },
    recordDownload(id, input = {}) {
      const contribution = get(id);
      const workspaceId = requiredWorkspaceId(input.workspaceId, "workspaceId");
      const downloadEvent = { downloadEventId: stableId("contribution_download", { id, ...input, nonce: randomUUID() }), contributionId: id,
        actorId: text(input.actorId), workspaceId, createdAt: nowIso() };
      const evidence = audit("contribution.downloaded", downloadEvent); contribution.downloadEvents.push(downloadEvent); persist();
      refreshSkillHubMetrics(contribution, { assetRecordProjector });
      return { downloadEvent: clone(downloadEvent), metrics: clone(contribution.metrics), audit: evidence };
    },
    recordUsage(id, input = {}) {
      const contribution = get(id);
      if (!["published", "adopted", "deprecated"].includes(contribution.status)) {
        throw Object.assign(new Error("Contribution use requires a published revision."), { code: "contribution_use_not_published" });
      }
      const actorId = text(input.actorId);
      const workspaceId = requiredWorkspaceId(input.workspaceId, "workspaceId");
      const action = text(input.action || "skill.used");
      const requiredAction = action === "skill.used" || action.endsWith(".use") ? "use" : action;
      const currentGrant = currentGrantFor(contribution, { actorId, workspaceId, action: requiredAction });
      if (!currentGrant) throw Object.assign(new Error("Contribution use requires a current permission grant."), { code: "contribution_use_grant_required" });
      const usageEvent = { usageEventId: stableId("contribution_usage", { id, ...input, nonce: randomUUID() }), contributionId: id,
        actorId, workspaceId, action, createdAt: nowIso() };
      const evidence = audit("contribution.used", usageEvent); contribution.usageEvents.push(usageEvent); persist();
      refreshSkillHubMetrics(contribution, { assetRecordProjector });
      return { usageEvent: clone(usageEvent), metrics: clone(contribution.metrics), audit: evidence };
    },
    recordExecutionReceipt(id, input = {}) {
      const contribution = get(id); const receipt = shallowObject(input.receipt || input);
      const normalized = { receiptId: text(receipt.receiptId), runId: text(receipt.runId), workloadKind: text(receipt.workloadKind),
        status: text(receipt.status), workloadArtifactDigest: text(receipt.workloadArtifactDigest), inputDigest: text(receipt.inputDigest),
        packageDigest: text(receipt.packageDigest), policyDigest: text(receipt.policyDigest), cleanupStatus: text(receipt.cleanupStatus),
        outputDisposition: text(receipt.outputDisposition), reasonCode: text(receipt.reasonCode), failureStage: text(receipt.failureStage),
        workspaceId: requiredWorkspaceId(receipt.workspaceId, "workspaceId"), createdAt: text(receipt.createdAt || nowIso()) };
      if (!normalized.runId || !normalized.workloadKind || !normalized.status || !normalized.inputDigest ||
          normalized.packageDigest !== contribution.packageChecksum || (normalized.status === "succeeded" &&
          (!normalized.workloadArtifactDigest || normalized.cleanupStatus !== "destroyed" || normalized.outputDisposition !== "committed"))) {
        throw Object.assign(new Error("Execution receipt is invalid."), { code: "contribution_execution_receipt_invalid" });
      }
      const existing = contribution.executionReceipts.find((entry) => entry.runId === normalized.runId);
      if (existing) return { executionReceipt: clone(existing), audit: null };
      const evidence = audit("contribution.execution.receipt", { contributionId: id, ...normalized });
      contribution.executionReceipts.push(normalized); contribution.auditIds.push(evidence.auditId); persist();
      return { executionReceipt: clone(normalized), audit: evidence };
    },
    recordRollback(id, input = {}) {
      const contribution = get(id); contribution.metrics.rollbackCount += 1;
      const evidence = audit("contribution.rollback.recorded", { workspaceId: contribution.workspaceId, contributionId: id, reason: input.reason || "" });
      persist(); return { metrics: clone(refreshSkillHubMetrics(contribution, { assetRecordProjector }).metrics), audit: evidence };
    },
    assertCurrentGrant(id, input = {}) {
      const contribution = get(id);
      const currentGrant = currentGrantFor(contribution, input);
      if (!currentGrant) {
        throw Object.assign(new Error("Contribution use requires a current permission grant."), {
          code: "contribution_use_grant_required"
        });
      }
      return clone(currentGrant);
    },
    _snapshotState() {
      return clone({ contributions: Object.fromEntries(contributions), auditEvents });
    },
    _restoreState(snapshot = {}) {
      const restored = normalizedState(snapshot);
      contributions.clear();
      for (const item of Object.values(restored.contributions)) {
        if (item?.contributionId) {
          contributions.set(item.contributionId, refreshSkillHubMetrics(item, { assetRecordProjector }));
        }
      }
      auditEvents.splice(0, auditEvents.length, ...restored.auditEvents);
    },
    getContribution: (id) => clone(get(id)),
    listContributions: () => [...contributions.values()].map((item) => clone(refreshSkillHubMetrics(item, { assetRecordProjector }))),
    getLeaderboard: () => [...contributions.values()].map((item) => refreshSkillHubMetrics(item, { assetRecordProjector }))
      .sort((left, right) => right.metrics.rankScore - left.metrics.rankScore)
      .map((item, index) => ({ rank: index + 1, contributionId: item.contributionId, title: item.title,
        contributionType: item.contributionType, contributorId: item.contributorId, rankScore: item.metrics.rankScore,
        usageCount: item.metrics.usageCount, successRate: item.metrics.successRate,
        uniqueWorkspaceAdoptions: item.metrics.uniqueWorkspaceAdoptions, rollbackCount: item.metrics.rollbackCount,
        acceptedCount: item.metrics.acceptedCount })),
    listAuditEvents: () => clone(auditEvents)
  };
  return Object.freeze(registry);
}
