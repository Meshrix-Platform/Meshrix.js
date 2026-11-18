import {
  STATE_MACHINE_GUARDS,
  isGuardRuntimeSafe,
  type StateMachineGuardDefinition
} from "./guard-registry.ts";

type GuardContext = Record<string, unknown>;
export interface GuardEvaluationResult extends Record<string, unknown> {
  ok: boolean;
  guardId: string;
  reason: string;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

export function evaluateGuard(guardId: unknown, context: GuardContext = {}): GuardEvaluationResult {
  const normalizedGuardId = String(guardId || "");
  const guardDef = STATE_MACHINE_GUARDS[normalizedGuardId];
  if (!guardDef) {
    return {
      ok: false,
      guardId: normalizedGuardId,
      reason: "unknown_guard",
      message: `Guard '${normalizedGuardId}' is not registered.`
    };
  }

  for (const required of guardDef.contextRequired) {
    if (context[required] === undefined) {
      return {
        ok: false,
        guardId: normalizedGuardId,
        reason: "missing_context",
        message: `Guard '${normalizedGuardId}' requires context field '${required}'.`
      };
    }
  }

  if (!isGuardRuntimeSafe(normalizedGuardId)) {
    return {
      ok: false,
      guardId: normalizedGuardId,
      reason: guardDef.runtimeMode === "staticOnly" ? "static_only_guard" : "no_runtime_predicate",
      message: `Guard '${normalizedGuardId}' is marked ${guardDef.runtimeMode || 'without runtime predicate'} and cannot be used for runtime enforcement.`
    };
  }

  return evaluateGuardPredicate(normalizedGuardId, guardDef, context);
}

function evaluateGuardPredicate(
  guardId: string,
  _guardDef: StateMachineGuardDefinition,
  context: GuardContext
): GuardEvaluationResult {
  switch (guardId) {
    case "policyAllowed":
    case "require_policy": {
      const policyDecision = asRecord(context.policyDecision);
      const decision = policyDecision.decision || policyDecision.status;
      if (policyDecision.allowed === true || decision === "allow") {
        return { ok: true, guardId, reason: "policy_allow" };
      }
      return {
        ok: false,
        guardId,
        reason: "policy_not_allowed",
        message: `Guard '${guardId}': policyDecision does not allow this transition.`,
        policyDecision: { allowed: policyDecision.allowed, decision, status: policyDecision.status }
      };
    }

    case "approvalApproved":
    case "require_approval": {
      const approvalRecord = asRecord(context.approvalRecord);
      if (approvalRecord.status === "approved") {
        return { ok: true, guardId, reason: "approval_approved" };
      }
      return {
        ok: false,
        guardId,
        reason: "approval_not_approved",
        message: `Guard '${guardId}': approval record is not in approved state.`,
        approvalRecord: { status: approvalRecord.status }
      };
    }

    case "require_architect_approval": {
      const approvalRecord = asRecord(context.approvalRecord);
      if (Object.keys(approvalRecord).length === 0) {
        return {
          ok: false,
          guardId,
          reason: "approval_missing",
          message: "Architect approval record is missing."
        };
      }
      if (approvalRecord.status !== "approved") {
        return {
          ok: false,
          guardId,
          reason: "architect_approval_not_approved",
          message: "Architect approval record is not in approved state.",
          approvalRecord: { status: approvalRecord.status }
        };
      }
      const hasArchitectRole =
        approvalRecord.role === "architect" ||
        approvalRecord.approverRole === "architect" ||
        approvalRecord.scope === "architect" ||
        approvalRecord.type === "architect_approval" ||
        approvalRecord.architectApproved === true;
      if (!hasArchitectRole) {
        return {
          ok: false,
          guardId,
          reason: "not_architect_approval",
          message: "Approval is present but does not constitute architect approval."
        };
      }
      return { ok: true, guardId, reason: "architect_approved" };
    }

    case "require_admin": {
      const subjectPermissions = asRecord(context.subjectPermissions);
      const roles = Array.isArray(subjectPermissions.roles) ? subjectPermissions.roles : [];
      if (subjectPermissions.admin === true || roles.includes("owner")) {
        return { ok: true, guardId, reason: "admin_authorized" };
      }
      return {
        ok: false,
        guardId,
        reason: "not_admin",
        message: "Guard 'require_admin': subject lacks admin authorization."
      };
    }

    case "appendOnly": {
      const existingState = asRecord(context.existingState);
      if (context.existingState === undefined) {
        return {
          ok: false,
          guardId,
          reason: "missing_context",
          message: "Guard 'appendOnly' requires existingState context to verify no deletion/overwrite."
        };
      }
      if (existingState._deleted === true || existingState._overwritten === true || context.operationType === "delete" || context.operationType === "overwrite") {
        return {
          ok: false,
          guardId,
          reason: "not_append_only",
          message: "Guard 'appendOnly': operation would delete or overwrite existing records."
        };
      }
      return { ok: true, guardId, reason: "append_only_allowed" };
    }

    case "treeExists": {
      const treeState = asRecord(context.treeState);
      if (Object.keys(treeState).length === 0 || treeState.status === "non-existent" || treeState.deleted === true) {
        return {
          ok: false,
          guardId,
          reason: "tree_not_found",
          message: "Target checkpoint tree does not exist."
        };
      }
      return { ok: true, guardId, reason: "tree_exists" };
    }

    case "nodeExists": {
      const nodeState = asRecord(context.nodeState);
      if (Object.keys(nodeState).length === 0 || nodeState.status === "non-existent" || nodeState.deleted === true) {
        return {
          ok: false,
          guardId,
          reason: "node_not_found",
          message: "Target checkpoint node does not exist."
        };
      }
      return { ok: true, guardId, reason: "node_exists" };
    }

    case "previewGenerated": {
      const previewState = asRecord(context.previewState);
      if (previewState.generated !== true) {
        return {
          ok: false,
          guardId,
          reason: "preview_not_generated",
          message: "Restore preview must be generated before applying."
        };
      }
      return { ok: true, guardId, reason: "preview_generated" };
    }

    case "require_ledger": {
      const operationRecord = asRecord(context.operationRecord);
      if (Object.keys(operationRecord).length === 0) {
        return {
          ok: false,
          guardId,
          reason: "ledger_missing",
          message: "Operation ledger entry is missing."
        };
      }
      if (operationRecord.status !== "started" && operationRecord.status !== "completed" && operationRecord.status !== "active") {
        return {
          ok: false,
          guardId,
          reason: "ledger_not_acceptable",
          message: `Operation ledger status '${operationRecord.status}' is not acceptable.`,
          operationRecord: { status: operationRecord.status }
        };
      }
      return { ok: true, guardId, reason: "ledger_acceptable" };
    }

    case "require_audit": {
      const auditRecord = asRecord(context.auditRecord);
      if (Object.keys(auditRecord).length === 0) {
        return {
          ok: false,
          guardId,
          reason: "audit_missing",
          message: "Audit record is missing for this transition."
        };
      }
      if (auditRecord.status === "rejected" || auditRecord.status === "deleted" || auditRecord.status === "corrupted") {
        return {
          ok: false,
          guardId,
          reason: "audit_not_acceptable",
          message: `Audit record status '${auditRecord.status}' is not acceptable.`,
          auditRecord: { status: auditRecord.status }
        };
      }
      return { ok: true, guardId, reason: "audit_acceptable" };
    }

    case "require_adoption_policy": {
      const adoptionPolicy = asRecord(context.adoptionPolicy);
      if (Object.keys(adoptionPolicy).length === 0) {
        return {
          ok: false,
          guardId,
          reason: "adoption_policy_missing",
          message: "Adoption policy context is missing."
        };
      }
      if (adoptionPolicy.compliant !== true) {
        return {
          ok: false,
          guardId,
          reason: "adoption_not_compliant",
          message: "Adoption does not comply with contribution adoption policy rules."
        };
      }
      return { ok: true, guardId, reason: "adoption_compliant" };
    }

    case "noApprovalRequired": {
      return { ok: true, guardId, reason: "no_approval_required" };
    }

    case "require_p0_passed_or_waived": {
      const report = asRecord(context.readinessReport);
      const failedP0 = asRecords(report.scopes).filter(
        (scope) =>
          scope.productionRequired === true &&
          !["passed", "waived"].includes(String(scope.status || ""))
      );
      if (failedP0.length > 0) {
        return {
          ok: false,
          guardId,
          reason: "p0_scope_not_passed_or_waived",
          failedScopes: failedP0.map((scope) => scope.scopeId),
          message: `Guard '${guardId}': P0 scopes not passed or waived: ${failedP0.map((scope) => scope.scopeId).join(', ')}.`
        };
      }
      return { ok: true, guardId, reason: "p0_passed_or_waived" };
    }

    case "require_baseline_v0_1_scopes_resolved": {
      const report = asRecord(context.readinessReport);
      const scopes = asRecords(report.scopes);
      const failedBaseline = scopes.filter(
        (scope) =>
          scope.baselineV0_1Required === true &&
          !["passed", "waived"].includes(String(scope.status || ""))
      );
      const unclassified = scopes.filter(
        (scope) => !scope.status
      );
      if (failedBaseline.length > 0) {
        return {
          ok: false,
          guardId,
          reason: "baseline_scope_not_passed",
          failedScopes: failedBaseline.map((scope) => scope.scopeId),
          message: `Guard '${guardId}': Baseline scopes not passed: ${failedBaseline.map((scope) => scope.scopeId).join(', ')}.`
        };
      }
      if (unclassified.length > 0) {
        return {
          ok: false,
          guardId,
          reason: "scope_unclassified",
          unclassifiedScopes: unclassified.map((scope) => scope.scopeId),
          message: `Guard '${guardId}': Unclassified scopes: ${unclassified.map((scope) => scope.scopeId).join(', ')}.`
        };
      }
      return { ok: true, guardId, reason: "baseline_resolved" };
    }

    default: {
      return {
        ok: false,
        guardId,
        reason: "no_runtime_predicate",
        message: `Guard '${guardId}' has no runtime predicate implementation and is not marked staticOnly.`
      };
    }
  }
}

export function evaluateGuardSet(guardIds: unknown, context: GuardContext = {}): GuardEvaluationResult[] {
  const results: GuardEvaluationResult[] = [];
  for (const guardId of Array.isArray(guardIds) ? guardIds : []) {
    results.push(evaluateGuard(guardId, context));
  }
  return results;
}
