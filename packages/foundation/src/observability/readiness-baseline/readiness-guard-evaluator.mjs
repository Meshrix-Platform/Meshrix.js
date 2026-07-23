import { READINESS_SCOPES } from "./readiness-scope-registry.mjs";

export function evaluateReadinessGuard(guardId, context = {}) {
  const report = context.readinessReport || { scopes: [] };

  if (guardId === "require_p0_passed_or_waived") {
    const failedP0 = (report.scopes || []).filter(
      (scope) =>
        scope.productionRequired === true &&
        !["passed", "waived"].includes(scope.status)
    );

    return {
      ok: failedP0.length === 0,
      guardId,
      failedScopes: failedP0.map((s) => s.scopeId),
      reason: failedP0.length ? "p0_scope_not_passed_or_waived" : ""
    };
  }

  if (guardId === "require_baseline_v0_1_scopes_resolved") {
    const failedBaseline = (report.scopes || []).filter(
      (scope) =>
        scope.baselineV0_1Required === true && scope.status !== "passed"
    );

    const unclassified = (report.scopes || []).filter(
      (scope) => !scope.status
    );

    return {
      ok: failedBaseline.length === 0 && unclassified.length === 0,
      guardId,
      failedScopes: failedBaseline.map((s) => s.scopeId),
      unclassifiedScopes: unclassified.map((s) => s.scopeId),
      reason: failedBaseline.length
        ? "baseline_scope_not_passed"
        : unclassified.length
          ? "scope_unclassified"
          : ""
    };
  }

  return {
    ok: false,
    guardId,
    reason: "unknown_readiness_guard"
  };
}

export function buildReadinessReport(
  scopeResults,
  { runId, branch, commit, dirtyFileCount }
) {
  const scopes = READINESS_SCOPES.allScopes().map((def) => {
    const result = scopeResults[def.scopeId] || {};
    return {
      scopeId: def.scopeId,
      label: def.label,
      baselineV0_1Required: def.baselineV0_1Required,
      productionRequired: def.productionRequired,
      backlogRef: def.backlogRef || null,
      status: result.status || "not_in_baseline_v0_1",
      verificationMode: result.verificationMode || "notRun",
      evidenceMode: result.evidenceMode || result.verificationMode || "notRun",
      requiredEvidence: result.requiredEvidence || [],
      actualEvidence: result.actualEvidence || result.evidence || [],
      waiver: result.waiver || null
    };
  });

  const baselineRequiredScopes = scopes.filter((s) => s.baselineV0_1Required);
  const baselinePassed = baselineRequiredScopes.filter(
    (s) => s.status === "passed"
  ).length;
  const baselineFailed = baselineRequiredScopes.filter(
    (s) => s.status === "failed"
  ).length;
  const dirty = (dirtyFileCount || 0) > 0;
  const baselineV0_1ClaimAllowed =
    !dirty &&
    baselineFailed === 0 &&
    baselineRequiredScopes.every((s) =>
      ["passed", "waived"].includes(s.status)
    );

  const productionRequiredScopes = scopes.filter((s) => s.productionRequired);
  const productionPassed = productionRequiredScopes.filter(
    (s) => s.status === "passed"
  ).length;

  const productionVoidEvidenceScopes = productionRequiredScopes.filter(s =>
    ["contractVerified", "mocked"].includes(s.verificationMode)
  );
  const productionClaimAllowed = !dirty &&
    productionVoidEvidenceScopes.length === 0 &&
    productionRequiredScopes.every((s) =>
      ["passed", "waived"].includes(s.status)
    );

  const verifiedCount = scopes.filter(s => s.verificationMode === "verified").length;
  const contractVerifiedCount = scopes.filter(s => s.verificationMode === "contractVerified").length;
  const mockedCount = scopes.filter(s => s.verificationMode === "mocked").length;
  const notRunCount = scopes.filter(s => s.verificationMode === "notRun").length;

  const productionGuardResult = evaluateReadinessGuard(
    "require_p0_passed_or_waived",
    { readinessReport: { scopes } }
  );

  const baselineGuardResult = evaluateReadinessGuard(
    "require_baseline_v0_1_scopes_resolved",
    { readinessReport: { scopes } }
  );

  const productionVoidEvidence = productionVoidEvidenceScopes.map(s => ({
    scopeId: s.scopeId,
    verificationMode: s.verificationMode
  }));

  return {
    schemaVersion: "v0.0.1:schema:definition-1",
    reportType: "v0.0.1:production-readiness:report-0.1",
    runId,
    generatedAt: new Date().toISOString(),
    branch: branch || "",
    commit: commit || "",
    dirtyFileCount: dirtyFileCount || 0,
    generatedFromDirtyWorktree: dirty,
    overallStatus: baselineV0_1ClaimAllowed
      ? productionClaimAllowed
        ? "pass"
        : "baseline_pass_production_blocked"
      : "blocked",
    baselineV0_1ClaimAllowed,
    productionClaimAllowed,
    summary: {
      baselineRequiredTotal: baselineRequiredScopes.length,
      baselinePassed,
      baselineFailed,
      baselineOther: baselineRequiredScopes.length - baselinePassed - baselineFailed,
      productionRequiredTotal: productionRequiredScopes.length,
      productionPassed,
      productionMissingOrDeferred:
        productionRequiredScopes.length - productionPassed,
      verificationModes: {
        verifiedCount,
        contractVerifiedCount,
        mockedCount,
        notRunCount
      }
    },
    guardResults: {
      require_p0_passed_or_waived: productionGuardResult,
      require_baseline_v0_1_scopes_resolved: baselineGuardResult
    },
    productionVoidEvidence,
    scopes
  };
}
