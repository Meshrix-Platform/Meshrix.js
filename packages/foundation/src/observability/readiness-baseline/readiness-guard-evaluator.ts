import { READINESS_SCOPES } from "./readiness-scope-registry.ts";

export function evaluateReadinessGuard(guardId?: any, context: Record<string, any> = {}) : any {
  const report: any = context.readinessReport || { scopes: [] };

  if (guardId === "require_p0_passed_or_waived") {
    const failedP0: any = (report.scopes || []).filter(
      (scope?: any) : any =>
        scope.productionRequired === true &&
        !["passed", "waived"].includes(scope.status)
    );

    return {
      ok: failedP0.length === 0,
      guardId,
      failedScopes: failedP0.map((s?: any) : any => s.scopeId),
      reason: failedP0.length ? "p0_scope_not_passed_or_waived" : ""
    };
  }

  if (guardId === "require_baseline_v0_1_scopes_resolved") {
    const failedBaseline: any = (report.scopes || []).filter(
      (scope?: any) : any =>
        scope.baselineV0_1Required === true && scope.status !== "passed"
    );

    const unclassified: any = (report.scopes || []).filter(
      (scope?: any) : any => !scope.status
    );

    return {
      ok: failedBaseline.length === 0 && unclassified.length === 0,
      guardId,
      failedScopes: failedBaseline.map((s?: any) : any => s.scopeId),
      unclassifiedScopes: unclassified.map((s?: any) : any => s.scopeId),
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
  scopeResults: any,
  { runId, branch, commit, dirtyFileCount }: Record<string, any>
) : any {
  const scopes: any = READINESS_SCOPES.allScopes().map((def?: any) : any => {
    const result: any = scopeResults[def.scopeId] || {};
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

  const baselineRequiredScopes: any = scopes.filter((s?: any) : any => s.baselineV0_1Required);
  const baselinePassed: any = baselineRequiredScopes.filter(
    (s?: any) : any => s.status === "passed"
  ).length;
  const baselineFailed: any = baselineRequiredScopes.filter(
    (s?: any) : any => s.status === "failed"
  ).length;
  const dirty: any = (dirtyFileCount || 0) > 0;
  const baselineV0_1ClaimAllowed: any =
    !dirty &&
    baselineFailed === 0 &&
    baselineRequiredScopes.every((s?: any) : any =>
      ["passed", "waived"].includes(s.status)
    );

  const productionRequiredScopes: any = scopes.filter((s?: any) : any => s.productionRequired);
  const productionPassed: any = productionRequiredScopes.filter(
    (s?: any) : any => s.status === "passed"
  ).length;

  const productionVoidEvidenceScopes: any = productionRequiredScopes.filter((s?: any) : any =>
    ["contractVerified", "mocked"].includes(s.verificationMode)
  );
  const productionClaimAllowed: any = !dirty &&
    productionVoidEvidenceScopes.length === 0 &&
    productionRequiredScopes.every((s?: any) : any =>
      ["passed", "waived"].includes(s.status)
    );

  const verifiedCount: any = scopes.filter((s?: any) : any => s.verificationMode === "verified").length;
  const contractVerifiedCount: any = scopes.filter((s?: any) : any => s.verificationMode === "contractVerified").length;
  const mockedCount: any = scopes.filter((s?: any) : any => s.verificationMode === "mocked").length;
  const notRunCount: any = scopes.filter((s?: any) : any => s.verificationMode === "notRun").length;

  const productionGuardResult: any = evaluateReadinessGuard(
    "require_p0_passed_or_waived",
    { readinessReport: { scopes } }
  );

  const baselineGuardResult: any = evaluateReadinessGuard(
    "require_baseline_v0_1_scopes_resolved",
    { readinessReport: { scopes } }
  );

  const productionVoidEvidence: any = productionVoidEvidenceScopes.map((s?: any) : any => ({
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
