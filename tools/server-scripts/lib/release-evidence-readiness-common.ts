export const RELEASE_EVIDENCE_READINESS_SOURCE: any =
  "tools/server-scripts/lib/release-evidence-readiness.ts#createReleaseEvidenceReadiness";
export const DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE: any =
  "tools/server-scripts/lib/release-evidence-readiness.ts#createDefaultReleaseEvidenceReadiness";
export const AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE: any =
  "tools/server-scripts/lib/release-evidence-readiness.ts#createAggregateReleaseEvidenceReadiness";
export const UPSTREAM_GATEWAY_E2E_READINESS_SOURCE: any =
  "tools/server-scripts/lib/release-evidence-readiness.ts#createUpstreamGatewayE2eReadiness";
export const GATEWAY_PLATFORM_PROFILE_READINESS_SOURCE: any =
  "tools/server-scripts/lib/release-evidence-readiness.ts#createGatewayPlatformProfileReadiness";

export function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asStringArray(value?: any) : any {
  return Array.isArray(value) ? value.map(String) : [];
}

export function stringListKey(values?: any) : any {
  return JSON.stringify((Array.isArray(values) ? values : [])
    .map((value?: any) : any => String(value || "").trim())
    .filter(Boolean)
    .sort());
}

const ZERO_COUNT_FIELDS: readonly any[] = Object.freeze([
  "failedCount", "failed", "failedCommandCount", "criticalFindings", "missingEvidenceCount",
  "deploymentFailedCommandCount", "deploymentMissingEvidenceCount", "failingOperationCount",
  "missingRuntimeEvidenceCount", "missingEndpointCount", "unmappedOperationCount", "missingDimensionCount",
  "missingRealMetricFamilyCount", "missingTraceEvidenceCount", "remainingProductionBlockerCount",
  "errorCount", "missingRequiredFileCount", "exposedForbiddenOperationCount", "exposedForbiddenSchemaFieldCount",
  "failedRouteCount", "failedPhaseCount", "incompletePhaseCount", "releaseBlockingFindingCount", "releaseBlockingWarningCount"
]);

export function zeroCountFindings(record: Record<string, any> = {}) : any {
  return ZERO_COUNT_FIELDS.flatMap((field?: any) : any => [
    [field, record[field]],
    [`summary.${field}`, asRecord(record.summary)[field]]
  ]
    .filter(([, value]: any[]) : any => value !== undefined)
    .filter(([, value]: any[]) : any => Number(value || 0) !== 0)
    .map(([source, value]: any[]) : any => `${source}:${Number(value || 0)}`));
}

export function liveStatusFromReport(report: Record<string, any> = {}, releaseReady: any = false) : any {
  const summary: any = asRecord(report.summary);
  if (releaseReady) return "passed";
  if (summary.liveStatus === "blocked" || summary.blocked === true || report.blocked === true) {
    return "blocked";
  }
  return "failed";
}

export function namedReportItem(report: Record<string, any> = {}, collectionName: any = "tests", namePart: any = "") : any {
  return (Array.isArray(report[collectionName]) ? report[collectionName] : []).find((item?: any) : any =>
    String(item?.name || "").includes(namePart)
  ) || {};
}

export function reportItemPassed(report: Record<string, any> = {}, collectionName: any = "tests", namePart: any = "") : any {
  return namedReportItem(report, collectionName, namePart).status === "passed";
}

export function evidenceNumberAt(item: Record<string, any> = {}, field: any = "") : any {
  return Number(asRecord(item.evidence)[field] || 0);
}

export function recordBooleanMapFindings(map: Record<string, any> = {}, prefix: any = "field") : any {
  return (Object.entries(asRecord(map)) as [string, any][])
    .filter(([, value]: any[]) : any => value !== true)
    .map(([key]: any[]) : any => `${prefix}:${key}`);
}

export function createAggregateReleaseEvidenceReadiness(input: Record<string, any> = {}) : any {
  const record: any = asRecord(input);
  const failedCommands: any = asStringArray(record.failedCommands);
  const missingEvidence: any = asStringArray(record.missingEvidence);
  const reasons: any[] = [];
  const failedCommandCount: any = record.failedCommandCount;
  const missingEvidenceCount: any = record.missingEvidenceCount;

  if (record.allCommandsExecuted !== true) {
    reasons.push("aggregate-commands-not-fully-executed");
  }
  if (!Number.isSafeInteger(failedCommandCount) || failedCommandCount < 0) {
    reasons.push("aggregate-failed-command-count-invalid");
  } else {
    if (failedCommandCount !== failedCommands.length) {
      reasons.push(`aggregate-failed-command-count-mismatch:${failedCommandCount}:${failedCommands.length}`);
    }
    if (failedCommandCount !== 0) {
      reasons.push(`aggregate-failed-command-count:${failedCommandCount}`);
    }
  }
  for (const command of failedCommands) {
    reasons.push(`aggregate-failed-command:${command}`);
  }
  if (!Number.isSafeInteger(missingEvidenceCount) || missingEvidenceCount < 0) {
    reasons.push("aggregate-missing-evidence-count-invalid");
  } else {
    if (missingEvidenceCount !== missingEvidence.length) {
      reasons.push(`aggregate-missing-evidence-count-mismatch:${missingEvidenceCount}:${missingEvidence.length}`);
    }
    if (missingEvidenceCount !== 0) {
      reasons.push(`aggregate-missing-evidence-count:${missingEvidenceCount}`);
    }
  }
  for (const evidence of missingEvidence) {
    reasons.push(`aggregate-missing-evidence:${evidence}`);
  }
  if (record.reportLeakScan !== true) {
    reasons.push("aggregate-report-leak-scan-not-passed");
  }

  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
    releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    reasons
  };
}
