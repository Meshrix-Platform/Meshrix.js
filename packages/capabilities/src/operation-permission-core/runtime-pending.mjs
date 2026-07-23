import { createHash } from "node:crypto";

import { nowIso } from "./runtime-common.mjs";
import { resultSummaryFromPayload } from "./runtime-result-summary.mjs";

function uniqueStrings(values = []) {
  const normalized = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const nested of value) {
        visit(nested);
      }
      return;
    }
    const text = String(value || "").trim();
    if (text) {
      normalized.push(text);
    }
  };
  visit(values);
  return [...new Set(normalized)];
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function intersects(left = [], right = []) {
  const rightSet = new Set(uniqueStrings(right));
  return uniqueStrings(left).some((value) => rightSet.has(value));
}

function sameStringSet(left = [], right = []) {
  const normalizedLeft = uniqueStrings(left).sort();
  const normalizedRight = uniqueStrings(right).sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function stablePayloadDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function approvalFactsFromPending(pending = {}) {
  const requiredApproval = pending.requiredApproval && typeof pending.requiredApproval === "object" && !Array.isArray(pending.requiredApproval)
    ? pending.requiredApproval
    : {};
  const requiredApprovalLayers = uniqueStrings(requiredApproval.approvalLayers || []);
  const projectedApprovalLayers = uniqueStrings(pending.approvalLayers || []);
  const approvalLayers = requiredApprovalLayers;
  return {
    requiredApproval,
    approvalLayers,
    projectionMismatch: !sameStringSet(requiredApprovalLayers, projectedApprovalLayers)
  };
}

function approvalRecordFromPending(pending = {}, { resolvedBy = "", reason = "", facts = null } = {}) {
  const { requiredApproval, approvalLayers } = facts || approvalFactsFromPending(pending);
  if (approvalLayers.length === 0) {
    return null;
  }
  const grantKinds = uniqueStrings(requiredApproval.grantKinds || []);
  const expiresAt = String(requiredApproval.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString());
  return {
    approvalId: `pending-${pending.pendingOperationId}`,
    userId: requiredApproval.userId || "",
    agentId: requiredApproval.agentId || pending.agentId || "",
    resourceType: requiredApproval.resourceType || "*",
    resourceId: requiredApproval.resourceId || "*",
    actions: uniqueStrings(requiredApproval.actions || []),
    targetProviders: uniqueStrings(requiredApproval.targetProviders || []),
    teamIds: uniqueStrings(requiredApproval.teamIds || []),
    departmentIds: uniqueStrings(requiredApproval.departmentIds || []),
    approvalLayers,
    grantKind: grantKinds.includes("once") ? "once" : grantKinds[0] || "once",
    effect: "allow",
    expiresAt,
    reason: reason || `Pending operation ${pending.pendingOperationId} approved by ${resolvedBy || "console"}.`
  };
}

function normalizedApprover(approver = {}) {
  const source = plainObject(approver.user || approver);
  return {
    userId: firstString(source.userId, source.subjectId, source.id),
    agentIds: uniqueStrings([
      source.agentId,
      source.agentProfileId,
      source.profileId,
      source.agentIds,
      source.agentProfileIds
    ]),
    teamIds: uniqueStrings([source.teamIds, source.teams]),
    departmentIds: uniqueStrings([source.departmentIds, source.departments])
  };
}

function agentBoundToApprover({ agentId = "", approverUserId = "", securityPermissions = null } = {}) {
  if (!agentId || !approverUserId) {
    return false;
  }
  const governanceStore = securityPermissions?.authorizationGovernanceStore;
  if (!governanceStore || typeof governanceStore.getAgentBinding !== "function") {
    return false;
  }
  const binding = governanceStore.getAgentBinding(agentId);
  return Boolean(binding?.enabled && binding.boundUserId && binding.boundUserId === approverUserId);
}

function approverCanApprovePending({ requiredApproval = {}, approvalLayers = [], approver = null, securityPermissions = null } = {}) {
  const layers = uniqueStrings(approvalLayers);
  if (layers.length === 0) {
    return { ok: true };
  }
  const normalized = normalizedApprover(approver || {});
  if (!normalized.userId) {
    return {
      ok: false,
      reason: "approver_session_user_missing"
    };
  }
  const requiredUserId = firstString(requiredApproval.userId, requiredApproval.subjectId);
  const requiredAgentId = firstString(requiredApproval.agentId, requiredApproval.agentProfileId);
  const requiredTeamIds = uniqueStrings(requiredApproval.teamIds || []);
  const requiredDepartmentIds = uniqueStrings(requiredApproval.departmentIds || []);
  for (const layer of layers) {
    if (layer === "user" && (!requiredUserId || normalized.userId !== requiredUserId)) {
      return { ok: false, reason: "user_approver_mismatch", deniedLayer: layer };
    }
    if (layer === "team" && (!requiredTeamIds.length || !intersects(normalized.teamIds, requiredTeamIds))) {
      return { ok: false, reason: "team_approver_mismatch", deniedLayer: layer };
    }
    if (layer === "department" && (!requiredDepartmentIds.length || !intersects(normalized.departmentIds, requiredDepartmentIds))) {
      return { ok: false, reason: "department_approver_mismatch", deniedLayer: layer };
    }
    if (layer === "agent") {
      const userOwnsAgentApproval = requiredUserId && normalized.userId === requiredUserId;
      const agentSessionMatches = requiredAgentId && normalized.agentIds.includes(requiredAgentId);
      const agentBindingMatches = agentBoundToApprover({
        agentId: requiredAgentId,
        approverUserId: normalized.userId,
        securityPermissions
      });
      if (!userOwnsAgentApproval && !agentSessionMatches && !agentBindingMatches) {
        return { ok: false, reason: "agent_approver_mismatch", deniedLayer: layer };
      }
    }
  }
  return { ok: true };
}

export function createPendingOperationRuntime({ store, executeTool, publishEvent, securityPermissions = null }) {
  async function resumePendingOperation({
    pendingOperationId,
    resolution = "approved",
    request,
    context = {},
    resolvedBy = "",
    approver = null,
    reason = "",
    resumeInput = undefined
  } = {}) {
    const pending = store.getPendingOperation?.(pendingOperationId, { includeOriginalInput: true });
    if (!pending) {
      return {
        ok: false,
        status: 404,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          error: {
            code: "pending_operation_not_found",
            message: "Pending operation was not found."
          }
        }
      };
    }
    if (pending.status !== "pending") {
      return {
        ok: false,
        status: 409,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          status: "replayed",
          terminalOutcome: "replayed",
          priorStatus: pending.status,
          pendingOperation: pending,
          error: {
            code: "pending_operation_replayed",
            message: "Pending operation approval was already resolved and cannot be resumed again."
          }
        }
      };
    }
    if (resolution === "cancelled" || resolution === "canceled") {
      const cancelled = store.resolvePendingOperation({
        pendingOperationId: pending.pendingOperationId,
        resolution: "cancelled",
        resolvedBy,
        reason,
        errorCode: "pending_operation_cancelled",
        resultSummary: { type: "approval_decision", resolution: "cancelled" }
      });
      store.appendMetric({
        traceId: pending.traceId,
        toolId: pending.toolId,
        grantId: pending.grantId,
        profileId: pending.profileId,
        status: "cancelled",
        risk: pending.risk,
        reasonCode: "pending_operation_cancelled"
      });
      await publishEvent("tools.pending_operation", {
        pendingOperationId: pending.pendingOperationId,
        traceId: pending.traceId,
        toolId: pending.toolId,
        status: "cancelled"
      }, { type: "tools.pending_operation.cancelled" });
      return {
        ok: true,
        status: 200,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          status: "cancelled",
          terminalOutcome: "cancelled",
          pendingOperation: cancelled
        }
      };
    }
    if (resolution === "rejected" || resolution === "denied") {
      const rejected = store.resolvePendingOperation({
        pendingOperationId: pending.pendingOperationId,
        resolution: "rejected",
        resolvedBy,
        reason,
        errorCode: "pending_operation_rejected",
        resultSummary: { type: "approval_decision", resolution: "denied" }
      });
      store.appendMetric({
        traceId: pending.traceId,
        toolId: pending.toolId,
        grantId: pending.grantId,
        profileId: pending.profileId,
        status: "rejected",
        risk: pending.risk,
        reasonCode: "pending_operation_rejected"
      });
      await publishEvent("tools.pending_operation", {
        pendingOperationId: pending.pendingOperationId,
        traceId: pending.traceId,
        toolId: pending.toolId,
        status: "rejected"
      }, { type: "tools.pending_operation.rejected" });
      return {
        ok: true,
        status: 200,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          status: "denied",
          terminalOutcome: "denied",
          pendingOperation: rejected
        }
      };
    }
    if (resolution !== "approved") {
      return {
        ok: false,
        status: 400,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          error: {
            code: "invalid_pending_operation_resolution",
            message: "Pending operation resolution must be approved, denied, or cancelled."
          }
        }
      };
    }
    if (resumeInput !== undefined) {
      const boundDigest = stablePayloadDigest(pending.originalInput || {});
      const resumeDigest = stablePayloadDigest(resumeInput);
      if (boundDigest !== resumeDigest) {
        const mismatched = store.resolvePendingOperation({
          pendingOperationId: pending.pendingOperationId,
          resolution: "payload_mismatch",
          resolvedBy,
          reason,
          errorCode: "approval_payload_mismatch",
          resultSummary: {
            type: "approval_decision",
            resolution: "payload_mismatch"
          }
        });
        store.appendMetric({
          traceId: pending.traceId,
          toolId: pending.toolId,
          grantId: pending.grantId,
          profileId: pending.profileId,
          status: "payload_mismatch",
          risk: pending.risk,
          reasonCode: "approval_payload_mismatch"
        });
        await publishEvent("tools.pending_operation", {
          pendingOperationId: pending.pendingOperationId,
          traceId: pending.traceId,
          toolId: pending.toolId,
          status: "payload_mismatch"
        }, { type: "tools.pending_operation.payload_mismatch" });
        return {
          ok: false,
          status: 409,
          payload: {
            schemaVersion: "v0.0.1:schema:definition-1",
            status: "payload_mismatch",
            terminalOutcome: "payload_mismatch",
            pendingOperation: mismatched,
            error: {
              code: "approval_payload_mismatch",
              message: "Approval resume payload digest does not match the bound pending operation payload."
            }
          }
        };
      }
    }
    const approvalFacts = approvalFactsFromPending(pending);
    if (approvalFacts.projectionMismatch) {
      return {
        ok: false,
        status: 409,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          status: "pending",
          pendingOperation: pending,
          error: {
            code: "pending_approval_fact_mismatch",
            message: "Pending approval requirements and approval layer projection do not match.",
            details: {
              approvalLayers: approvalFacts.approvalLayers
            }
          }
        }
      };
    }
    const approvalRecord = approvalRecordFromPending(pending, { resolvedBy, reason, facts: approvalFacts });
    if (approvalRecord) {
      if (typeof securityPermissions?.upsertGovernanceApproval !== "function") {
        const failed = store.resolvePendingOperation({
          pendingOperationId: pending.pendingOperationId,
          resolution: "failed",
          resolvedBy,
          reason,
          errorCode: "governance_approval_store_unavailable",
          resultSummary: {
            type: "approval_resume_failed",
            reason: "governance_approval_store_unavailable",
            approvalLayers: approvalRecord.approvalLayers
          }
        });
        return {
          ok: false,
          status: 503,
          payload: {
            schemaVersion: "v0.0.1:schema:definition-1",
            status: "failed",
            pendingOperation: failed,
            error: {
              code: "governance_approval_store_unavailable",
              message: "Governance approval store is unavailable for this pending operation."
            }
          }
        };
      }
      const approverDecision = approverCanApprovePending({
        requiredApproval: approvalFacts.requiredApproval,
        approvalLayers: approvalFacts.approvalLayers,
        approver,
        securityPermissions
      });
      if (!approverDecision.ok) {
        return {
          ok: false,
          status: 403,
          payload: {
            schemaVersion: "v0.0.1:schema:definition-1",
            status: "pending",
            pendingOperation: pending,
            error: {
              code: "pending_approval_approver_not_authorized",
              message: "Approver is not authorized for the pending approval layer.",
              details: {
                reasonCode: approverDecision.reason || "approver_not_authorized",
                approvalLayers: approvalRecord.approvalLayers,
                deniedLayer: approverDecision.deniedLayer || ""
              }
            }
          }
        };
      }
    }
    const grant = typeof store.getGrant === "function"
      ? await Promise.resolve(store.getGrant(pending.grantId))
      : null;
    if (
      !grant ||
      !grant.projectionFingerprint ||
      grant.policyIntegrity?.valid === false ||
      grant.enabled === false ||
      grant.revokedAt
    ) {
      const failed = store.resolvePendingOperation({
        pendingOperationId: pending.pendingOperationId,
        resolution: "failed",
        resolvedBy,
        reason,
        errorCode: "pending_operation_grant_unavailable",
        resultSummary: { type: "approval_resume_failed", reason: "grant_unavailable" }
      });
      return {
        ok: false,
        status: 409,
        payload: {
          schemaVersion: "v0.0.1:schema:definition-1",
          status: "failed",
          pendingOperation: failed,
          error: {
            code: "pending_operation_grant_unavailable",
            message: "Original tool grant is no longer available."
          }
        }
      };
    }
    if (approvalRecord) {
      try {
        await securityPermissions.upsertGovernanceApproval(approvalRecord);
      } catch {
        const failed = store.resolvePendingOperation({
          pendingOperationId: pending.pendingOperationId,
          resolution: "failed",
          resolvedBy,
          reason,
          errorCode: "governance_approval_store_failed",
          resultSummary: {
            type: "approval_resume_failed",
            reason: "governance_approval_store_failed",
            approvalLayers: approvalRecord.approvalLayers
          }
        });
        return {
          ok: false,
          status: 503,
          payload: {
            schemaVersion: "v0.0.1:schema:definition-1",
            status: "failed",
            pendingOperation: failed,
            error: {
              code: "governance_approval_store_failed",
              message: "Governance approval could not be recorded for this pending operation."
            }
          }
        };
      }
    }
    const approvalBoundRequiredApproval = {
      ...(pending.requiredApproval || {}),
      operationBinding: {
        ...(pending.requiredApproval?.operationBinding || {}),
        approvalActorId: String(resolvedBy || "")
      }
    };
    const approved = store.resolvePendingOperation({
      pendingOperationId: pending.pendingOperationId,
      resolution: "approved",
      resolvedBy,
      reason,
      requiredApproval: approvalBoundRequiredApproval,
      resultSummary: { type: "approval_decision", resolution: "approved" }
    });
    const approvedWithActorBinding = {
      ...(approved || pending),
      requiredApproval: approvalBoundRequiredApproval
    };
    await publishEvent("tools.pending_operation", {
      pendingOperationId: pending.pendingOperationId,
      traceId: pending.traceId,
      toolId: pending.toolId,
      status: "approved"
    }, { type: "tools.pending_operation.approved" });
    let result;
    try {
      result = await executeTool({
        toolId: pending.toolId,
        input: pending.originalInput || {},
        request,
        context: {
          ...pending.context,
          ...context,
          traceId: pending.traceId,
          approval: {
            approved: true,
            pendingOperationId: pending.pendingOperationId,
            resolvedBy,
            resolvedAt: approved?.resolvedAt || nowIso()
          },
          pendingOperationApproved: true
        },
        authorizedGrant: grant,
        approvedPendingOperation: approvedWithActorBinding
      });
    } finally {
      if (approvalRecord?.grantKind === "once") {
        await securityPermissions.revokeGovernanceApproval(
          approvalRecord.approvalId,
          `Single-use approval consumed by pending operation ${pending.pendingOperationId}.`
        );
      }
    }
    const finalStatus = result.ok ? "completed" : "failed";
    const completed = store.resolvePendingOperation({
      pendingOperationId: pending.pendingOperationId,
      resolution: finalStatus,
      resolvedBy,
      reason,
      errorCode: result.ok ? "" : result.payload?.error?.code || "pending_operation_resume_failed",
      resumedToolExecutionId: result.payload?.toolExecutionId || "",
      resultSummary: resultSummaryFromPayload(result.payload || {})
    });
    await publishEvent("tools.pending_operation", {
      pendingOperationId: pending.pendingOperationId,
      traceId: pending.traceId,
      toolId: pending.toolId,
      status: finalStatus,
      resumedToolExecutionId: result.payload?.toolExecutionId || ""
    }, { type: result.ok ? "tools.pending_operation.completed" : "tools.pending_operation.failed" });
    const isStillPending = (result.payload || {}).status === "pending_approval";
    return {
      ...result,
      payload: {
        ...(result.payload || {}),
        ...(isStillPending
          ? {}
          : {
            terminalOutcome: result.ok ? "approved" : finalStatus
          }),
        approvedPendingOperation: completed,
        ...(isStillPending ? {} : { pendingOperation: completed })
      }
    };
  }
  return resumePendingOperation;
}
