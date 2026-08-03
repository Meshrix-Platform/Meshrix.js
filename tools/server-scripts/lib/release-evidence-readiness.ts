import { createUpstreamFixtureTransitReadiness } from "./upstream-fixture-transit-evidence.ts";
import { createUpstreamMcpGatewayReadiness } from "./upstream-mcp-gateway-evidence.ts";
import { createUpstreamServicePublishingReadiness } from "./upstream-service-publishing-evidence.ts";
import { createDownstreamAgentToolLoopReadiness } from "./downstream-agent-tool-loop-evidence.ts";
import { createMcpProxyTransportReadiness } from "./mcp-proxy-transport-evidence.ts";
import { createStorageProductionRestoreReadiness } from "./storage-production-restore-evidence.ts";
import { PRODUCTION_READINESS_GATES_READINESS_SOURCE, PRODUCTION_READINESS_GATES_REPORT_PATH } from "./production-readiness-gates-evidence.ts";
import {
  REQUIRED_REPORT_REDUCERS,
  REQUIRED_REPORT_VALIDATOR_SOURCE,
  requiredReportTruthBlockers,
  requiredReportSpec,
  validateRequiredReport
} from "./required-report-validator.ts";
import {
  AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
  DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
  GATEWAY_PLATFORM_PROFILE_READINESS_SOURCE,
  UPSTREAM_GATEWAY_E2E_READINESS_SOURCE,
  asRecord,
  asStringArray,
  createAggregateReleaseEvidenceReadiness,
  liveStatusFromReport,
  zeroCountFindings
} from "./release-evidence-readiness-common.ts";

export {
  AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
  DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
  GATEWAY_PLATFORM_PROFILE_READINESS_SOURCE,
  RELEASE_EVIDENCE_READINESS_SOURCE,
  UPSTREAM_GATEWAY_E2E_READINESS_SOURCE
} from "./release-evidence-readiness-common.ts";
export { createAggregateReleaseEvidenceReadiness } from "./release-evidence-readiness-common.ts";
const NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES: readonly any[] = Object.freeze([
  "root package declares the complete version-locked workspace release set",
  "release-set tarballs are source-portable and exclude host artifacts",
  "clean consumer install runs the packaged CLI",
  "installed framework starts and serves its default health contracts"
]);
const NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAME_SET: any = new Set<any>(
  NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES
);
const REPO_ORGANIZATION_POLICY_SOURCE: any =
  "tools/registry/repo-layout.registry.json#repoOrganizationAudit.sourceFileOrganization";
const REPO_ORGANIZATION_CANONICAL_DOCUMENT: any =
  "docs/architecture/ARCHITECTURE.md#source-file-organization";
export function isProductionReleaseEvidenceReport(relativePath: any = "") : any {
  const reportPath: any = String(relativePath || "");
  return reportPath === PRODUCTION_READINESS_GATES_REPORT_PATH;
}


function createScriptRegistryReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const reasons: any[] = [];
  if (Number(report.totalPackageScripts || 0) <= 0) {
    reasons.push("script-registry-empty");
  }
  if (Number(report.commandMismatchCount || 0) !== 0) {
    reasons.push("script-registry-command-mismatch");
  }
  if (Number(report.unregisteredScriptCount || 0) !== 0) {
    reasons.push("script-registry-unregistered-script");
  }
  if (Number(report.staleDeclarationCount || 0) !== 0) {
    reasons.push("script-registry-stale-declaration");
  }
  if (Number(report.duplicateDeclarationCount || 0) !== 0) {
    reasons.push("script-registry-duplicate-declaration");
  }
  if (Number(report.issueCount || 0) !== 0) {
    reasons.push("script-registry-verification-issue");
  }
  if (Number(report.packagePackFindingCount || 0) !== 0) {
    reasons.push("script-registry-package-pack-finding");
  }
  if (Number(report.releaseStrictnessFindingCount || 0) !== 0) {
    reasons.push("script-registry-release-strictness-finding");
  }
  if (Number(report.releaseSourceOfTruthFindingCount || 0) !== 0) {
    reasons.push("script-registry-release-source-of-truth-finding");
  }
  if (Number(report.releaseProfileReadinessFindingCount || 0) !== 0) {
    reasons.push("script-registry-release-profile-readiness-finding");
  }
  if (Number(report.mcpReleaseTargetSourceOfTruthFindingCount || 0) !== 0) {
    reasons.push("script-registry-mcp-release-target-source-of-truth-finding");
  }
  if (Number(report.factSourceAuthorityFindingCount || 0) !== 0) {
    reasons.push("script-registry-fact-source-authority-finding");
  }
  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    liveStatus: liveStatusFromReport(report, releaseReady),
    reasons
  };
}

function createProductionReadinessGatesReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const gates: any = Array.isArray(record.gates) ? record.gates.map(asRecord) : [];
  const gateIds: any = gates.map((gate?: any) : any => String(gate.id || ""));
  const aggregate: any = createAggregateReleaseEvidenceReadiness({
    allCommandsExecuted: summary.allGatesExecuted,
    failedCommandCount: summary.failedGateCount,
    failedCommands: asStringArray(summary.failedGates),
    missingEvidenceCount: summary.missingEvidenceCount,
    missingEvidence: asStringArray(summary.missingEvidence),
    reportLeakScan: summary.reportLeakScan
  });
  const reasons: any[] = [];
  if (record.schemaVersion !== "v0.0.1:release:production-readiness-gates-report-1") {
    reasons.push("production-gates-schema-version-mismatch");
  }
  if (record.verifier !== "tools/server-scripts/production-readiness-gate.ts") {
    reasons.push("production-gates-verifier-mismatch");
  }
  if (record.projectionOnly !== true) {
    reasons.push("production-gates-projection-boundary-missing");
  }
  if (gates.length === 0) {
    reasons.push("production-gates-empty");
  }
  if (
    gateIds.some((id?: any) : any => !id) ||
    new Set<any>(gateIds).size !== gateIds.length ||
    gates.some((gate?: any) : any => !String(gate.verifier || "").trim())
  ) {
    reasons.push("production-gates-contract-invalid");
  }
  if (Number(summary.totalGateCount || 0) !== gates.length) {
    reasons.push("production-gates-count-mismatch");
  }
  for (const reason of aggregate.reasons) {
    reasons.push(`production-gates:${reason}`);
  }
  if (typeof summary.releaseReady !== "boolean") {
    reasons.push("production-gates-release-ready-missing");
  } else if (summary.releaseReady !== aggregate.releaseReady) {
    reasons.push("production-gates-release-ready-mismatch");
  }
  const releaseReady: any = reasons.length === 0;
  const coreBlocked: any = !releaseReady && summary.allGatesExecuted === true &&
    Number(summary.failedGateCount || 0) === 0 &&
    Number(summary.missingEvidenceCount || 0) > 0 &&
    summary.blocked === true && summary.liveStatus === "blocked";
  return {
    sourceOfTruth: PRODUCTION_READINESS_GATES_READINESS_SOURCE,
    reducerSourceOfTruth: AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    readyField: "summary.releaseReady",
    coverageReady: releaseReady || coreBlocked,
    liveStatus: releaseReady ? "passed" : coreBlocked ? "blocked" : "failed",
    reasons
  };
}

function createUpstreamGatewayE2eReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const reasons: any[] = [];
  if (record.schemaVersion !== "v0.0.1:upstream-gateway:e2e-report-1") {
    reasons.push("upstream-gateway-e2e-schema-version-mismatch");
  }
  if (record.verifier !== "tools/server-scripts/verify-upstream-gateway-e2e.ts") {
    reasons.push("upstream-gateway-e2e-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("upstream-gateway-e2e-report-leak-scan-missing");
  }
  if (summary.trafficControlAlgorithm !== "token_bucket_with_concurrency") {
    reasons.push("upstream-gateway-e2e-traffic-algorithm-mismatch");
  }
  if (summary.routingAlgorithm !== "weighted_endpoint_round_robin_with_circuit_breaker") {
    reasons.push("upstream-gateway-e2e-routing-algorithm-mismatch");
  }
  if (summary.tokenBucketTrafficVerified !== true) {
    reasons.push("upstream-gateway-e2e-token-bucket-coverage-missing");
  }
  if (summary.concurrentTrafficVerified !== true) {
    reasons.push("upstream-gateway-e2e-concurrency-coverage-missing");
  }
  if (summary.serviceAggregateTrafficVerified !== true) {
    reasons.push("upstream-gateway-e2e-aggregate-service-limit-coverage-missing");
  }
  if (summary.downstreamMcpDistributionVerified !== true) {
    reasons.push("upstream-gateway-e2e-downstream-mcp-distribution-coverage-missing");
  }
  if (summary.downstreamMcpDistributionOperation !== "meshrix.gateway.forward") {
    reasons.push("upstream-gateway-e2e-downstream-mcp-distribution-operation-mismatch");
  }
  if (summary.concurrentMcpForwardingVerified !== true) {
    reasons.push("upstream-gateway-e2e-concurrent-mcp-forwarding-coverage-missing");
  }
  if (summary.releaseReady !== true) {
    reasons.push("upstream-gateway-e2e-release-ready-not-true");
  }
  if (Number(summary.failedCount || 0) !== 0) {
    reasons.push(`upstream-gateway-e2e-failed-count:${Number(summary.failedCount || 0)}`);
  }
  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: UPSTREAM_GATEWAY_E2E_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    readyField: "summary.releaseReady",
    coverageReady: releaseReady,
    liveStatus: liveStatusFromReport(record, releaseReady),
    reasons
  };
}

function createGatewayPlatformProfileReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const commandResults: any = Array.isArray(record.commands) ? record.commands : [];
  const evidence: any = asRecord(record.evidence);
  const reasons: any[] = [];
  if (record.schemaVersion !== "v0.0.1:gateway:platform-profile-report-1") {
    reasons.push("gateway-platform-profile-schema-version-mismatch");
  }
  if (record.verifier !== "tools/server-scripts/stress-gateway-platform-profile.ts") {
    reasons.push("gateway-platform-profile-verifier-mismatch");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("gateway-platform-profile-report-leak-scan-missing");
  }
  if (summary.releaseReadinessSourceOfTruth !== AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE) {
    reasons.push("gateway-platform-profile-release-readiness-source-of-truth-mismatch");
  }
  if (summary.releaseReady !== true) {
    reasons.push("gateway-platform-profile-release-ready-not-true");
  }
  if (Number(summary.failedCommandCount || 0) !== 0) {
    reasons.push(`gateway-platform-profile-failed-command-count:${Number(summary.failedCommandCount || 0)}`);
  }
  if (Number(summary.missingEvidenceCount || 0) !== 0) {
    reasons.push(`gateway-platform-profile-missing-evidence-count:${Number(summary.missingEvidenceCount || 0)}`);
  }
  if (commandResults.length === 0) {
    reasons.push("gateway-platform-profile-command-results-empty");
  }
  for (const [reportPath, entry] of (Object.entries(evidence) as [string, any][])) {
    const item: any = asRecord(entry);
    if (!String(item.sourceOfTruth || "").trim()) {
      reasons.push(`gateway-platform-profile-evidence-source-of-truth-missing:${reportPath}`);
    }
    if (!String(item.reducerSourceOfTruth || "").trim()) {
      reasons.push(`gateway-platform-profile-evidence-reducer-source-of-truth-missing:${reportPath}`);
    }
    if (item.reportLeakScan !== true) {
      reasons.push(`gateway-platform-profile-evidence-report-leak-scan-missing:${reportPath}`);
    }
  }
  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: GATEWAY_PLATFORM_PROFILE_READINESS_SOURCE,
    reducerSourceOfTruth: AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    readyField: "summary.releaseReady",
    coverageReady: releaseReady,
    liveStatus: liveStatusFromReport(record, releaseReady),
    reasons
  };
}

const READY_FIELD_READ_ORDER: readonly any[] = Object.freeze([
  ["summary.releaseReady", (record?: any) : any => asRecord(record.summary).releaseReady],
  ["releaseReady", (record?: any) : any => record.releaseReady]
]);

const PRODUCTION_READY_FIELDS: readonly any[] = Object.freeze(["productionReleaseReady", "summary.productionReleaseReady", "productionReady", "summary.productionReady"]);
const REMAINING_PRODUCTION_BLOCKER_FIELDS: readonly any[] = Object.freeze(["remainingProductionBlockers", "summary.remainingProductionBlockers"]);
const COVERAGE_READY_FIELDS: readonly any[] = Object.freeze(["coverageReady", "summary.coverageReady"]);

function valueAtPath(record?: any, path?: any) : any {
  return path.split(".").reduce((value?: any, key?: any) : any => asRecord(value)[key], record);
}

function readySignals(record: Record<string, any> = {}, readyFields: any = READY_FIELD_READ_ORDER.map(([field]: any[]) : any => field)) : any {
  return readyFields
    .map((field?: any) : any => ({ field, value: valueAtPath(record, field) }))
    .filter((item?: any) : any => typeof item.value === "boolean");
}

function chooseReadySignal(record: Record<string, any> = {}, readyFields?: any) : any {
  const signals: any = readySignals(record, readyFields);
  const truthy: any = signals.filter((item?: any) : any => item.value === true);
  const falsy: any = signals.filter((item?: any) : any => item.value === false);
  const primary: any = signals[0] || null;
  return {
    primary,
    truthy,
    falsy,
    conflict: truthy.length > 0 && falsy.length > 0
  };
}

function productionReadinessFindings(record: Record<string, any> = {}) : any {
  const findings: any[] = [];
  for (const field of PRODUCTION_READY_FIELDS) {
    if (valueAtPath(record, field) === false) {
      findings.push(`${field}:false`);
    }
  }
  for (const field of REMAINING_PRODUCTION_BLOCKER_FIELDS) {
    const blockers: any = valueAtPath(record, field);
    if (Array.isArray(blockers) && blockers.length > 0) {
      findings.push(`${field}:${blockers.length}`);
    }
  }
  return findings;
}

function coverageReadinessFindings(record: Record<string, any> = {}) : any {
  return COVERAGE_READY_FIELDS
    .filter((field?: any) : any => valueAtPath(record, field) === false)
    .map((field?: any) : any => `${field}:false`);
}

export function createNpmPackageInstallabilityReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const tests: any = Array.isArray(record.tests) ? record.tests.map(asRecord) : [];
  const testNames: any = tests.map((test?: any) : any => String(test.name || ""));
  const uniqueTestNames: any = new Set<any>(testNames);
  const actualFailedCount: any = tests.filter((test?: any) : any => test.status !== "passed").length;
  const installTest: any = tests.find(
    (test?: any) : any => test.name === NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES[2]
  ) || {};
  const installEvidence: any = asRecord(installTest.evidence);
  const serverTest: any = tests.find(
    (test?: any) : any => test.name === NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES[3]
  ) || {};
  const serverEvidence: any = asRecord(serverTest.evidence);
  const reasons: any[] = [];
  if (summary.releaseReady !== true) {
    reasons.push("npm-package-release-ready-not-true");
  }
  if (summary.freshContainer !== true || summary.supplementaryHostProbe !== false) {
    reasons.push("npm-package-fresh-container-authority-missing");
  }
  if (summary.reportLeakScan !== true) {
    reasons.push("npm-package-report-leak-scan-missing");
  }
  if (!Number.isSafeInteger(summary.testCount) || summary.testCount < 0) {
    reasons.push("npm-package-test-count-invalid");
  } else if (summary.testCount !== tests.length) {
    reasons.push(`npm-package-test-count-mismatch:${summary.testCount}:${tests.length}`);
  }
  if (!Number.isSafeInteger(summary.failedCount) || summary.failedCount < 0) {
    reasons.push("npm-package-failed-count-invalid");
  } else {
    if (summary.failedCount !== actualFailedCount) {
      reasons.push(`npm-package-failed-count-mismatch:${summary.failedCount}:${actualFailedCount}`);
    }
    if (summary.failedCount !== 0) {
      reasons.push(`npm-package-failed-count:${summary.failedCount}`);
    }
  }
  if (uniqueTestNames.size !== testNames.length) {
    reasons.push("npm-package-test-name-duplicate");
  }
  if (
    tests.length !== NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES.length ||
    testNames.some((name?: any) : any => !NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAME_SET.has(name)) ||
    NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES.some((name?: any) : any => !uniqueTestNames.has(name))
  ) {
    reasons.push("npm-package-test-name-set-mismatch");
  }
  if (actualFailedCount !== 0) {
    reasons.push(`npm-package-test-status-not-passed:${actualFailedCount}`);
  }
  for (const name of NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES) {
    const test: any = tests.find((item?: any) : any => item.name === name);
    if (test?.status !== "passed") {
      reasons.push(`npm-package-required-test-not-passed:${name}`);
    }
  }
  if (installEvidence.lockBackedRegistryMirror !== true) {
    reasons.push("npm-package-lock-backed-registry-mirror-missing");
  }
  if (installEvidence.publicServerCliHelp !== true || serverEvidence.publicServerBin !== true) {
    reasons.push("npm-package-public-server-entry-missing");
  }
  if (
    Number(installEvidence.mirroredPackageCount || 0) <= 0 ||
    Number(installEvidence.mirroredArtifactCount || 0) <= 0
  ) {
    reasons.push("npm-package-lock-backed-registry-mirror-empty");
  }
  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    readyField: "summary.releaseReady",
    coverageReady: releaseReady,
    liveStatus: liveStatusFromReport(record, releaseReady),
    reasons
  };
}

export function createDefaultReleaseEvidenceReadiness(report: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const record: any = asRecord(report);
  const relativePath: any = String(options.relativePath || options.reportPath || "");

  const reasons: any[] = [];
  if (!String(record.schemaVersion || "").trim()) {
    reasons.push("report-schema-version-missing");
  }
  if (
    !String(record.verifier || "").trim() &&
    record.sourceOfTruth === undefined &&
    record.algorithms === undefined &&
    record.matrix === undefined &&
    record.runner === undefined
  ) {
    reasons.push("report-verifier-or-source-metadata-missing");
  }
  reasons.push(...requiredReportTruthBlockers(record));
  for (const finding of productionReadinessFindings(record)) {
    reasons.push(`report-production-readiness-blocked:${finding}`);
  }
  for (const finding of coverageReadinessFindings(record)) {
    reasons.push(`report-coverage-not-ready:${finding}`);
  }
  const readySignal: any = chooseReadySignal(record, options.readyFields);
  if (!readySignal.primary) {
    reasons.push("report-ready-signal-missing");
  } else if (readySignal.primary.value !== true) {
    reasons.push(`report-ready-signal-not-true:${readySignal.primary.field}`);
  }
  if (readySignal.conflict) {
    reasons.push("report-ready-signal-conflict");
  }
  for (const finding of zeroCountFindings(record)) {
    reasons.push(`report-nonzero-count:${finding}`);
  }
  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    readyField: readySignal.primary?.field || "",
    coverageReady: valueAtPath(record, "summary.coverageReady") === true || valueAtPath(record, "coverageReady") === true,
    liveStatus: liveStatusFromReport(record, releaseReady),
    reasons
  };
}

export function createRepoOrganizationReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const policy: any = asRecord(record.policy);
  const lineCountGate: any = asRecord(policy.lineCountGate);
  const astPolicy: any = asRecord(policy.astAdvisory);
  const analysis: any = asRecord(record.sourceOrganizationAnalysis);
  const analysisSummary: any = asRecord(analysis.summary);
  const machineRules: any = Array.isArray(policy.machineEnforcedRules)
    ? policy.machineEnforcedRules.map(asRecord)
    : [];
  const reviewSignals: any = Array.isArray(policy.reviewOnlySignals)
    ? policy.reviewOnlySignals.map(asRecord)
    : [];
  const delegatedGateIds: any = asStringArray(policy.delegatedGateIds);
  const decisionBasis: any = asStringArray(policy.decisionBasis);
  const splitCandidates: any = Array.isArray(analysis.splitCandidates) ? analysis.splitCandidates.map(asRecord) : [];
  const mechanicalSplitCautions: any = Array.isArray(analysis.mechanicalSplitCautions)
    ? analysis.mechanicalSplitCautions.map(asRecord)
    : [];
  const parseFailures: any = Array.isArray(analysis.parseFailures) ? analysis.parseFailures.map(asRecord) : [];
  const unsupportedByReason: any = asRecord(analysis.unsupportedByReason);
  const baseline: any = createDefaultReleaseEvidenceReadiness(record, {
    relativePath,
    readyFields: ["summary.releaseReady"]
  });
  const reasons: any[] = [...baseline.reasons];

  if (policy.sourceOfTruth !== REPO_ORGANIZATION_POLICY_SOURCE) {
    reasons.push("repo-organization-policy-source-mismatch");
  }
  if (policy.canonicalDocument !== REPO_ORGANIZATION_CANONICAL_DOCUMENT) {
    reasons.push("repo-organization-canonical-document-mismatch");
  }
  if (
    lineCountGate.status !== "disabled" ||
    lineCountGate.threshold !== null ||
    lineCountGate.releaseBlocking !== false
  ) {
    reasons.push("repo-organization-line-count-gate-not-disabled");
  }
  if (!decisionBasis.length || new Set<any>(decisionBasis).size !== decisionBasis.length) {
    reasons.push("repo-organization-decision-basis-invalid");
  }
  const machineRuleIds: any = machineRules.map((rule?: any) : any => String(rule.id || ""));
  const reviewSignalIds: any = reviewSignals.map((signal?: any) : any => String(signal.id || ""));
  if (
    !machineRuleIds.length ||
    machineRuleIds.some((id?: any) : any => !id) ||
    new Set<any>(machineRuleIds).size !== machineRuleIds.length ||
    machineRules.some((rule?: any) : any => rule.releaseBlocking !== true)
  ) {
    reasons.push("repo-organization-machine-rules-invalid");
  }
  if (
    !reviewSignalIds.length ||
    reviewSignalIds.some((id?: any) : any => !id) ||
    new Set<any>(reviewSignalIds).size !== reviewSignalIds.length ||
    reviewSignals.some((signal?: any) : any => signal.releaseBlocking !== false || typeof signal.collectedByThisReport !== "boolean")
  ) {
    reasons.push("repo-organization-review-signals-invalid");
  }
  if (reviewSignalIds.some((id?: any) : any => machineRuleIds.includes(id))) {
    reasons.push("repo-organization-machine-review-rule-overlap");
  }
  if (!delegatedGateIds.length || new Set<any>(delegatedGateIds).size !== delegatedGateIds.length) {
    reasons.push("repo-organization-delegated-gates-invalid");
  }
  if (astPolicy.mode !== "advisory" || astPolicy.releaseBlocking !== false) {
    reasons.push("repo-organization-ast-policy-not-advisory");
  }
  if (analysis.mode !== "advisory" || analysis.releaseBlocking !== false) {
    reasons.push("repo-organization-ast-analysis-not-advisory");
  }
  if (!["completed", "unavailable"].includes(analysis.status)) {
    reasons.push("repo-organization-ast-analysis-status-invalid");
  }
  if (asRecord(analysis.engine).id !== "typescript-compiler-api") {
    reasons.push("repo-organization-ast-engine-invalid");
  }
  if (!Array.isArray(analysis.limitations) || analysis.limitations.length === 0) {
    reasons.push("repo-organization-ast-limitations-missing");
  }

  const countFields: any[] = [
    "discoveredFileCount",
    "analyzedFileCount",
    "unsupportedFileCount",
    "parseFailureCount",
    "skippedProjectionFileCount",
    "splitCandidateCount",
    "mechanicalSplitCautionCount",
    "noStructuralSignalCount",
    "durationMs"
  ];
  for (const field of countFields) {
    if (!Number.isSafeInteger(analysisSummary[field]) || analysisSummary[field] < 0) {
      reasons.push(`repo-organization-ast-count-invalid:${field}`);
    }
  }
  if (
    Number.isSafeInteger(analysisSummary.discoveredFileCount) &&
    analysisSummary.discoveredFileCount !==
      analysisSummary.analyzedFileCount + analysisSummary.unsupportedFileCount + analysisSummary.parseFailureCount
  ) {
    reasons.push("repo-organization-ast-coverage-count-mismatch");
  }
  if (
    Number.isSafeInteger(analysisSummary.analyzedFileCount) &&
    analysisSummary.analyzedFileCount !==
      analysisSummary.splitCandidateCount +
      analysisSummary.mechanicalSplitCautionCount +
      analysisSummary.noStructuralSignalCount
  ) {
    reasons.push("repo-organization-ast-classification-count-mismatch");
  }
  if (analysisSummary.splitCandidateCount !== splitCandidates.length) {
    reasons.push("repo-organization-ast-candidate-count-mismatch");
  }
  if (analysisSummary.mechanicalSplitCautionCount !== mechanicalSplitCautions.length) {
    reasons.push("repo-organization-ast-caution-count-mismatch");
  }
  if (analysisSummary.parseFailureCount !== parseFailures.length) {
    reasons.push("repo-organization-ast-parse-failure-count-mismatch");
  }
  const unsupportedReasonCount: any = (Object.values(unsupportedByReason) as any[])
    .reduce((sum?: any, value?: any) : any => sum + (Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN), 0);
  if (!Number.isSafeInteger(unsupportedReasonCount) || unsupportedReasonCount !== analysisSummary.unsupportedFileCount) {
    reasons.push("repo-organization-ast-unsupported-count-mismatch");
  }
  if (
    splitCandidates.some((finding?: any) : any => finding.releaseBlocking !== false || finding.severity !== "advisory") ||
    mechanicalSplitCautions.some((finding?: any) : any => finding.releaseBlocking !== false || finding.severity !== "advisory")
  ) {
    reasons.push("repo-organization-ast-finding-became-blocking");
  }
  if (analysis.status === "completed" && asRecord(analysis.selfTest).passed !== true) {
    reasons.push("repo-organization-ast-self-test-not-passed");
  }
  const summaryMatches: any[] = [
    ["machineEnforcedRuleCount", machineRules.length],
    ["reviewOnlySignalCount", reviewSignals.length],
    ["sourceOrganizationDiscoveredFileCount", analysisSummary.discoveredFileCount],
    ["sourceOrganizationAnalyzedFileCount", analysisSummary.analyzedFileCount],
    ["sourceOrganizationUnsupportedFileCount", analysisSummary.unsupportedFileCount],
    ["sourceOrganizationParseFailureCount", analysisSummary.parseFailureCount],
    ["sourceOrganizationSplitCandidateCount", analysisSummary.splitCandidateCount],
    ["sourceOrganizationMechanicalSplitCautionCount", analysisSummary.mechanicalSplitCautionCount]
  ];
  for (const [field, expected] of summaryMatches) {
    if (summary[field] !== expected) reasons.push(`repo-organization-summary-count-mismatch:${field}`);
  }
  if (summary.policyContractVerified !== true || summary.lineCountGateStatus !== "disabled") {
    reasons.push("repo-organization-policy-summary-invalid");
  }

  const releaseReady: any = reasons.length === 0;
  return {
    sourceOfTruth: REQUIRED_REPORT_REDUCERS.REPO_ORGANIZATION,
    report: relativePath,
    releaseReady,
    readyField: "summary.releaseReady",
    coverageReady: releaseReady,
    liveStatus: liveStatusFromReport(record, releaseReady),
    reasons
  };
}

export function createCapabilityAcceptanceReadiness(report: Record<string, any> = {}, relativePath: any = "") : any {
  const record: any = asRecord(report);
  const summary: any = asRecord(record.summary);
  const capabilities: any = Array.isArray(record.capabilities) ? record.capabilities.map(asRecord) : [];
  const blockers: any = Array.isArray(record.blockers) ? record.blockers.map(asRecord) : [];
  const findings: any = Array.isArray(record.findings) ? record.findings : [];
  const evidenceBindings: any = Array.isArray(record.evidenceBindings) ? record.evidenceBindings.map(asRecord) : [];
  const optionalEvidenceBindings: any = Array.isArray(record.optionalEvidenceBindings)
    ? record.optionalEvidenceBindings.map(asRecord)
    : [];
  const legalBlockerKinds: any = new Set<any>(["external-evidence"]);
  const legalReleaseScopes: any = new Set<any>(["core-release", "optional-support-matrix"]);
  const releaseRequiredCapabilities: any = capabilities.filter((capability?: any) : any =>
    capability.releaseScope === "core-release"
  );
  const optionalSupportMatrixCapabilities: any = capabilities.filter((capability?: any) : any =>
    capability.releaseScope === "optional-support-matrix"
  );
  const verifiedCapabilities: any = capabilities.filter((capability?: any) : any => capability.currentState === "verified");
  const blockedCapabilities: any = capabilities.filter((capability?: any) : any => capability.currentState === "blocked");
  const failedCapabilities: any = capabilities.filter((capability?: any) : any => capability.currentState === "failed");
  const disabledCapabilities: any = capabilities.filter((capability?: any) : any => capability.currentState === "disabled");
  const reasons: any[] = [];

  if (!new Set<any>(["verified", "blocked", "failed"]).has(record.currentState)) {
    reasons.push("capability-acceptance-current-state-invalid");
  }
  for (const [field, actual] of [
    ["capabilityCount", capabilities.length],
    ["readyForReleaseReductionCount", verifiedCapabilities.length],
    ["blockedCapabilityCount", blockedCapabilities.length],
    ["failedCapabilityCount", failedCapabilities.length],
    ["disabledCapabilityCount", disabledCapabilities.length],
    ["notReadyCapabilityCount", capabilities.length - verifiedCapabilities.length],
    ["blockerCount", blockers.length],
    ["evidenceBindingCount", evidenceBindings.length],
    ["optionalEvidenceBindingCount", optionalEvidenceBindings.length],
    ["releaseRequiredCapabilityCount", releaseRequiredCapabilities.length],
    ["optionalSupportMatrixCapabilityCount", optionalSupportMatrixCapabilities.length],
    ["releaseRequiredReadyCount", releaseRequiredCapabilities.filter((capability?: any) : any =>
      capability.currentState === "verified").length],
    ["releaseRequiredNotReadyCount", releaseRequiredCapabilities.filter((capability?: any) : any =>
      capability.currentState !== "verified").length],
    ["optionalSupportMatrixNotReadyCount", optionalSupportMatrixCapabilities.filter((capability?: any) : any =>
      capability.currentState !== "verified").length]
  ]) {
    if (Number(summary[field]) !== actual) {
      reasons.push(`capability-acceptance-summary-count-mismatch:${field}`);
    }
  }
  if (record.blocked !== (record.currentState === "blocked") || summary.blocked !== record.blocked) {
    reasons.push("capability-acceptance-blocked-flag-mismatch");
  }
  if (summary.readyForReleaseReduction !== record.readyForReleaseReduction) {
    reasons.push("capability-acceptance-ready-flag-mismatch");
  }
  if (capabilities.some((capability?: any) : any => !legalReleaseScopes.has(String(capability.releaseScope || "")))) {
    reasons.push("capability-acceptance-release-scope-invalid");
  }
  if (capabilities.some((capability?: any) : any =>
    !new Set<any>(["core", "detachable-core", "external-plugin"]).has(String(capability.capabilityClass || "")) ||
    !new Set<any>(["verified", "blocked", "failed", "disabled"]).has(String(capability.currentState || "")) ||
    (capability.currentState === "disabled" &&
      (capability.enabled !== false || capability.releaseScope !== "optional-support-matrix")) ||
    (capability.enabled === true && capability.capabilityClass !== "external-plugin" &&
      capability.releaseScope !== "core-release") ||
    (capability.enabled === true && capability.capabilityClass === "detachable-core" &&
      (capability.governedEvidenceComplete !== true ||
        Number(capability.functionalEvidenceBindingCount || 0) <= 0 ||
        Number(capability.governedEvidenceBindingCount || 0) <= 0))
  )) {
    reasons.push("capability-acceptance-capability-boundary-invalid");
  }
  const bindingKeys: any = new Set<any>();
  const capabilityIds: any = new Set<any>(capabilities.map((capability?: any) : any => String(capability.capabilityId || "")));
  const releaseRequiredCapabilityIds: any = new Set<any>(releaseRequiredCapabilities.map((capability?: any) : any =>
    String(capability.capabilityId || "")
  ));
  const optionalSupportMatrixCapabilityIds: any = new Set<any>(optionalSupportMatrixCapabilities.map((capability?: any) : any =>
    String(capability.capabilityId || "")
  ));
  for (const [bindingScope, bindings, allowedCapabilityIds] of [
    ["core", evidenceBindings, releaseRequiredCapabilityIds],
    ["optional", optionalEvidenceBindings, optionalSupportMatrixCapabilityIds]
  ]) {
    for (const binding of bindings) {
      const bindingKey: any = JSON.stringify(binding);
      if (bindingKeys.has(bindingKey)) {
        reasons.push("capability-acceptance-evidence-binding-duplicate");
      }
      bindingKeys.add(bindingKey);
      if (!capabilityIds.has(String(binding.capabilityId || "")) ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(binding.acceptanceCommandId || "")) ||
          (binding.report && !/^build\/reports\/[A-Za-z0-9._/-]+\.json$/u.test(String(binding.report)))) {
        reasons.push("capability-acceptance-evidence-binding-invalid");
      }
      if (!allowedCapabilityIds.has(String(binding.capabilityId || ""))) {
        reasons.push(`capability-acceptance-${bindingScope}-evidence-binding-scope-invalid`);
      }
    }
  }
  if (evidenceBindings.length === 0) {
    reasons.push("capability-acceptance-evidence-bindings-empty");
  }
  if (record.currentState === "verified") {
    const blockedOptionalCapabilityIds: any = new Set<any>(optionalSupportMatrixCapabilities
      .filter((capability?: any) : any => capability.currentState === "blocked")
      .map((capability?: any) : any => String(capability.capabilityId || "")));
    const optionalBlockersValid: any = blockers.every((blocker?: any) : any =>
      blockedOptionalCapabilityIds.has(String(blocker.capabilityId || "")) &&
      legalBlockerKinds.has(String(blocker.kind || ""))
    ) && [...blockedOptionalCapabilityIds].every((capabilityId?: any) : any =>
      blockers.some((blocker?: any) : any => String(blocker.capabilityId || "") === capabilityId)
    );
    if (record.readyForReleaseReduction !== true || findings.length !== 0 ||
        releaseRequiredCapabilities.some((capability?: any) : any => capability.currentState !== "verified") ||
        optionalSupportMatrixCapabilities.some((capability?: any) : any =>
          !["verified", "blocked", "disabled"].includes(String(capability.currentState || ""))
        ) || !optionalBlockersValid) {
      reasons.push("capability-acceptance-verified-state-inconsistent");
    }
  } else if (record.currentState === "blocked") {
    const blockedReleaseRequiredCapabilityIds: any = new Set<any>(releaseRequiredCapabilities
      .filter((capability?: any) : any => capability.currentState === "blocked")
      .map((capability?: any) : any => String(capability.capabilityId || "")));
    if (record.readyForReleaseReduction !== false || findings.length !== 0 || failedCapabilities.length !== 0 ||
        blockedReleaseRequiredCapabilityIds.size === 0 || blockers.length === 0 ||
        blockers.some((blocker?: any) : any =>
          !legalBlockerKinds.has(String(blocker.kind || "")) ||
          !capabilityIds.has(String(blocker.capabilityId || ""))
        )) {
      reasons.push("capability-acceptance-blocked-state-inconsistent");
    }
  } else if (record.currentState === "failed" && record.readyForReleaseReduction !== false) {
    reasons.push("capability-acceptance-failed-state-inconsistent");
  }

  const structurallyValid: any = reasons.length === 0;
  const releaseReady: any = structurallyValid && record.currentState === "verified";
  if (structurallyValid && record.currentState === "blocked") {
    reasons.push("capability-acceptance-legally-blocked");
  } else if (structurallyValid && record.currentState === "failed") {
    reasons.push("capability-acceptance-failed");
  }
  return {
    sourceOfTruth: REQUIRED_REPORT_REDUCERS.CAPABILITY_ACCEPTANCE,
    report: relativePath,
    releaseReady,
    readyField: "readyForReleaseReduction",
    coverageReady: structurallyValid && ["verified", "blocked"].includes(record.currentState),
    liveStatus: structurallyValid && record.currentState === "blocked" ? "blocked" : releaseReady ? "passed" : "failed",
    reasons
  };
}

export function createReleaseEvidenceReadiness(relativePath?: any, report: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  const reportPath: any = String(relativePath || "");
  const validation: any = validateRequiredReport(reportPath, report, {
    minimumTimestampMs: options.minimumTimestampMs,
    nowMs: options.nowMs,
    maximumFutureSkewMs: options.maximumFutureSkewMs,
    expectedReleaseEvidenceProvenance: options.expectedReleaseEvidenceProvenance
  });
  const spec: any = requiredReportSpec(reportPath);
  if (!validation.accepted || !validation.report || !spec) {
    return {
      sourceOfTruth: REQUIRED_REPORT_VALIDATOR_SOURCE,
      reducerSourceOfTruth: validation.reducer || "",
      report: reportPath,
      releaseReady: false,
      readyField: validation.readyField || "",
      coverageReady: false,
      liveStatus: "failed",
      reportLeakScan: false,
      requiredReportValidationPassed: false,
      requiredReportValidationSourceOfTruth: validation.sourceOfTruth,
      requiredReportSpecSourceOfTruth: validation.specSourceOfTruth,
      reasons: validation.reasons || ["required-report-validation-failed"]
    };
  }

  const record: any = validation.report;
  let readiness: any;
  switch (spec.reducer) {
    case REQUIRED_REPORT_REDUCERS.REPO_ORGANIZATION:
      readiness = createRepoOrganizationReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.CAPABILITY_ACCEPTANCE:
      readiness = createCapabilityAcceptanceReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.UPSTREAM_GATEWAY_E2E:
      readiness = createUpstreamGatewayE2eReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.GATEWAY_PLATFORM_PROFILE:
      readiness = createGatewayPlatformProfileReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.PRODUCTION_GATES:
      readiness = createProductionReadinessGatesReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.UPSTREAM_FIXTURE_TRANSIT:
      readiness = createUpstreamFixtureTransitReadiness(record);
      break;
    case REQUIRED_REPORT_REDUCERS.UPSTREAM_MCP_GATEWAY:
      readiness = createUpstreamMcpGatewayReadiness(record);
      break;
    case REQUIRED_REPORT_REDUCERS.UPSTREAM_SERVICE_PUBLISHING:
      readiness = createUpstreamServicePublishingReadiness(record, options);
      break;
    case REQUIRED_REPORT_REDUCERS.DOWNSTREAM_AGENT_TOOL_LOOP:
      readiness = createDownstreamAgentToolLoopReadiness(record);
      break;
    case REQUIRED_REPORT_REDUCERS.MCP_PROXY_TRANSPORT:
      readiness = createMcpProxyTransportReadiness(record);
      break;
    case REQUIRED_REPORT_REDUCERS.NPM_PACKAGE_INSTALLABILITY:
      readiness = createNpmPackageInstallabilityReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.STORAGE_PRODUCTION_RESTORE:
      readiness = createStorageProductionRestoreReadiness(record);
      break;
    case REQUIRED_REPORT_REDUCERS.SCRIPT_REGISTRY:
      readiness = createScriptRegistryReadiness(record, reportPath);
      break;
    case REQUIRED_REPORT_REDUCERS.DEFAULT:
      readiness = createDefaultReleaseEvidenceReadiness(record, {
        ...options,
        relativePath: reportPath,
        readyFields: spec.readyFields
      });
      break;
    default:
      return {
        sourceOfTruth: REQUIRED_REPORT_VALIDATOR_SOURCE,
        reducerSourceOfTruth: spec.reducer,
        report: reportPath,
        releaseReady: false,
        readyField: "",
        coverageReady: false,
        liveStatus: "failed",
        reportLeakScan: false,
        requiredReportValidationPassed: false,
        requiredReportValidationSourceOfTruth: validation.sourceOfTruth,
        requiredReportSpecSourceOfTruth: validation.specSourceOfTruth,
        reasons: ["required-report-reducer-unregistered"]
      };
  }

  return {
    ...readiness,
    report: reportPath,
    reducerSourceOfTruth: readiness.reducerSourceOfTruth || spec.reducer,
    reportLeakScan: validation.reportLeakScan === true,
    requiredReportValidationPassed: true,
    requiredReportValidationSourceOfTruth: validation.sourceOfTruth,
    requiredReportSpecSourceOfTruth: validation.specSourceOfTruth
  };
}

export function releaseEvidenceReady(relativePath?: any, report: Record<string, any> = {}, options: Record<string, any> = {}) : any {
  return createReleaseEvidenceReadiness(relativePath, report, options).releaseReady === true;
}
