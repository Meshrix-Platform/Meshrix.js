import { createUpstreamFixtureTransitReadiness } from "./upstream-fixture-transit-evidence.mjs";
import { createUpstreamMcpGatewayReadiness } from "./upstream-mcp-gateway-evidence.mjs";
import { createUpstreamServicePublishingReadiness } from "./upstream-service-publishing-evidence.mjs";
import { createDownstreamAgentToolLoopReadiness } from "./downstream-agent-tool-loop-evidence.mjs";
import { createMcpProcessIdentityCredentialStoreReadiness } from "./mcp-process-identity-credential-store-evidence.mjs";
import { createMcpProxyTransportReadiness } from "./mcp-proxy-transport-evidence.mjs";
import { createStorageProductionRestoreReadiness } from "./storage-production-restore-evidence.mjs";
import { PRODUCTION_READINESS_GATES_READINESS_SOURCE, PRODUCTION_READINESS_GATES_REPORT_PATH } from "./production-readiness-gates-evidence.mjs";
import {
  REQUIRED_REPORT_REDUCERS,
  REQUIRED_REPORT_VALIDATOR_SOURCE,
  requiredReportSpec,
  validateRequiredReport
} from "./required-report-validator.mjs";
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
} from "./release-evidence-readiness-common.mjs";

export {
  AGGREGATE_RELEASE_EVIDENCE_READINESS_SOURCE,
  DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
  GATEWAY_PLATFORM_PROFILE_READINESS_SOURCE,
  RELEASE_EVIDENCE_READINESS_SOURCE,
  UPSTREAM_GATEWAY_E2E_READINESS_SOURCE
} from "./release-evidence-readiness-common.mjs";
export { createAggregateReleaseEvidenceReadiness } from "./release-evidence-readiness-common.mjs";
const NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES = Object.freeze([
  "root package declares the complete version-locked workspace release set",
  "release-set tarballs are source-portable and exclude host artifacts",
  "clean consumer install runs the packaged CLI",
  "installed framework starts and serves its default health contracts"
]);
const NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAME_SET = new Set(
  NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES
);
const REPO_ORGANIZATION_POLICY_SOURCE =
  "tools/registry/repo-layout.registry.json#repoOrganizationAudit.sourceFileOrganization";
const REPO_ORGANIZATION_CANONICAL_DOCUMENT =
  "docs/architecture/ARCHITECTURE.md#source-file-organization";
export function isProductionReleaseEvidenceReport(relativePath = "") {
  const reportPath = String(relativePath || "");
  return reportPath === PRODUCTION_READINESS_GATES_REPORT_PATH;
}


function createScriptRegistryReadiness(report = {}, relativePath = "") {
  const reasons = [];
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
  const releaseReady = reasons.length === 0;
  return {
    sourceOfTruth: DEFAULT_RELEASE_EVIDENCE_READINESS_SOURCE,
    report: relativePath,
    releaseReady,
    liveStatus: liveStatusFromReport(report, releaseReady),
    reasons
  };
}

function createProductionReadinessGatesReadiness(report = {}, relativePath = "") {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const gates = Array.isArray(record.gates) ? record.gates.map(asRecord) : [];
  const gateIds = gates.map((gate) => String(gate.id || ""));
  const aggregate = createAggregateReleaseEvidenceReadiness({
    allCommandsExecuted: summary.allGatesExecuted,
    failedCommandCount: summary.failedGateCount,
    failedCommands: asStringArray(summary.failedGates),
    missingEvidenceCount: summary.missingEvidenceCount,
    missingEvidence: asStringArray(summary.missingEvidence),
    reportLeakScan: summary.reportLeakScan
  });
  const reasons = [];
  if (record.schemaVersion !== "v0.0.1:release:production-readiness-gates-report-1") {
    reasons.push("production-gates-schema-version-mismatch");
  }
  if (record.verifier !== "tools/server-scripts/production-readiness-gate.mjs") {
    reasons.push("production-gates-verifier-mismatch");
  }
  if (record.projectionOnly !== true) {
    reasons.push("production-gates-projection-boundary-missing");
  }
  if (gates.length === 0) {
    reasons.push("production-gates-empty");
  }
  if (
    gateIds.some((id) => !id) ||
    new Set(gateIds).size !== gateIds.length ||
    gates.some((gate) => !String(gate.verifier || "").trim())
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
  const releaseReady = reasons.length === 0;
  const coreBlocked = !releaseReady && summary.allGatesExecuted === true &&
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

function createUpstreamGatewayE2eReadiness(report = {}, relativePath = "") {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const reasons = [];
  if (record.schemaVersion !== "v0.0.1:upstream-gateway:e2e-report-1") {
    reasons.push("upstream-gateway-e2e-schema-version-mismatch");
  }
  if (record.verifier !== "tools/server-scripts/verify-upstream-gateway-e2e.mjs") {
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
  const releaseReady = reasons.length === 0;
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

function createGatewayPlatformProfileReadiness(report = {}, relativePath = "") {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const commandResults = Array.isArray(record.commands) ? record.commands : [];
  const evidence = asRecord(record.evidence);
  const reasons = [];
  if (record.schemaVersion !== "v0.0.1:gateway:platform-profile-report-1") {
    reasons.push("gateway-platform-profile-schema-version-mismatch");
  }
  if (record.verifier !== "tools/server-scripts/stress-gateway-platform-profile.mjs") {
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
  for (const [reportPath, entry] of Object.entries(evidence)) {
    const item = asRecord(entry);
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
  const releaseReady = reasons.length === 0;
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

const READY_FIELD_READ_ORDER = Object.freeze([
  ["summary.releaseReady", (record) => asRecord(record.summary).releaseReady],
  ["releaseReady", (record) => record.releaseReady]
]);

const PRODUCTION_READY_FIELDS = Object.freeze(["productionReleaseReady", "summary.productionReleaseReady", "productionReady", "summary.productionReady"]);
const REMAINING_PRODUCTION_BLOCKER_FIELDS = Object.freeze(["remainingProductionBlockers", "summary.remainingProductionBlockers"]);
const COVERAGE_READY_FIELDS = Object.freeze(["coverageReady", "summary.coverageReady"]);

function valueAtPath(record, path) {
  return path.split(".").reduce((value, key) => asRecord(value)[key], record);
}

function readySignals(record = {}, readyFields = READY_FIELD_READ_ORDER.map(([field]) => field)) {
  return readyFields
    .map((field) => ({ field, value: valueAtPath(record, field) }))
    .filter((item) => typeof item.value === "boolean");
}

function chooseReadySignal(record = {}, readyFields) {
  const signals = readySignals(record, readyFields);
  const truthy = signals.filter((item) => item.value === true);
  const falsy = signals.filter((item) => item.value === false);
  const primary = signals[0] || null;
  return {
    primary,
    truthy,
    falsy,
    conflict: truthy.length > 0 && falsy.length > 0
  };
}

function productionReadinessFindings(record = {}) {
  const findings = [];
  for (const field of PRODUCTION_READY_FIELDS) {
    if (valueAtPath(record, field) === false) {
      findings.push(`${field}:false`);
    }
  }
  for (const field of REMAINING_PRODUCTION_BLOCKER_FIELDS) {
    const blockers = valueAtPath(record, field);
    if (Array.isArray(blockers) && blockers.length > 0) {
      findings.push(`${field}:${blockers.length}`);
    }
  }
  return findings;
}

function coverageReadinessFindings(record = {}) {
  return COVERAGE_READY_FIELDS
    .filter((field) => valueAtPath(record, field) === false)
    .map((field) => `${field}:false`);
}

export function createNpmPackageInstallabilityReadiness(report = {}, relativePath = "") {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const tests = Array.isArray(record.tests) ? record.tests.map(asRecord) : [];
  const testNames = tests.map((test) => String(test.name || ""));
  const uniqueTestNames = new Set(testNames);
  const actualFailedCount = tests.filter((test) => test.status !== "passed").length;
  const installTest = tests.find(
    (test) => test.name === NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES[2]
  ) || {};
  const installEvidence = asRecord(installTest.evidence);
  const serverTest = tests.find(
    (test) => test.name === NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES[3]
  ) || {};
  const serverEvidence = asRecord(serverTest.evidence);
  const reasons = [];
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
    testNames.some((name) => !NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAME_SET.has(name)) ||
    NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES.some((name) => !uniqueTestNames.has(name))
  ) {
    reasons.push("npm-package-test-name-set-mismatch");
  }
  if (actualFailedCount !== 0) {
    reasons.push(`npm-package-test-status-not-passed:${actualFailedCount}`);
  }
  for (const name of NPM_PACKAGE_INSTALLABILITY_REQUIRED_TEST_NAMES) {
    const test = tests.find((item) => item.name === name);
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
  const releaseReady = reasons.length === 0;
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

export function createDefaultReleaseEvidenceReadiness(report = {}, options = {}) {
  const record = asRecord(report);
  const relativePath = String(options.relativePath || options.reportPath || "");

  const reasons = [];
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
  for (const finding of productionReadinessFindings(record)) {
    reasons.push(`report-production-readiness-blocked:${finding}`);
  }
  for (const finding of coverageReadinessFindings(record)) {
    reasons.push(`report-coverage-not-ready:${finding}`);
  }
  const readySignal = chooseReadySignal(record, options.readyFields);
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
  const releaseReady = reasons.length === 0;
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

export function createRepoOrganizationReadiness(report = {}, relativePath = "") {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const policy = asRecord(record.policy);
  const lineCountGate = asRecord(policy.lineCountGate);
  const astPolicy = asRecord(policy.astAdvisory);
  const analysis = asRecord(record.sourceOrganizationAnalysis);
  const analysisSummary = asRecord(analysis.summary);
  const machineRules = Array.isArray(policy.machineEnforcedRules)
    ? policy.machineEnforcedRules.map(asRecord)
    : [];
  const reviewSignals = Array.isArray(policy.reviewOnlySignals)
    ? policy.reviewOnlySignals.map(asRecord)
    : [];
  const delegatedGateIds = asStringArray(policy.delegatedGateIds);
  const decisionBasis = asStringArray(policy.decisionBasis);
  const splitCandidates = Array.isArray(analysis.splitCandidates) ? analysis.splitCandidates.map(asRecord) : [];
  const mechanicalSplitCautions = Array.isArray(analysis.mechanicalSplitCautions)
    ? analysis.mechanicalSplitCautions.map(asRecord)
    : [];
  const parseFailures = Array.isArray(analysis.parseFailures) ? analysis.parseFailures.map(asRecord) : [];
  const unsupportedByReason = asRecord(analysis.unsupportedByReason);
  const baseline = createDefaultReleaseEvidenceReadiness(record, {
    relativePath,
    readyFields: ["summary.releaseReady"]
  });
  const reasons = [...baseline.reasons];

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
  if (!decisionBasis.length || new Set(decisionBasis).size !== decisionBasis.length) {
    reasons.push("repo-organization-decision-basis-invalid");
  }
  const machineRuleIds = machineRules.map((rule) => String(rule.id || ""));
  const reviewSignalIds = reviewSignals.map((signal) => String(signal.id || ""));
  if (
    !machineRuleIds.length ||
    machineRuleIds.some((id) => !id) ||
    new Set(machineRuleIds).size !== machineRuleIds.length ||
    machineRules.some((rule) => rule.releaseBlocking !== true)
  ) {
    reasons.push("repo-organization-machine-rules-invalid");
  }
  if (
    !reviewSignalIds.length ||
    reviewSignalIds.some((id) => !id) ||
    new Set(reviewSignalIds).size !== reviewSignalIds.length ||
    reviewSignals.some((signal) => signal.releaseBlocking !== false || typeof signal.collectedByThisReport !== "boolean")
  ) {
    reasons.push("repo-organization-review-signals-invalid");
  }
  if (reviewSignalIds.some((id) => machineRuleIds.includes(id))) {
    reasons.push("repo-organization-machine-review-rule-overlap");
  }
  if (!delegatedGateIds.length || new Set(delegatedGateIds).size !== delegatedGateIds.length) {
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

  const countFields = [
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
  const unsupportedReasonCount = Object.values(unsupportedByReason)
    .reduce((sum, value) => sum + (Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN), 0);
  if (!Number.isSafeInteger(unsupportedReasonCount) || unsupportedReasonCount !== analysisSummary.unsupportedFileCount) {
    reasons.push("repo-organization-ast-unsupported-count-mismatch");
  }
  if (
    splitCandidates.some((finding) => finding.releaseBlocking !== false || finding.severity !== "advisory") ||
    mechanicalSplitCautions.some((finding) => finding.releaseBlocking !== false || finding.severity !== "advisory")
  ) {
    reasons.push("repo-organization-ast-finding-became-blocking");
  }
  if (analysis.status === "completed" && asRecord(analysis.selfTest).passed !== true) {
    reasons.push("repo-organization-ast-self-test-not-passed");
  }
  const summaryMatches = [
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

  const releaseReady = reasons.length === 0;
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

export function createCapabilityAcceptanceReadiness(report = {}, relativePath = "") {
  const record = asRecord(report);
  const summary = asRecord(record.summary);
  const capabilities = Array.isArray(record.capabilities) ? record.capabilities.map(asRecord) : [];
  const blockers = Array.isArray(record.blockers) ? record.blockers.map(asRecord) : [];
  const findings = Array.isArray(record.findings) ? record.findings : [];
  const evidenceBindings = Array.isArray(record.evidenceBindings) ? record.evidenceBindings.map(asRecord) : [];
  const optionalEvidenceBindings = Array.isArray(record.optionalEvidenceBindings)
    ? record.optionalEvidenceBindings.map(asRecord)
    : [];
  const legalBlockerKinds = new Set(["external-evidence"]);
  const legalReleaseScopes = new Set(["core-release", "optional-support-matrix"]);
  const releaseRequiredCapabilities = capabilities.filter((capability) =>
    capability.releaseScope === "core-release"
  );
  const optionalSupportMatrixCapabilities = capabilities.filter((capability) =>
    capability.releaseScope === "optional-support-matrix"
  );
  const verifiedCapabilities = capabilities.filter((capability) => capability.currentState === "verified");
  const blockedCapabilities = capabilities.filter((capability) => capability.currentState === "blocked");
  const failedCapabilities = capabilities.filter((capability) => capability.currentState === "failed");
  const reasons = [];

  if (!new Set(["verified", "blocked", "failed"]).has(record.currentState)) {
    reasons.push("capability-acceptance-current-state-invalid");
  }
  for (const [field, actual] of [
    ["capabilityCount", capabilities.length],
    ["readyForReleaseReductionCount", verifiedCapabilities.length],
    ["blockedCapabilityCount", blockedCapabilities.length],
    ["failedCapabilityCount", failedCapabilities.length],
    ["notReadyCapabilityCount", capabilities.length - verifiedCapabilities.length],
    ["blockerCount", blockers.length],
    ["evidenceBindingCount", evidenceBindings.length],
    ["optionalEvidenceBindingCount", optionalEvidenceBindings.length],
    ["releaseRequiredCapabilityCount", releaseRequiredCapabilities.length],
    ["optionalSupportMatrixCapabilityCount", optionalSupportMatrixCapabilities.length],
    ["releaseRequiredReadyCount", releaseRequiredCapabilities.filter((capability) =>
      capability.currentState === "verified").length],
    ["releaseRequiredNotReadyCount", releaseRequiredCapabilities.filter((capability) =>
      capability.currentState !== "verified").length],
    ["optionalSupportMatrixNotReadyCount", optionalSupportMatrixCapabilities.filter((capability) =>
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
  if (capabilities.some((capability) => !legalReleaseScopes.has(String(capability.releaseScope || "")))) {
    reasons.push("capability-acceptance-release-scope-invalid");
  }
  const bindingKeys = new Set();
  const capabilityIds = new Set(capabilities.map((capability) => String(capability.capabilityId || "")));
  const releaseRequiredCapabilityIds = new Set(releaseRequiredCapabilities.map((capability) =>
    String(capability.capabilityId || "")
  ));
  const optionalSupportMatrixCapabilityIds = new Set(optionalSupportMatrixCapabilities.map((capability) =>
    String(capability.capabilityId || "")
  ));
  for (const [bindingScope, bindings, allowedCapabilityIds] of [
    ["core", evidenceBindings, releaseRequiredCapabilityIds],
    ["optional", optionalEvidenceBindings, optionalSupportMatrixCapabilityIds]
  ]) {
    for (const binding of bindings) {
      const bindingKey = JSON.stringify(binding);
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
    const blockedOptionalCapabilityIds = new Set(optionalSupportMatrixCapabilities
      .filter((capability) => capability.currentState === "blocked")
      .map((capability) => String(capability.capabilityId || "")));
    const optionalBlockersValid = blockers.every((blocker) =>
      blockedOptionalCapabilityIds.has(String(blocker.capabilityId || "")) &&
      legalBlockerKinds.has(String(blocker.kind || ""))
    ) && [...blockedOptionalCapabilityIds].every((capabilityId) =>
      blockers.some((blocker) => String(blocker.capabilityId || "") === capabilityId)
    );
    if (record.readyForReleaseReduction !== true || findings.length !== 0 ||
        releaseRequiredCapabilities.some((capability) => capability.currentState !== "verified") ||
        optionalSupportMatrixCapabilities.some((capability) =>
          !["verified", "blocked"].includes(String(capability.currentState || ""))
        ) || !optionalBlockersValid) {
      reasons.push("capability-acceptance-verified-state-inconsistent");
    }
  } else if (record.currentState === "blocked") {
    const blockedReleaseRequiredCapabilityIds = new Set(releaseRequiredCapabilities
      .filter((capability) => capability.currentState === "blocked")
      .map((capability) => String(capability.capabilityId || "")));
    if (record.readyForReleaseReduction !== false || findings.length !== 0 || failedCapabilities.length !== 0 ||
        blockedReleaseRequiredCapabilityIds.size === 0 || blockers.length === 0 ||
        blockers.some((blocker) =>
          !legalBlockerKinds.has(String(blocker.kind || "")) ||
          !capabilityIds.has(String(blocker.capabilityId || ""))
        )) {
      reasons.push("capability-acceptance-blocked-state-inconsistent");
    }
  } else if (record.currentState === "failed" && record.readyForReleaseReduction !== false) {
    reasons.push("capability-acceptance-failed-state-inconsistent");
  }

  const structurallyValid = reasons.length === 0;
  const releaseReady = structurallyValid && record.currentState === "verified";
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

export function createReleaseEvidenceReadiness(relativePath, report = {}, options = {}) {
  const reportPath = String(relativePath || "");
  const validation = validateRequiredReport(reportPath, report, {
    minimumTimestampMs: options.minimumTimestampMs,
    nowMs: options.nowMs,
    maximumFutureSkewMs: options.maximumFutureSkewMs,
    expectedReleaseEvidenceProvenance: options.expectedReleaseEvidenceProvenance
  });
  const spec = requiredReportSpec(reportPath);
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

  const record = validation.report;
  let readiness;
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
    case REQUIRED_REPORT_REDUCERS.MCP_PROCESS_IDENTITY_CREDENTIAL_STORE:
      readiness = createMcpProcessIdentityCredentialStoreReadiness(record, options);
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

export function releaseEvidenceReady(relativePath, report = {}, options = {}) {
  return createReleaseEvidenceReadiness(relativePath, report, options).releaseReady === true;
}
