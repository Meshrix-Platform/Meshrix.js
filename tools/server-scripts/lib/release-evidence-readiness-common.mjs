export const RELEASE_EVIDENCE_READINESS_SOURCE =
  "tools/server-scripts/lib/release-evidence-readiness.mjs#createReleaseEvidenceReadiness";
export const DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE =
  "tools/server-scripts/lib/release-evidence-readiness.mjs#createDefaultReleaseEvidenceReadiness";
export const AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE =
  "tools/server-scripts/lib/release-evidence-readiness.mjs#createAggregateReleaseEvidenceReadiness";
export const UPSTREAM_GATEWAY_E2E_READINESS_SOURCE =
  "tools/server-scripts/lib/release-evidence-readiness.mjs#createUpstreamGatewayE2eReadiness";
export const GATEWAY_PLATFORM_PROFILE_READINESS_SOURCE =
  "tools/server-scripts/lib/release-evidence-readiness.mjs#createGatewayPlatformProfileReadiness";

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

export function stringListKey(values) {
  return JSON.stringify((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort());
}

const ZERO_COUNT_FIELDS = Object.freeze([
  "failedCount", "failed", "failedCommandCount", "criticalFindings", "missingEvidenceCount",
  "deploymentFailedCommandCount", "deploymentMissingEvidenceCount", "failingOperationCount",
  "missingRuntimeEvidenceCount", "missingEndpointCount", "unmappedOperationCount", "missingDimensionCount",
  "missingRealMetricFamilyCount", "missingTraceEvidenceCount", "remainingProductionBlockerCount",
  "errorCount", "missingRequiredFileCount", "exposedForbiddenOperationCount", "exposedForbiddenSchemaFieldCount",
  "failedRouteCount", "failedPhaseCount", "incompletePhaseCount", "releaseBlockingFindingCount", "releaseBlockingWarningCount"
]);

export function zeroCountFindings(record = {}) {
  return ZERO_COUNT_FIELDS.flatMap((field) => [
    [field, record[field]],
    [`summary.${field}`, asRecord(record.summary)[field]]
  ]
    .filter(([, value]) => value !== undefined)
    .filter(([, value]) => Number(value || 0) !== 0)
    .map(([source, value]) => `${source}:${Number(value || 0)}`));
}

export function liveStatusFromReport(report = {}, releaseReady = false) {
  const summary = asRecord(report.summary);
  if (releaseReady) return "passed";
  if (summary.liveStatus === "blocked" || summary.blocked === true || report.blocked === true) {
    return "blocked";
  }
  return "failed";
}

export function namedReportItem(report = {}, collectionName = "tests", namePart = "") {
  return (Array.isArray(report[collectionName]) ? report[collectionName] : []).find((item) =>
    String(item?.name || "").includes(namePart)
  ) || {};
}

export function reportItemPassed(report = {}, collectionName = "tests", namePart = "") {
  return namedReportItem(report, collectionName, namePart).status === "passed";
}

export function evidenceNumberAt(item = {}, field = "") {
  return Number(asRecord(item.evidence)[field] || 0);
}

export function recordBooleanMapFindings(map = {}, prefix = "field") {
  return Object.entries(asRecord(map))
    .filter(([, value]) => value !== true)
    .map(([key]) => `${prefix}:${key}`);
}

export function createAggregateReleaseEvidenceReadiness(input = {}) {
  const record = asRecord(input);
  const failedCommands = asStringArray(record.failedCommands);
  const missingEvidence = asStringArray(record.missingEvidence);
  const reasons = [];
  const failedCommandCount = record.failedCommandCount;
  const missingEvidenceCount = record.missingEvidenceCount;

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

  const releaseReady = reasons.length === 0;
  return {
    sourceOfTruth: AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
    releaseReady,
    liveStatus: releaseReady ? "passed" : "failed",
    reasons
  };
}
