import { describe, it, expect } from "vitest";
import {
  STATE_MACHINE_GUARDS,
  guardExists,
  getGuard,
  listAllGuardIds
} from "../../../packages/foundation/src/workflow/state-machine/guards/guard-registry.mjs";
import {
  evaluateGuard,
  evaluateGuardSet
} from "../../../packages/foundation/src/workflow/state-machine/guards/guard-evaluator.mjs";
import {
  evaluateTransitionGuardsForValidatedDefinition as evaluateTransitionGuards
} from "../../../packages/foundation/src/workflow/state-machine/engine/transition-selector.mjs";
import {
  READINESS_SCOPES
} from "../../../packages/foundation/src/observability/readiness-baseline/readiness-scope-registry.mjs";
import {
  evaluateReadinessGuard,
  buildReadinessReport
} from "../../../packages/foundation/src/observability/readiness-baseline/readiness-guard-evaluator.mjs";

describe("Guard Registry", () => {
  it("should contain all required built-in guards", () => {
    expect(guardExists("require_p0_passed_or_waived")).toBe(true);
    expect(guardExists("require_baseline_v0_1_scopes_resolved")).toBe(true);
    expect(guardExists("require_architect_approval")).toBe(true);
    expect(guardExists("require_approval")).toBe(true);
    expect(guardExists("policyAllowed")).toBe(true);
    expect(guardExists("appendOnly")).toBe(true);
    expect(guardExists("approvalApproved")).toBe(true);
  });

  it("should return null for unknown guards", () => {
    expect(getGuard("nonexistent_guard")).toBeNull();
    expect(guardExists("nonexistent_guard")).toBe(false);
  });

  it("should list all guard IDs", () => {
    const ids = listAllGuardIds();
    expect(ids).toContain("require_p0_passed_or_waived");
    expect(ids).toContain("policyAllowed");
    expect(ids.length).toBe(Object.keys(STATE_MACHINE_GUARDS).length);
  });

  it("should have context requirements for production guard", () => {
    const guard = getGuard("require_p0_passed_or_waived");
    expect(guard.contextRequired).toContain("readinessReport");
  });
});

describe("Guard Evaluator", () => {
  it("should accept known guards with valid context", () => {
    const result = evaluateGuard("require_p0_passed_or_waived", {
      readinessReport: { scopes: [] }
    });
    expect(result.ok).toBe(true);
  });

  it("should fail on unknown guard ID", () => {
    const result = evaluateGuard("unknown_guard", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_guard");
  });

  it("should fail on missing required context", () => {
    const result = evaluateGuard("require_p0_passed_or_waived", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_context");
  });

  it("should evaluate a set of guards", () => {
    const results = evaluateGuardSet(
      ["require_p0_passed_or_waived", "policyAllowed"],
      { readinessReport: { scopes: [] }, policyDecision: { allowed: true } }
    );
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
  });

  it("should evaluate transition guards from a definition", () => {
    const def = {
      machineId: "test.v1",
      totalMatrix: [
        {
          from: "start",
          event: "go",
          result: "legal_transition",
          to: "end",
          guards: ["policyAllowed"]
        }
      ]
    };
    const result = evaluateTransitionGuards(def, "start", "go", {
      policyDecision: { allowed: true }
    });
    expect(result.ok).toBe(true);
    expect(result.guardResults).toHaveLength(1);
  });

  it("should fail transition guards for high-risk with missing guard context", () => {
    const def = {
      machineId: "test.v1",
      totalMatrix: [
        {
          from: "start",
          event: "go",
          result: "legal_transition",
          to: "end",
          guards: ["require_p0_passed_or_waived"]
        }
      ]
    };
    const result = evaluateTransitionGuards(def, "start", "go", {});
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("guard");
    expect(result.failedGuards).toContain("require_p0_passed_or_waived");
  });
});

describe("Readiness Scope Registry", () => {
  it("should keep every baseline scope marked as production required", () => {
    const baselineScopes = READINESS_SCOPES.baselineScopes();
    expect(baselineScopes.length).toBeGreaterThan(0);
    for (const scope of baselineScopes) {
      expect(scope.baselineV0_1Required).toBe(true);
      expect(scope.productionRequired).toBe(true);
    }
  });

  it("should have production-only scopes marked not_in_baseline_v0_1", () => {
    const all = READINESS_SCOPES.allScopes();
    const productionOnly = all.filter((s) => !s.baselineV0_1Required);
    expect(productionOnly.length).toBe(READINESS_SCOPES.productionOnly.length);
    for (const scope of productionOnly) {
      expect(scope.statusWhenOutOfBaseline).toBe("not_in_baseline_v0_1");
      expect(scope.backlogRef).toBeTruthy();
    }
  });

  it("should retrieve scope by ID", () => {
    const scope = READINESS_SCOPES.getScope("state-machine-core");
    expect(scope).toBeDefined();
    expect(scope.baselineV0_1Required).toBe(true);
  });

  it("should return null for unknown scope", () => {
    expect(READINESS_SCOPES.getScope("nonexistent")).toBeNull();
  });
});

describe("Readiness Guard Evaluator", () => {
  it("require_p0_passed_or_waived should pass when all production scopes are passed", () => {
    const report = {
      scopes: [
        { scopeId: "a", productionRequired: true, status: "passed" },
        { scopeId: "b", productionRequired: true, status: "passed" }
      ]
    };
    const result = evaluateReadinessGuard("require_p0_passed_or_waived", {
      readinessReport: report
    });
    expect(result.ok).toBe(true);
    expect(result.failedScopes).toEqual([]);
  });

  it("require_p0_passed_or_waived should fail when P0 scopes are missing", () => {
    const report = {
      scopes: [
        { scopeId: "a", productionRequired: true, status: "passed" },
        { scopeId: "b", productionRequired: true, status: "not_in_baseline_v0_1" }
      ]
    };
    const result = evaluateReadinessGuard("require_p0_passed_or_waived", {
      readinessReport: report
    });
    expect(result.ok).toBe(false);
    expect(result.failedScopes).toContain("b");
    expect(result.reason).toBe("p0_scope_not_passed_or_waived");
  });

  it("require_p0_passed_or_waived should pass waived scopes", () => {
    const report = {
      scopes: [
        { scopeId: "a", productionRequired: true, status: "passed" },
        {
          scopeId: "b",
          productionRequired: true,
          status: "waived",
          waiver: { waiverId: "w-1", owner: "architect", reason: "deferred" }
        }
      ]
    };
    const result = evaluateReadinessGuard("require_p0_passed_or_waived", {
      readinessReport: report
    });
    expect(result.ok).toBe(true);
  });

  it("require_baseline_v0_1_scopes_resolved should pass when all baseline scopes pass", () => {
    const report = {
      scopes: [
        { scopeId: "a", baselineV0_1Required: true, status: "passed" },
        { scopeId: "b", baselineV0_1Required: true, status: "passed" },
        { scopeId: "c", baselineV0_1Required: false, status: "not_in_baseline_v0_1" }
      ]
    };
    const result = evaluateReadinessGuard("require_baseline_v0_1_scopes_resolved", {
      readinessReport: report
    });
    expect(result.ok).toBe(true);
  });

  it("require_baseline_v0_1_scopes_resolved should fail when baseline scope fails", () => {
    const report = {
      scopes: [
        { scopeId: "a", baselineV0_1Required: true, status: "failed" },
        { scopeId: "b", baselineV0_1Required: true, status: "passed" }
      ]
    };
    const result = evaluateReadinessGuard("require_baseline_v0_1_scopes_resolved", {
      readinessReport: report
    });
    expect(result.ok).toBe(false);
    expect(result.failedScopes).toContain("a");
  });

  it("should return false for unknown guard", () => {
    const result = evaluateReadinessGuard("unknown", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_readiness_guard");
  });
});

describe("Real Guard Predicates", () => {
  it("policyAllowed should reject when decision is false", () => {
    const result = evaluateGuard("policyAllowed", {
      policyDecision: { allowed: false }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("policy_not_allowed");
  });

  it("policyAllowed should accept when decision is allow", () => {
    const result = evaluateGuard("policyAllowed", {
      policyDecision: { decision: "allow" }
    });
    expect(result.ok).toBe(true);
  });

  it("approvalApproved should reject when approval missing", () => {
    const result = evaluateGuard("approvalApproved", {
      approvalRecord: { status: "pending" }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("approval_not_approved");
  });

  it("approvalApproved should accept when approval approved", () => {
    const result = evaluateGuard("approvalApproved", {
      approvalRecord: { status: "approved" }
    });
    expect(result.ok).toBe(true);
  });

  it("approvalApproved should reject when approval missing", () => {
    const result = evaluateGuard("approvalApproved", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_context");
  });

  it("require_architect_approval should reject when approval not architect", () => {
    const result = evaluateGuard("require_architect_approval", {
      approvalRecord: { status: "approved" }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_architect_approval");
  });

  it("require_architect_approval should accept with architect role", () => {
    const result = evaluateGuard("require_architect_approval", {
      approvalRecord: { status: "approved", role: "architect" }
    });
    expect(result.ok).toBe(true);
  });

  it("require_admin should reject without admin permissions", () => {
    const result = evaluateGuard("require_admin", {
      subjectPermissions: { admin: false, roles: ["viewer"] }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_admin");
  });

  it("require_admin should accept with admin flag", () => {
    const result = evaluateGuard("require_admin", {
      subjectPermissions: { admin: true }
    });
    expect(result.ok).toBe(true);
  });

  it("require_admin should accept with admin role", () => {
    const result = evaluateGuard("require_admin", {
      subjectPermissions: { roles: ["admin", "viewer"] }
    });
    expect(result.ok).toBe(true);
  });

  it("appendOnly should reject for delete operation", () => {
    const result = evaluateGuard("appendOnly", {
      existingState: { id: "x" },
      operationType: "delete"
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_append_only");
  });

  it("appendOnly should accept for append operation", () => {
    const result = evaluateGuard("appendOnly", {
      existingState: { id: "x" },
      operationType: "read"
    });
    expect(result.ok).toBe(true);
  });

  it("treeExists should reject when tree is non-existent", () => {
    const result = evaluateGuard("treeExists", {
      treeState: { status: "non-existent" }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tree_not_found");
  });

  it("treeExists should accept when tree exists", () => {
    const result = evaluateGuard("treeExists", {
      treeState: { id: "tree1", status: "active" }
    });
    expect(result.ok).toBe(true);
  });

  it("require_ledger should reject when ledger missing", () => {
    const result = evaluateGuard("require_ledger", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_context");
  });

  it("require_ledger should accept when ledger is started", () => {
    const result = evaluateGuard("require_ledger", {
      operationRecord: { status: "started" }
    });
    expect(result.ok).toBe(true);
  });

  it("require_policy should reject when policyDecision.allowed is false", () => {
    const result = evaluateGuard("require_policy", {
      policyDecision: { allowed: false }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("policy_not_allowed");
  });

  it("require_policy should accept when allowed via decision field", () => {
    const result = evaluateGuard("require_policy", {
      policyDecision: { decision: "allow" }
    });
    expect(result.ok).toBe(true);
  });
});

describe("Readiness Report Builder", () => {
  it("should build report with baseline pass and production blocked", () => {
    const scopeResults = {};
    for (const scope of READINESS_SCOPES.baselineScopes()) {
      scopeResults[scope.scopeId] = {
        status: "passed",
        evidence: [`build/${scope.scopeId}.json`]
      };
    }
    for (const scope of READINESS_SCOPES.productionOnly) {
      scopeResults[scope.scopeId] = {
        status: "not_in_baseline_v0_1"
      };
    }

    const report = buildReadinessReport(scopeResults, {
      runId: "test-run",
      branch: "nightly",
      commit: "abc123",
      dirtyFileCount: 0
    });

    expect(report.baselineV0_1ClaimAllowed).toBe(true);
    expect(report.productionClaimAllowed).toBe(false);
    expect(report.overallStatus).toBe("baseline_pass_production_blocked");
    expect(report.summary.baselinePassed).toBe(READINESS_SCOPES.baselineScopes().length);
    expect(report.summary.baselineFailed).toBe(0);
  });

  it("should block baseline claim when a baseline scope fails", () => {
    const scopeResults = {};
    for (const scope of READINESS_SCOPES.baselineScopes()) {
      scopeResults[scope.scopeId] = {
        status: scope.scopeId === "state-machine-core" ? "failed" : "passed",
        evidence: []
      };
    }
    for (const scope of READINESS_SCOPES.productionOnly) {
      scopeResults[scope.scopeId] = { status: "not_in_baseline_v0_1" };
    }

    const report = buildReadinessReport(scopeResults, {
      runId: "test-run",
      branch: "nightly",
      commit: "abc123",
      dirtyFileCount: 0
    });

    expect(report.baselineV0_1ClaimAllowed).toBe(false);
    expect(report.productionClaimAllowed).toBe(false);
    expect(report.overallStatus).toBe("blocked");
  });

  it("should output both claim fields", () => {
    const report = buildReadinessReport({}, {
      runId: "test-run",
      branch: "nightly",
      commit: "abc123",
      dirtyFileCount: 0
    });
    expect(report).toHaveProperty("baselineV0_1ClaimAllowed");
    expect(report).toHaveProperty("productionClaimAllowed");
  });

  it("should include guard results in report", () => {
    const scopeResults = {};
    for (const scope of READINESS_SCOPES.baselineScopes()) {
      scopeResults[scope.scopeId] = { status: "passed" };
    }

    const report = buildReadinessReport(scopeResults, {
      runId: "test-run",
      branch: "nightly",
      commit: "abc123",
      dirtyFileCount: 0
    });

    expect(report.guardResults).toBeDefined();
    expect(report.guardResults.require_p0_passed_or_waived.ok).toBe(false);
    expect(report.guardResults.require_baseline_v0_1_scopes_resolved.ok).toBe(true);
  });
});
