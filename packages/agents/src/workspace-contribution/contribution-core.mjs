import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  asArray,
  clone,
  normalizeContribution,
  nowIso,
  publicAssetRecord,
  refreshMetrics,
  shallowObject,
  stableId,
  text,
  WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION
} from "./package-validation.mjs";
import {
  assetBucketForType,
  materializeWorkspaceAsset,
  FIXED_WORKSPACE_ASSET_BUCKETS
} from "./workspace-mapping.mjs";
import {
  readJsonSync,
  resolveStoragePathWithinRoot,
  storageRoot,
  writeJsonSyncAtomic
} from "./storage-helpers.mjs";
import { buildContributionStatsDashboard } from "./stats-dashboard.mjs";

const REGISTRY_FILE = path.join("workspace-contribution", "registry.json");
const CONTRIBUTION_EVENT_BY_TARGET_STATE = Object.freeze({
  submitted: "contribution.submit",
  preview: "contribution.preview",
  scanned: "contribution.scan_passed",
  reviewed: "contribution.review_approved",
  published: "contribution.publish",
  adopted: "contribution.adopt",
  rejected: "contribution.review_rejected",
  needs_changes: "contribution.changes_requested",
  deprecated: "contribution.deprecate",
  revoked: "contribution.revoke"
});

function registryPath(userDataPath = "", relativePath = REGISTRY_FILE) {
  return resolveStoragePathWithinRoot(userDataPath, relativePath);
}

function emptyPersistedState() {
  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    updatedAt: nowIso(),
    contributions: {},
    auditEvents: []
  };
}

function normalizePersistedState(value = {}) {
  const fallback = emptyPersistedState();
  return {
    ...fallback,
    ...shallowObject(value),
    contributions: shallowObject(value.contributions),
    auditEvents: asArray(value.auditEvents)
  };
}

function lifecycleEventForState(toState) {
  const event = CONTRIBUTION_EVENT_BY_TARGET_STATE[toState];
  if (!event) {
    throw new Error(`Unknown contribution lifecycle target state: ${toState}`);
  }
  return event;
}

function transitionDecision(transitionMatrix, fromState, event) {
  return transitionMatrix.get(`${fromState}::${event}`) || {
    result: "illegal_transition",
    errorCode: "INVALID_TRANSITION"
  };
}

function assertTransition(transitionMatrix, fromState, event, expectedState) {
  const decision = transitionDecision(transitionMatrix, fromState, event);
  if (decision.result === "ignored_idempotent_event") {
    if (expectedState && fromState !== expectedState) {
      throw new Error(`Invalid contribution state transition: ${fromState} --${event}--> ${expectedState}`);
    }
    return { to: fromState, event, idempotent: true };
  }
  if (decision.result !== "legal_transition" || decision.to !== expectedState) {
    const error = new Error(`Invalid contribution state transition: ${fromState} --${event}--> ${expectedState}`);
    error.code = decision.errorCode || "INVALID_TRANSITION";
    throw error;
  }
  return { to: decision.to, event, idempotent: false };
}

export function createContributionRegistry({
  workspaceId = "default",
  userDataPath = "",
  registryRelativePath = REGISTRY_FILE,
  initialPersistedState = undefined,
  schedulePersistence = null,
  pluginData = null,
  materializeAsset: materializeAssetOverride = null,
  lifecycleDefinition,
  excludedContributionTypes = [],
  contributionNormalizer = normalizeContribution,
  assetRecordProjector = publicAssetRecord,
  assetBucketResolver = assetBucketForType,
  assetBuckets = FIXED_WORKSPACE_ASSET_BUCKETS
} = {}) {
  if (
    !lifecycleDefinition ||
    typeof lifecycleDefinition.machineId !== "string" ||
    !lifecycleDefinition.machineId.trim() ||
    !Array.isArray(lifecycleDefinition.totalMatrix)
  ) {
    throw new Error("Contribution registry requires an explicit lifecycle definition.");
  }
  const contributionTransitionMatrix = new Map(
    lifecycleDefinition.totalMatrix.map((entry) => [`${entry.from}::${entry.event}`, entry])
  );
  const excludedContributionTypeSet = new Set(
    asArray(excludedContributionTypes).map(text).filter(Boolean)
  );
  if (typeof contributionNormalizer !== "function") {
    throw new TypeError("Contribution registry requires a contributionNormalizer function.");
  }
  if (typeof assetRecordProjector !== "function") {
    throw new TypeError("Contribution registry requires an assetRecordProjector function.");
  }
  if (typeof assetBucketResolver !== "function") {
    throw new TypeError("Contribution registry requires an assetBucketResolver function.");
  }
  const resolvedAssetBuckets = Object.freeze(asArray(assetBuckets).map(text).filter(Boolean));
  const refreshContribution = (contribution) => refreshMetrics(contribution, { assetRecordProjector });
  if (schedulePersistence !== null && typeof schedulePersistence !== "function") {
    throw new TypeError("Contribution registry persistence scheduler must be a function.");
  }
  const persistenceEnabled = Boolean(userDataPath || schedulePersistence);
  const filePath = userDataPath ? registryPath(userDataPath, registryRelativePath) : "";
  const loadedState = initialPersistedState === undefined
    ? persistenceEnabled && userDataPath
      ? normalizePersistedState(readJsonSync(filePath, emptyPersistedState()))
      : emptyPersistedState()
    : normalizePersistedState(initialPersistedState);
  const contributions = new Map(
    Object.values(loadedState.contributions || {})
      .filter((item) => item?.contributionId)
      .filter((item) => !excludedContributionTypeSet.has(text(item.contributionType)))
      .map((item) => [item.contributionId, refreshContribution(item)])
  );
  const auditEvents = asArray(loadedState.auditEvents);

  function persistRegistry() {
    if (!persistenceEnabled) {
      return;
    }
    const next = {
      schemaVersion: "v0.0.1:schema:definition-1",
      protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
      updatedAt: nowIso(),
      contributions: Object.fromEntries([...contributions.entries()].map(([id, contribution]) => [id, contribution])),
      auditEvents
    };
    if (schedulePersistence) {
      schedulePersistence(() => pluginData.writeFile(registryRelativePath, `${JSON.stringify(next, null, 2)}\n`, "utf8"));
    } else {
      writeJsonSyncAtomic(filePath, next, { rootPath: storageRoot(userDataPath) });
    }
  }

  function materializeAsset(contribution, input = {}) {
    const materialize = typeof materializeAssetOverride === "function"
      ? materializeAssetOverride
      : materializeWorkspaceAsset;
    return materialize(contribution, {
      ...input,
      persistenceEnabled,
      userDataPath,
      pluginData,
      schedulePersistence,
      assetBucketResolver,
      assetBuckets: resolvedAssetBuckets,
      assetRecordProjector
    });
  }

  function appendAudit(eventType, payload = {}) {
    const audit = {
      auditId: stableId("audit", { eventType, payload, nonce: randomUUID() }),
      eventType,
      workspaceId: text(payload.workspaceId || workspaceId),
      payload,
      createdAt: nowIso()
    };
    auditEvents.push(audit);
    return audit;
  }

  function getContribution(contributionId) {
    const contribution = contributions.get(text(contributionId));
    if (!contribution) {
      throw new Error(`Contribution not found: ${contributionId}`);
    }
    return contribution;
  }

  function transition(contributionId, nextState, input = {}) {
    const contribution = getContribution(contributionId);
    const eventId = text(input.lifecycleEvent || input.eventId || lifecycleEventForState(nextState));
    const decision = assertTransition(contributionTransitionMatrix, contribution.status, eventId, nextState);
    if (decision.idempotent) {
      return {
        contribution: clone(refreshContribution(contribution)),
        audit: null,
        lifecycleDecision: decision
      };
    }
    const audit = appendAudit(`contribution.${nextState}`, {
      workspaceId: contribution.workspaceId,
      contributionId: contribution.contributionId,
      actorId: input.actorId || "",
      reason: input.reason || "",
      lifecycleEvent: eventId
    });
    contribution.status = nextState;
    contribution.updatedAt = nowIso();
    contribution.statusHistory.push({
      state: nextState,
      event: eventId,
      at: contribution.updatedAt,
      actorId: text(input.actorId || ""),
      reason: text(input.reason || "")
    });
    contribution.auditIds.push(audit.auditId);
    if (["published", "adopted"].includes(nextState)) {
      contribution.metrics.acceptedCount += 1;
    }
    materializeAsset(contribution, {
      lifecycleState: nextState,
      targetWorkspaceId: contribution.workspaceId,
      relation: "canonical",
      actorId: input.actorId || "",
      reason: input.reason || ""
    });
    persistRegistry();
    return {
      contribution: clone(refreshContribution(contribution)),
      audit,
      lifecycleDecision: decision
    };
  }

  return {
    protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
    submitContribution(input = {}) {
      const contribution = contributionNormalizer(input, { workspaceId });
      if (excludedContributionTypeSet.has(contribution.contributionType)) {
        const error = new Error("Contribution type is not supported by this registry.");
        error.code = "contribution_type_not_supported";
        throw error;
      }
      materializeAsset(contribution, {
        lifecycleState: "submitted",
        targetWorkspaceId: contribution.workspaceId,
        relation: "canonical",
        actorId: contribution.contributorId,
        reason: "initial_submission"
      });
      contributions.set(contribution.contributionId, contribution);
      const audit = appendAudit("contribution.submitted", {
        workspaceId: contribution.workspaceId,
        contributionId: contribution.contributionId,
        contributorId: contribution.contributorId,
        contributionType: contribution.contributionType,
        assetId: contribution.currentAssetRef?.assetId || ""
      });
      contribution.auditIds.push(audit.auditId);
      persistRegistry();
      return {
        contribution: clone(refreshContribution(contribution)),
        assetRecord: clone(contribution.currentAssetRef)
      };
    },
    scanContribution(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const scanReceipt = shallowObject(input.scanReceipt);
      if (
        !text(scanReceipt.runId) ||
        !text(scanReceipt.workloadKind).endsWith("scan") ||
        text(scanReceipt.status) !== "succeeded" ||
        text(scanReceipt.cleanupStatus) !== "destroyed" ||
        !text(scanReceipt.inputDigest) ||
        text(scanReceipt.packageDigest) !== text(contribution.packageChecksum)
      ) {
        const error = new Error("Contribution scan requires a successful, cleaned-up receipt for the current package input.");
        error.code = "contribution_scan_receipt_invalid";
        throw error;
      }
      const steps = [];
      if (contribution.status === "submitted") {
        steps.push(transition(contributionId, "preview", {
          ...input,
          reason: input.previewReason || input.reason || "scan_requires_preview"
        }));
      }
      const current = getContribution(contributionId);
      if (current.status === "preview") {
        steps.push(transition(contributionId, "scanned", {
          ...input,
          lifecycleEvent: "contribution.scan_passed",
          reason: input.reason || "scan_passed"
        }));
      } else if (current.status !== "scanned") {
        steps.push(transition(contributionId, "scanned", input));
      }
      return {
        ...steps[steps.length - 1],
        steps
      };
    },
    reviewContribution(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      if (contribution.status !== "scanned") {
        const error = new Error("Contribution review requires a completed scan receipt.");
        error.code = "contribution_review_requires_scan";
        throw error;
      }
      if (text(input.decision) !== "approved") {
        const error = new Error("Contribution approval requires an explicit approved decision.");
        error.code = "contribution_review_decision_required";
        throw error;
      }
      const review = {
        reviewId: stableId("contribution_review", {
          contributionId,
          reviewerId: input.reviewerId || input.actorId,
          decision: input.decision || "approved",
          nonce: randomUUID()
        }),
        contributionId,
        reviewerId: text(input.reviewerId || input.actorId || ""),
        decision: "approved",
        reasons: asArray(input.reasons || input.reason).map(text).filter(Boolean),
        qualityGate: shallowObject(input.qualityGate),
        licenseGate: shallowObject(input.licenseGate),
        riskGate: shallowObject(input.riskGate),
        createdAt: nowIso()
      };
      contribution.reviews.push(review);
      const transitioned = transition(contributionId, "reviewed", {
        ...input,
        lifecycleEvent: "contribution.review_approved",
        reason: input.reason || review.decision
      });
      return {
        ...transitioned,
        review: clone(review),
        steps: []
      };
    },
    previewContribution(contributionId, input = {}) {
      const resultPayload = transition(contributionId, "preview", input);
      return {
        ...resultPayload,
        preview: {
          previewId: stableId("contribution_preview", {
            contributionId,
            assetId: resultPayload.contribution?.currentAssetRef?.assetId || ""
          }),
          contributionId,
          assetRecord: resultPayload.contribution?.currentAssetRef || null,
          createdAt: nowIso()
        }
      };
    },
    publishContribution(contributionId, input = {}) {
      return transition(contributionId, "published", {
        ...input,
        lifecycleEvent: "contribution.publish"
      });
    },
    adoptContribution(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const targetWorkspaceId = text(input.targetWorkspaceId || input.workspaceId || contribution.workspaceId);
      const adoption = {
        adoptionId: stableId("contribution_adoption", {
          contributionId,
          targetWorkspaceId,
          adopterId: input.adopterId || input.actorId,
          nonce: randomUUID()
        }),
        contributionId,
        sourceWorkspaceId: contribution.workspaceId,
        targetWorkspaceId,
        adopterId: text(input.adopterId || input.actorId || ""),
        status: "adopted",
        createdAt: nowIso()
      };
      contribution.adoptions.push(adoption);
      const assetRecord = materializeAsset(contribution, {
        lifecycleState: "adopted",
        targetWorkspaceId,
        relation: "adoption",
        actorId: adoption.adopterId,
        reason: input.reason || "cross_workspace_adoption"
      });
      const transitioned = transition(contributionId, "adopted", {
        ...input,
        lifecycleEvent: "contribution.adopt"
      });
      refreshContribution(contribution);
      persistRegistry();
      return {
        ...transitioned,
        adoption: clone(adoption),
        assetRecord: clone(assetRecord)
      };
    },
    rejectContribution(contributionId, input = {}) {
      return transition(contributionId, "rejected", input);
    },
    requestChanges(contributionId, input = {}) {
      return transition(contributionId, "needs_changes", {
        ...input,
        lifecycleEvent: "contribution.changes_requested"
      });
    },
    deprecateContribution(contributionId, input = {}) {
      return transition(contributionId, "deprecated", {
        ...input,
        lifecycleEvent: "contribution.deprecate"
      });
    },
    revokeContribution(contributionId, input = {}) {
      const steps = [];
      const contributionBefore = getContribution(contributionId);
      if (contributionBefore.status === "published" || contributionBefore.status === "adopted") {
        steps.push(this.deprecateContribution(contributionId, {
          ...input,
          reason: input.deprecateReason || input.reason || "revoke_requires_deprecation"
        }));
      }
      const transitioned = transition(contributionId, "revoked", {
        ...input,
        lifecycleEvent: "contribution.revoke"
      });
      const contribution = getContribution(contributionId);
      refreshContribution(contribution);
      appendAudit("contribution.rank.updated", {
        workspaceId: contribution.workspaceId,
        contributionId,
        rankScore: contribution.metrics.rankScore
      });
      persistRegistry();
      return {
        ...transitioned,
        contribution: clone(refreshContribution(contribution)),
        steps
      };
    },
    requestPermission(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const permissionRequest = {
        permissionRequestId: stableId("contribution_permission_request", {
          contributionId,
          requesterId: input.requesterId,
          targetWorkspaceId: input.targetWorkspaceId,
          actions: input.actions
        }),
        contributionId,
        requesterId: text(input.requesterId || ""),
        targetWorkspaceId: text(input.targetWorkspaceId || contribution.workspaceId),
        actions: asArray(input.actions || ["read"]).map(text).filter(Boolean),
        purpose: text(input.purpose || ""),
        status: "requested",
        createdAt: nowIso()
      };
      const audit = appendAudit("contribution.permission.requested", permissionRequest);
      contribution.permissionRequests.push(permissionRequest);
      contribution.auditIds.push(audit.auditId);
      refreshContribution(contribution);
      persistRegistry();
      return {
        permissionRequest: clone(permissionRequest),
        audit
      };
    },
    grantPermission(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const grant = {
        contributionGrantId: stableId("contribution_grant", {
          contributionId,
          granteeId: input.granteeId,
          targetWorkspaceId: input.targetWorkspaceId,
          actions: input.actions
        }),
        contributionId,
        granteeId: text(input.granteeId || ""),
        targetWorkspaceId: text(input.targetWorkspaceId || contribution.workspaceId),
        actions: asArray(input.actions || contribution.requestedActions).map(text).filter(Boolean),
        expiresAt: text(input.expiresAt || ""),
        revocationPolicy: text(input.revocationPolicy || "revoke-on-policy-change"),
        createdAt: nowIso()
      };
      const loanRecord = {
        loanRecordId: stableId("contribution_loan_record", grant),
        contributionGrantId: grant.contributionGrantId,
        contributionId,
        workspaceId: contribution.workspaceId,
        targetWorkspaceId: grant.targetWorkspaceId,
        granteeId: grant.granteeId,
        actions: grant.actions,
        canShare: input.canShare === true,
        canRetain: input.canRetain === true,
        revocationPolicy: grant.revocationPolicy,
        expiresAt: grant.expiresAt,
        createdAt: nowIso()
      };
      const audit = appendAudit("contribution.permission.granted", {
        ...grant,
        loanRecordId: loanRecord.loanRecordId
      });
      contribution.grants.push(grant);
      contribution.auditIds.push(audit.auditId);
      refreshContribution(contribution);
      persistRegistry();
      return {
        contributionGrant: clone(grant),
        loanRecord,
        audit
      };
    },
    recordDownload(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const event = {
        downloadEventId: stableId("contribution_download", {
          contributionId,
          actorId: input.actorId,
          workspaceId: input.workspaceId,
          nonce: randomUUID()
        }),
        contributionId,
        actorId: text(input.actorId || ""),
        workspaceId: text(input.workspaceId || contribution.workspaceId),
        createdAt: nowIso()
      };
      const audit = appendAudit("contribution.downloaded", event);
      contribution.downloadEvents.push(event);
      contribution.auditIds.push(audit.auditId);
      refreshContribution(contribution);
      appendAudit("contribution.rank.updated", {
        workspaceId: contribution.workspaceId,
        contributionId,
        rankScore: contribution.metrics.rankScore
      });
      persistRegistry();
      return {
        downloadEvent: clone(event),
        metrics: clone(contribution.metrics),
        audit
      };
    },
    recordUsage(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const event = {
        usageEventId: stableId("contribution_usage", {
          contributionId,
          actorId: input.actorId,
          workspaceId: input.workspaceId,
          action: input.action,
          nonce: randomUUID()
        }),
        contributionId,
        actorId: text(input.actorId || ""),
        workspaceId: text(input.workspaceId || contribution.workspaceId),
        action: text(input.action || "asset.used"),
        createdAt: nowIso()
      };
      const audit = appendAudit("contribution.used", event);
      contribution.usageEvents.push(event);
      contribution.auditIds.push(audit.auditId);
      refreshContribution(contribution);
      appendAudit("contribution.rank.updated", {
        workspaceId: contribution.workspaceId,
        contributionId,
        rankScore: contribution.metrics.rankScore
      });
      persistRegistry();
      return {
        usageEvent: clone(event),
        metrics: clone(contribution.metrics),
        audit
      };
    },
    recordExecutionReceipt(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      const receipt = shallowObject(input.receipt || input);
      const normalized = {
        receiptId: text(receipt.receiptId),
        runId: text(receipt.runId),
        workloadKind: text(receipt.workloadKind),
        status: text(receipt.status),
        workloadArtifactDigest: text(receipt.workloadArtifactDigest),
        inputDigest: text(receipt.inputDigest),
        packageDigest: text(receipt.packageDigest),
        policyDigest: text(receipt.policyDigest),
        cleanupStatus: text(receipt.cleanupStatus),
        outputDisposition: text(receipt.outputDisposition || "quarantined"),
        reasonCode: text(receipt.reasonCode),
        failureStage: text(receipt.failureStage),
        workspaceId: text(receipt.workspaceId || contribution.workspaceId),
        createdAt: text(receipt.createdAt || nowIso())
      };
      if (
        !normalized.runId ||
        !normalized.workloadKind ||
        !normalized.status ||
        !normalized.inputDigest ||
        !normalized.packageDigest ||
        (normalized.status === "succeeded" && !normalized.workloadArtifactDigest)
      ) {
        const error = new Error("Execution receipt is incomplete.");
        error.code = "contribution_execution_receipt_invalid";
        throw error;
      }
      if (
        normalized.status === "succeeded" &&
        (normalized.cleanupStatus !== "destroyed" || normalized.outputDisposition !== "quarantined")
      ) {
        const error = new Error("Successful execution receipts require destroyed isolation and quarantined output.");
        error.code = "contribution_execution_receipt_incomplete_cleanup";
        throw error;
      }
      if (normalized.packageDigest !== text(contribution.packageChecksum)) {
        const error = new Error("Execution receipt package digest does not match the current contribution.");
        error.code = "contribution_execution_receipt_stale";
        throw error;
      }
      contribution.executionReceipts = asArray(contribution.executionReceipts);
      const existing = contribution.executionReceipts.find((item) => item.runId === normalized.runId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
          const error = new Error("Execution receipt run identifier is already bound to different facts.");
          error.code = "contribution_execution_receipt_conflict";
          throw error;
        }
        return { executionReceipt: clone(existing), audit: null };
      }
      const audit = appendAudit("contribution.execution.receipt", {
        workspaceId: contribution.workspaceId,
        contributionId,
        runId: normalized.runId,
        workloadKind: normalized.workloadKind,
        status: normalized.status,
        workloadArtifactDigest: normalized.workloadArtifactDigest,
        inputDigest: normalized.inputDigest,
        packageDigest: normalized.packageDigest,
        cleanupStatus: normalized.cleanupStatus,
        outputDisposition: normalized.outputDisposition,
        reasonCode: normalized.reasonCode,
        failureStage: normalized.failureStage
      });
      contribution.executionReceipts.push(normalized);
      contribution.auditIds.push(audit.auditId);
      refreshContribution(contribution);
      persistRegistry();
      return { executionReceipt: clone(normalized), audit };
    },
    recordRollback(contributionId, input = {}) {
      const contribution = getContribution(contributionId);
      contribution.metrics.rollbackCount += 1;
      const audit = appendAudit("contribution.rollback.recorded", {
        workspaceId: contribution.workspaceId,
        contributionId,
        reason: input.reason || ""
      });
      contribution.auditIds.push(audit.auditId);
      refreshContribution(contribution);
      appendAudit("contribution.rank.updated", {
        workspaceId: contribution.workspaceId,
        contributionId,
        rankScore: contribution.metrics.rankScore
      });
      persistRegistry();
      return {
        metrics: clone(contribution.metrics),
        audit
      };
    },
    getContribution(contributionId) {
      return clone(getContribution(contributionId));
    },
    listContributions() {
      return [...contributions.values()].map((contribution) => clone(refreshContribution(contribution)));
    },
    getLeaderboard() {
      return [...contributions.values()]
        .map((contribution) => clone(refreshContribution(contribution)))
        .sort((left, right) => Number(right.metrics.rankScore || 0) - Number(left.metrics.rankScore || 0))
        .map((contribution, index) => ({
          rank: index + 1,
          contributionId: contribution.contributionId,
          title: contribution.title,
          contributionType: contribution.contributionType,
          contributorId: contribution.contributorId,
          rankScore: contribution.metrics.rankScore,
          usageCount: contribution.metrics.usageCount,
          successRate: contribution.metrics.successRate,
          uniqueWorkspaceAdoptions: contribution.metrics.uniqueWorkspaceAdoptions,
          rollbackCount: contribution.metrics.rollbackCount,
          acceptedCount: contribution.metrics.acceptedCount
        }));
    },
    getStats() {
      const items = [...contributions.values()].map((contribution) => refreshContribution(contribution));
      return buildContributionStatsDashboard({
        items,
        auditEvents,
        protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
        workspaceId,
        contributionType: "",
        assetRecordProjector
      });
    },
    getContributionReport(input = {}) {
      const stats = this.getStats();
      const leaderboard = this.getLeaderboard();
      return {
        protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
        reportId: stableId("asset_contribution_report", {
          workspaceId,
          timeRange: input.timeRange || "all"
        }),
        workspaceId,
        timeRange: input.timeRange || "all",
        acceptedCount: stats.acceptedCount,
        usageCount: stats.usageCount,
        uniqueWorkspaceAdoptions: stats.uniqueWorkspaceAdoptions,
        executionCount: stats.executionCount,
        permissionRequestCount: stats.permissionRequestCount,
        permissionGrantCount: stats.permissionGrantCount,
        rollbackCount: stats.rollbackCount,
        assetTypeBreakdown: stats.contributionTypeBreakdown,
        contributorBreakdown: stats.contributorBreakdown,
        workspaceAdoptionBreakdown: {},
        permissionFlowBreakdown: {
          requested: stats.permissionRequestCount,
          granted: stats.permissionGrantCount
        },
        usageActionBreakdown: {},
        riskBreakdown: {},
        maintenanceBreakdown: {},
        topReusableAssets: leaderboard.slice(0, 10),
        underMaintainedAssets: this.listContributions().filter((item) => Number(item.metrics.maintenanceFreshness || 0) < 0.5),
        highDemandRestrictedAssets: this.listContributions().filter((item) => item.requestedVisibility === "restricted" && item.metrics.permissionRequestCount > 0),
        rollbackHotspots: this.listContributions().filter((item) => item.metrics.rollbackCount > 0),
        assetContributionScore:
          stats.acceptedCount +
          stats.usageCount +
          stats.uniqueWorkspaceAdoptions +
          stats.permissionGrantCount -
          stats.rollbackCount
      };
    },
    listAuditEvents() {
      return clone(auditEvents);
    },
    listWorkspaceAssets(input = {}) {
      const targetWorkspaceId = text(input.workspaceId || input.targetWorkspaceId || workspaceId);
      const items = [...contributions.values()]
        .flatMap((contribution) => asArray(contribution.assetRecords))
        .map(assetRecordProjector)
        .filter((record) => !targetWorkspaceId || record.workspaceId === targetWorkspaceId);
      return {
        protocolVersion: WORKSPACE_CONTRIBUTION_PROTOCOL_VERSION,
        workspaceId: targetWorkspaceId,
        fixedBuckets: resolvedAssetBuckets,
        items,
        count: items.length
      };
    }
  };
}
