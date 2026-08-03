import { STATE_MACHINE_GUARDS, isGuardRuntimeSafe, isStaticOnlyGuard } from "./guard-registry.ts";

export function evaluateGuard(guardId?: any, context: Record<string, any> = {}) : any {
  const guardDef: any = STATE_MACHINE_GUARDS[guardId];
  if (!guardDef) {
    return {
      ok: false,
      guardId,
      reason: "unknown_guard",
      message: `Guard '${guardId}' is not registered.`
    };
  }

  for (const required of guardDef.contextRequired) {
    if (context[required] === undefined) {
      return {
        ok: false,
        guardId,
        reason: "missing_context",
        message: `Guard '${guardId}' requires context field '${required}'.`
      };
    }
  }

  if (!isGuardRuntimeSafe(guardId)) {
    return {
      ok: false,
      guardId,
      reason: guardDef.runtimeMode === "staticOnly" ? "static_only_guard" : "no_runtime_predicate",
      message: `Guard '${guardId}' is marked ${guardDef.runtimeMode || 'without runtime predicate'} and cannot be used for runtime enforcement.`
    };
  }

  return evaluateGuardPredicate(guardId, guardDef, context);
}

function evaluateGuardPredicate(guardId?: any, guardDef?: any, context?: any) : any {
  switch (guardId) {
    case "policyAllowed":
    case "require_policy": {
      const pd: any = context.policyDecision;
      const decision: any = pd?.decision || pd?.status;
      if (pd?.allowed === true || decision === "allow") {
        return { ok: true, guardId, reason: "policy_allow" };
      }
      return {
        ok: false,
        guardId,
        reason: "policy_not_allowed",
        message: `Guard '${guardId}': policyDecision does not allow this transition.`,
        policyDecision: { allowed: pd?.allowed, decision, status: pd?.status }
      };
    }

    case "approvalApproved":
    case "require_approval": {
      const ar: any = context.approvalRecord;
      if (ar?.status === "approved") {
        return { ok: true, guardId, reason: "approval_approved" };
      }
      return {
        ok: false,
        guardId,
        reason: "approval_not_approved",
        message: `Guard '${guardId}': approval record is not in approved state.`,
        approvalRecord: { status: ar?.status }
      };
    }

    case "require_architect_approval": {
      const ar: any = context.approvalRecord;
      if (!ar) {
        return {
          ok: false,
          guardId,
          reason: "approval_missing",
          message: "Architect approval record is missing."
        };
      }
      if (ar.status !== "approved") {
        return {
          ok: false,
          guardId,
          reason: "architect_approval_not_approved",
          message: "Architect approval record is not in approved state.",
          approvalRecord: { status: ar.status }
        };
      }
      const hasArchitectRole: any =
        ar.role === "architect" ||
        ar.approverRole === "architect" ||
        ar.scope === "architect" ||
        ar.type === "architect_approval" ||
        ar.architectApproved === true;
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
      const sp: any = context.subjectPermissions || {};
      const roles: any = Array.isArray(sp.roles) ? sp.roles : [];
      if (sp.admin === true || roles.includes("owner")) {
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
      const existing: any = context.existingState;
      if (existing === undefined) {
        return {
          ok: false,
          guardId,
          reason: "missing_context",
          message: "Guard 'appendOnly' requires existingState context to verify no deletion/overwrite."
        };
      }
      if (existing._deleted === true || existing._overwritten === true || context.operationType === "delete" || context.operationType === "overwrite") {
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
      const ts: any = context.treeState;
      if (!ts || ts.status === "non-existent" || ts.deleted === true) {
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
      const ns: any = context.nodeState;
      if (!ns || ns.status === "non-existent" || ns.deleted === true) {
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
      const ps: any = context.previewState;
      if (!ps || ps.generated !== true) {
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
      const or: any = context.operationRecord;
      if (!or) {
        return {
          ok: false,
          guardId,
          reason: "ledger_missing",
          message: "Operation ledger entry is missing."
        };
      }
      if (or.status !== "started" && or.status !== "completed" && or.status !== "active") {
        return {
          ok: false,
          guardId,
          reason: "ledger_not_acceptable",
          message: `Operation ledger status '${or.status}' is not acceptable.`,
          operationRecord: { status: or.status }
        };
      }
      return { ok: true, guardId, reason: "ledger_acceptable" };
    }

    case "require_audit": {
      const ar: any = context.auditRecord;
      if (!ar) {
        return {
          ok: false,
          guardId,
          reason: "audit_missing",
          message: "Audit record is missing for this transition."
        };
      }
      if (ar.status === "rejected" || ar.status === "deleted" || ar.status === "corrupted") {
        return {
          ok: false,
          guardId,
          reason: "audit_not_acceptable",
          message: `Audit record status '${ar.status}' is not acceptable.`,
          auditRecord: { status: ar.status }
        };
      }
      return { ok: true, guardId, reason: "audit_acceptable" };
    }

    case "require_adoption_policy": {
      const ap: any = context.adoptionPolicy;
      if (!ap) {
        return {
          ok: false,
          guardId,
          reason: "adoption_policy_missing",
          message: "Adoption policy context is missing."
        };
      }
      if (ap.compliant !== true) {
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
      const report: any = context.readinessReport || { scopes: [] };
      const failedP0: any = (report.scopes || []).filter(
        (scope?: any) : any =>
          scope.productionRequired === true &&
          !["passed", "waived"].includes(scope.status)
      );
      if (failedP0.length > 0) {
        return {
          ok: false,
          guardId,
          reason: "p0_scope_not_passed_or_waived",
          failedScopes: failedP0.map((s?: any) : any => s.scopeId),
          message: `Guard '${guardId}': P0 scopes not passed or waived: ${failedP0.map((s?: any) : any => s.scopeId).join(', ')}.`
        };
      }
      return { ok: true, guardId, reason: "p0_passed_or_waived" };
    }

    case "require_baseline_v0_1_scopes_resolved": {
      const report: any = context.readinessReport || { scopes: [] };
      const failedBaseline: any = (report.scopes || []).filter(
        (scope?: any) : any =>
          scope.baselineV0_1Required === true &&
          !["passed", "waived"].includes(scope.status)
      );
      const unclassified: any = (report.scopes || []).filter(
        (scope?: any) : any => !scope.status
      );
      if (failedBaseline.length > 0) {
        return {
          ok: false,
          guardId,
          reason: "baseline_scope_not_passed",
          failedScopes: failedBaseline.map((s?: any) : any => s.scopeId),
          message: `Guard '${guardId}': Baseline scopes not passed: ${failedBaseline.map((s?: any) : any => s.scopeId).join(', ')}.`
        };
      }
      if (unclassified.length > 0) {
        return {
          ok: false,
          guardId,
          reason: "scope_unclassified",
          unclassifiedScopes: unclassified.map((s?: any) : any => s.scopeId),
          message: `Guard '${guardId}': Unclassified scopes: ${unclassified.map((s?: any) : any => s.scopeId).join(', ')}.`
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

export function evaluateGuardSet(guardIds?: any, context: Record<string, any> = {}) : any {
  const results: any[] = [];
  for (const guardId of guardIds) {
    results.push(evaluateGuard(guardId, context));
  }
  return results;
}
