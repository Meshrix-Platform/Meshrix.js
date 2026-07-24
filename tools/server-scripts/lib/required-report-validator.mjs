import {
  assertNoSensitiveReportLeak,
  assertReportProvenance
} from "./sensitive-report-scan.mjs";
import {
  reportPayloadDigest
} from "../../../packages/foundation/src/observability/sensitive-report-scan.mjs";

export const REQUIRED_REPORT_VALIDATOR_SOURCE =
  "tools/server-scripts/lib/required-report-validator.mjs#validateRequiredReport";
export const REQUIRED_REPORT_SPEC_REGISTRY_SOURCE =
  "tools/server-scripts/lib/required-report-validator.mjs#REQUIRED_REPORT_SPECS";

export const REQUIRED_REPORT_REDUCERS = Object.freeze({
  DEFAULT: "tools/server-scripts/lib/release-evidence-readiness.mjs#createDefaultReleaseEvidenceReadiness",
  REPO_ORGANIZATION: "tools/server-scripts/lib/release-evidence-readiness.mjs#createRepoOrganizationReadiness",
  CAPABILITY_ACCEPTANCE: "tools/server-scripts/lib/release-evidence-readiness.mjs#createCapabilityAcceptanceReadiness",
  SCRIPT_REGISTRY: "tools/server-scripts/lib/release-evidence-readiness.mjs#createScriptRegistryReadiness",
  PRODUCTION_GATES: "tools/server-scripts/lib/release-evidence-readiness.mjs#createProductionReadinessGatesReadiness",
  UPSTREAM_GATEWAY_E2E: "tools/server-scripts/lib/release-evidence-readiness.mjs#createUpstreamGatewayE2eReadiness",
  UPSTREAM_MCP_GATEWAY: "tools/server-scripts/lib/upstream-mcp-gateway-evidence.mjs#createUpstreamMcpGatewayReadiness",
  UPSTREAM_SERVICE_PUBLISHING: "tools/server-scripts/lib/upstream-service-publishing-evidence.mjs#createUpstreamServicePublishingReadiness",
  GATEWAY_PLATFORM_PROFILE: "tools/server-scripts/lib/release-evidence-readiness.mjs#createGatewayPlatformProfileReadiness",
  UPSTREAM_FIXTURE_TRANSIT: "tools/server-scripts/lib/upstream-fixture-transit-evidence.mjs#createUpstreamFixtureTransitReadiness",
  DOWNSTREAM_AGENT_TOOL_LOOP: "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.mjs#createDownstreamAgentToolLoopReadiness",
  MCP_PROCESS_IDENTITY_CREDENTIAL_STORE: "tools/server-scripts/lib/mcp-process-identity-credential-store-evidence.mjs#createMcpProcessIdentityCredentialStoreReadiness",
  MCP_PROXY_TRANSPORT: "tools/server-scripts/lib/mcp-proxy-transport-evidence.mjs#createMcpProxyTransportReadiness",
  NPM_PACKAGE_INSTALLABILITY: "tools/server-scripts/lib/release-evidence-readiness.mjs#createNpmPackageInstallabilityReadiness",
  STORAGE_PRODUCTION_RESTORE: "tools/server-scripts/lib/storage-production-restore-evidence.mjs#createStorageProductionRestoreReadiness"
});

const DEFAULT_READY_FIELDS = Object.freeze([
  "summary.releaseReady",
  "releaseReady"
]);

function defineSpec({
  path,
  schemaVersion,
  verifier,
  timestampField = "generatedAt",
  reportLeakScanField = "summary.reportLeakScan",
  readyFields = DEFAULT_READY_FIELDS,
  reducer = REQUIRED_REPORT_REDUCERS.DEFAULT,
  provenance = null,
  requiresFinalization = false
}) {
  return Object.freeze({
    path,
    schemaVersion,
    verifier,
    timestampField,
    reportLeakScanField,
    readyFields: Object.freeze([...readyFields]),
    reducer,
    provenance: provenance ? Object.freeze({ ...provenance }) : null,
    requiresFinalization: Boolean(requiresFinalization)
  });
}

const SPEC_LIST = [
  defineSpec({ path: "build/reports/approval-governance.json", schemaVersion: "v0.0.1:authorization:approval-governance-report-1", verifier: "tools/server-scripts/verify-approval-governance.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/better-plan.json", schemaVersion: "v0.0.1:release:public-source-boundary-verifier-1", verifier: "tools/server-scripts/verify-better-plan.mjs" }),
  defineSpec({ path: "build/reports/capability-acceptance-machines.json", schemaVersion: "v0.0.1:acceptance:capability-machines-report-7", verifier: "tools/server-scripts/verify-capability-acceptance-machines.mjs", readyFields: ["readyForReleaseReduction", "summary.readyForReleaseReduction"], reducer: REQUIRED_REPORT_REDUCERS.CAPABILITY_ACCEPTANCE }),
  defineSpec({ path: "build/reports/composition-source-package.json", schemaVersion: "v0.0.1:release:composition-source-package-report-1", verifier: "tools/server-scripts/verify-composition-source-package.mjs", readyFields: ["summary.compositionSourcePackageAcceptanceReady"] }),
  defineSpec({ path: "build/reports/console-admin-browser-visual.json", schemaVersion: "v0.0.1:console:admin-browser-visual-report-2", verifier: "tools/server-scripts/verify-console-admin-browser-visual.mjs" }),
  defineSpec({ path: "build/reports/console-administration-coverage.json", schemaVersion: "v0.0.1:console:administration-coverage-report-1", verifier: "tools/server-scripts/verify-console-administration-coverage.mjs" }),
  defineSpec({ path: "build/reports/console-gateway-mcp-workflows.json", schemaVersion: "v0.0.1:console:gateway-mcp-workflows-report-1", verifier: "tools/server-scripts/verify-console-gateway-mcp-workflows.mjs" }),
  defineSpec({ path: "build/reports/console-redundancy.json", schemaVersion: "v0.0.1:console:redundancy-report-1", verifier: "tools/server-scripts/verify-console-redundancy.mjs" }),
  defineSpec({ path: "build/reports/core-platform-documentation-convergence.json", schemaVersion: "v0.0.1:platform:documentation-convergence-report-1", verifier: "tools/server-scripts/verify-core-platform-documentation-convergence.mjs" }),
  defineSpec({ path: "build/reports/core-platform-gap-audit.json", schemaVersion: "v0.0.1:platform:gap-audit-report-1", verifier: "tools/verifiers/core-platform-gap-audit.mjs" }),
  defineSpec({ path: "build/reports/core-platform-surface-convergence.json", schemaVersion: "v0.0.1:platform:surface-convergence-report-2", verifier: "tools/server-scripts/verify-core-platform-surface-convergence.mjs" }),
  defineSpec({ path: "build/reports/deployment-container-flow.json", schemaVersion: "v0.0.1:deployment:container-flow-report-1", verifier: "tools/server-scripts/verify-deployment-container-flow.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/downstream-agent-tool-loop.json", schemaVersion: "v0.0.1:downstream-gateway:agent-tool-loop-report-1", verifier: "tools/server-scripts/verify-downstream-agent-tool-loop.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.DOWNSTREAM_AGENT_TOOL_LOOP }),
  defineSpec({ path: "build/reports/downstream-mcp-completeness-audit.json", schemaVersion: "v0.0.1:mcp:downstream-completeness-audit-1", verifier: "tools/verifiers/downstream-mcp-completeness-audit.mjs" }),
  defineSpec({ path: "build/reports/enterprise-audit-retention-redaction.json", schemaVersion: "v0.0.1:observability:audit-retention-redaction-report-1", verifier: "tools/server-scripts/verify-enterprise-audit-retention-redaction.mjs", timestampField: "finishedAt", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "enterprise-audit-retention-redaction" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/enterprise-authorization-enforcement.json", schemaVersion: "v0.0.1:authorization:enterprise-enforcement-report-1", verifier: "tools/server-scripts/verify-enterprise-authorization-enforcement.mjs" }),
  defineSpec({ path: "build/reports/enterprise-governance-coverage.json", schemaVersion: "v0.0.1:authorization:enterprise-governance-coverage-report-1", verifier: "tools/server-scripts/verify-authorization-governance.mjs" }),
  defineSpec({ path: "build/reports/enterprise-observability-coverage.json", schemaVersion: "v0.0.1:observability:enterprise-coverage-report-1", verifier: "tools/server-scripts/verify-enterprise-observability-coverage.mjs", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "enterprise-observability-coverage" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/gateway-platform-profile.json", schemaVersion: "v0.0.1:gateway:platform-profile-report-1", verifier: "tools/server-scripts/stress-gateway-platform-profile.mjs", reducer: REQUIRED_REPORT_REDUCERS.GATEWAY_PLATFORM_PROFILE }),
  defineSpec({ path: "build/reports/job-work-queue.json", schemaVersion: "v0.0.1:workflow:job-work-queue-report-1", verifier: "tools/server-scripts/verify-job-work-queue.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/job-work-queue-capacity.json", schemaVersion: "v0.0.1:workflow:job-work-queue-capacity-report-1", verifier: "tools/server-scripts/verify-job-work-queue-capacity.mjs", timestampField: "finishedAt", readyFields: ["summary.verificationPassed"], provenance: { producer: "meshrix-core-job-work-queue-capacity", commandId: "job-work-queue-capacity" } }),
  defineSpec({ path: "build/reports/local-info-hygiene.json", schemaVersion: "v0.0.1:repository:local-info-hygiene-report-0.0.2", verifier: "tools/config-scanner.mjs" }),
  defineSpec({ path: "build/reports/mcp-client-identity-proof.json", schemaVersion: "v0.0.1:process-identity:mcp-client-proof-report-1", verifier: "tools/server-scripts/verify-mcp-client-identity-proof.mjs" }),
  defineSpec({ path: "build/reports/mcp-authorization-request-filters.json", schemaVersion: "v0.0.1:mcp:authorization-request-filters-report-1", verifier: "tools/server-scripts/verify-mcp-authorization-request-filters.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/mcp-installer-convergence.json", schemaVersion: "v0.0.1:mcp:installer-convergence-report-1", verifier: "tools/server-scripts/verify-mcp-installer-convergence.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/mcp-gateway-load.json", schemaVersion: "v0.0.1:mcp:gateway-load-report-1", verifier: "tools/server-scripts/stress-mcp-gateway.mjs" }),
  defineSpec({ path: "build/reports/mcp-process-identity-credential-store.json", schemaVersion: "v0.0.1:process-identity:mcp-credential-store-report-0.0.3", verifier: "tools/server-scripts/verify-mcp-process-identity-credential-store.mjs", reducer: REQUIRED_REPORT_REDUCERS.MCP_PROCESS_IDENTITY_CREDENTIAL_STORE }),
  defineSpec({ path: "build/reports/node-runtime-supply-chain.json", schemaVersion: "v1:node-runtime-supply-chain-report", verifier: "tools/server-scripts/verify-node-runtime-supply-chain.mjs" }),
  defineSpec({ path: "build/reports/npm-package-installability.json", schemaVersion: "v0.0.1:release:npm-package-installability-report-1", verifier: "tools/server-scripts/verify-npm-package-installability.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.NPM_PACKAGE_INSTALLABILITY }),
  defineSpec({ path: "build/reports/mcp-proxy-transport.json", schemaVersion: "v0.0.1:mcp:proxy-transport-report-1", verifier: "tools/server-scripts/verify-mcp-proxy-transport.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.MCP_PROXY_TRANSPORT }),
  defineSpec({ path: "build/reports/mcp-release-portable-assembly.json", schemaVersion: "v0.0.1:mcp:release-portable-assembly-report-1", verifier: "tools/server-scripts/verify-mcp-release-portable-assembly.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/mcp-release-target-scope.json", schemaVersion: "v0.0.1:mcp:release-target-scope-report-1", verifier: "tools/server-scripts/verify-mcp-release-target-scope.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/observability-runtime-acceptance.json", schemaVersion: "v0.0.1:observability:runtime-acceptance-report-1", verifier: "tools/server-scripts/verify-observability-runtime-acceptance.mjs", timestampField: "finishedAt", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "observability-runtime" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/observability-semantics.json", schemaVersion: "v0.0.1:observability:semantics-0.2.0", verifier: "tools/server-scripts/verify-observability-semantics.mjs", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "observability-semantics" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/operation-permission-protocol-consistency.json", schemaVersion: "v0.0.1:operation-permission:protocol-consistency-report-1", verifier: "tools/server-scripts/verify-operation-permission-protocol-consistency.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/operation-permission-domain-model.json", schemaVersion: "v0.0.1:operation-permission:domain-model-audit-1", verifier: "tools/server-scripts/verify-operation-permission-domain-model.mjs", reportLeakScanField: "currentChecks.reportLeakScan", readyFields: ["releaseReady"] }),
  defineSpec({ path: "build/reports/operation-permission-tag-governed-e2e.json", schemaVersion: "v0.0.1:operation-permission:tag-governed-e2e-report-1", verifier: "tools/server-scripts/verify-operation-permission-tag-governed-e2e.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/path-abstraction-audit.json", schemaVersion: "v0.0.1:platform:path-abstraction-audit-report-1", verifier: "tools/server-scripts/verify-path-abstraction-audit.mjs", readyFields: ["summary.pathAbstractionAcceptanceReady"] }),
  defineSpec({ path: "build/reports/controlled-execution-sandbox.json", schemaVersion: "v0.0.1:execution-sandbox:acceptance-report-1", verifier: "tools/server-scripts/verify-controlled-execution-sandbox.mjs", readyFields: ["sandboxAcceptanceReady"] }),
  defineSpec({ path: "build/reports/execution-sandbox-oci-conformance.json", schemaVersion: "v0.0.1:execution-sandbox:oci-conformance-report-1", verifier: "tools/server-scripts/verify-execution-sandbox-oci-conformance.mjs", readyFields: ["productionBackendConformance"] }),
  defineSpec({ path: "build/reports/opaque-sandbox-custody.json", schemaVersion: "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1", verifier: "tools/server-scripts/verify-opaque-sandbox-custody.mjs", readyFields: ["custodyAcceptanceReady"] }),
  defineSpec({ path: "build/reports/execution-launcher-boundary.json", schemaVersion: "v0.0.1:execution-sandbox:launcher-boundary-report-1", verifier: "tools/verifiers/execution-launcher-boundary.mjs", readyFields: ["boundaryClosed"] }),
  defineSpec({ path: "build/reports/controlled-execution-convergence-final.json", schemaVersion: "v0.0.1:execution-sandbox:controlled-execution-convergence-final-report-1", verifier: "tools/server-scripts/verify-controlled-execution-convergence.mjs", readyFields: ["summary.controlledExecutionConvergenceReady"] }),
  defineSpec({ path: "build/reports/plugin-runtime.json", schemaVersion: "v0.0.1:plugin:runtime-verification-report-3", verifier: "tools/server-scripts/verify-plugin-runtime.mjs", readyFields: ["pluginRuntimeAcceptanceReady", "summary.pluginRuntimeAcceptanceReady"] }),
  defineSpec({ path: "build/reports/private-deployment-open-platform-e2e.json", schemaVersion: "v0.0.1:deployment:private-open-platform-e2e-report-1", verifier: "tools/server-scripts/verify-private-deployment-open-platform-e2e.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/production-readiness-gates.json", schemaVersion: "v0.0.1:release:production-readiness-gates-report-1", verifier: "tools/server-scripts/production-readiness-gate.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.PRODUCTION_GATES }),
  defineSpec({ path: "build/reports/protocol-boundary.json", schemaVersion: "v0.0.1:architecture:protocol-boundary-report-1", verifier: "tools/server-scripts/verify-protocol-boundary.mjs" }),
  defineSpec({ path: "build/reports/repo-organization.json", schemaVersion: "v0.0.1:repository:organization-report-4", verifier: "tools/server-scripts/verify-repo-organization.mjs", reducer: REQUIRED_REPORT_REDUCERS.REPO_ORGANIZATION }),
  defineSpec({ path: "build/reports/script-registry.json", schemaVersion: "v0.0.1:registry:script-catalog-0.2.0", verifier: "tests/verify-script-registry.mjs", readyFields: [], reducer: REQUIRED_REPORT_REDUCERS.SCRIPT_REGISTRY }),
  defineSpec({ path: "build/reports/security-alert-lifecycle.json", schemaVersion: "v0.0.1:security:alert-lifecycle-report-1", verifier: "tools/server-scripts/verify-security-alert-lifecycle.mjs", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "security-alert-lifecycle" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/state-machines/latest.json", schemaVersion: "v0.0.1:state-machine:verification-report-1", verifier: "tools/server-scripts/verify-state-machines.mjs" }),
  defineSpec({ path: "build/reports/storage-production-restore-drill/latest.json", schemaVersion: "v0.0.1:storage:production-restore-drill-report-1", verifier: "tools/server-scripts/verify-storage-production-restore-drill.mjs", reportLeakScanField: null, readyFields: [], reducer: REQUIRED_REPORT_REDUCERS.STORAGE_PRODUCTION_RESTORE }),
  defineSpec({ path: "build/reports/strategy-management.json", schemaVersion: "v0.0.1:strategy-management:verification-report-1", verifier: "tools/server-scripts/verify-strategy-management.mjs", readyFields: ["summary.verificationPassed"] }),
  defineSpec({ path: "build/reports/upstream-fixture-transit.json", schemaVersion: "v0.0.1:upstream-gateway:fixture-transit-report-1", verifier: "tools/server-scripts/verify-upstream-fixture-transit.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_FIXTURE_TRANSIT }),
  defineSpec({ path: "build/reports/upstream-gateway-e2e.json", schemaVersion: "v0.0.1:upstream-gateway:e2e-report-1", verifier: "tools/server-scripts/verify-upstream-gateway-e2e.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_GATEWAY_E2E }),
  defineSpec({ path: "build/reports/upstream-mcp-gateway-e2e.json", schemaVersion: "v0.0.1:upstream-gateway:mcp-e2e-report-1", verifier: "tools/server-scripts/verify-upstream-mcp-gateway-e2e.mjs", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_MCP_GATEWAY }),
  defineSpec({ path: "build/reports/upstream-service-publishing.json", schemaVersion: "v0.0.1:upstream-service-publishing:server-report-3", verifier: "tools/server-scripts/verify-upstream-service-publishing.mjs", readyFields: [], reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_SERVICE_PUBLISHING }),
  defineSpec({ path: "build/reports/work-queue/latest.json", schemaVersion: "v0.0.1:workflow:work-queue-conformance-report-1", verifier: "tools/server-scripts/verify-work-queue-conformance.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/work-queue-process-restart.json", schemaVersion: "v0.0.1:workflow:work-queue-process-restart-report-1", verifier: "tools/server-scripts/verify-work-queue-process-restart.mjs", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/upload-workspace-materialization.json", schemaVersion: "v0.0.1:jobs:upload-workspace-materialization-report-1", verifier: "tools/server-scripts/verify-upload-workspace-materialization.mjs", timestampField: "finishedAt", readyFields: ["summary.verificationPassed"], provenance: { producer: "meshrix-core-upload-workspace-materialization", commandId: "upload-workspace-materialization" } }),
  defineSpec({ path: "build/test-reports/latest.json", schemaVersion: "v0.0.1:schema:definition-1", verifier: "tests/run.mjs", timestampField: "finishedAt" })
];

export const REQUIRED_REPORT_SPECS = Object.freeze(Object.fromEntries(
  SPEC_LIST.map((spec) => [spec.path, spec])
));

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function valueAtPath(record, fieldPath) {
  return String(fieldPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => asRecord(value)[key], record);
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseReportInput(input) {
  if (typeof input !== "string") {
    return { report: asRecord(input), parsed: Boolean(input && typeof input === "object" && !Array.isArray(input)) };
  }
  try {
    const report = JSON.parse(input);
    return { report: asRecord(report), parsed: Boolean(report && typeof report === "object" && !Array.isArray(report)) };
  } catch {
    return { report: {}, parsed: false };
  }
}

export function requiredReportSpec(relativePath = "") {
  return REQUIRED_REPORT_SPECS[String(relativePath || "")] || null;
}

export function validateRequiredReportSpecCoverage(requiredPaths = [], {
  aggregateReportPath = ""
} = {}) {
  const paths = Array.isArray(requiredPaths) ? requiredPaths.map(String) : [];
  const reasons = [];
  const seen = new Set();
  const registeredReducers = new Set(Object.values(REQUIRED_REPORT_REDUCERS));
  for (const reportPath of paths) {
    if (!reportPath) {
      reasons.push("required-report-path-empty");
      continue;
    }
    if (seen.has(reportPath)) {
      reasons.push(`required-report-path-duplicate:${reportPath}`);
    }
    seen.add(reportPath);
    const spec = requiredReportSpec(reportPath);
    if (!spec) {
      reasons.push(`required-report-spec-unregistered:${reportPath}`);
    } else {
      if (
        spec.path !== reportPath ||
        !spec.schemaVersion ||
        !spec.verifier ||
        !spec.timestampField ||
        (spec.reportLeakScanField !== null && !spec.reportLeakScanField) ||
        !Array.isArray(spec.readyFields)
      ) {
        reasons.push(`required-report-spec-incomplete:${reportPath}`);
      }
      if (!registeredReducers.has(spec.reducer)) {
        reasons.push(`required-report-spec-reducer-unregistered:${reportPath}`);
      }
    }
    if (aggregateReportPath && reportPath === aggregateReportPath) {
      reasons.push("aggregate-report-cannot-be-required-input");
    }
  }
  return {
    sourceOfTruth: REQUIRED_REPORT_SPEC_REGISTRY_SOURCE,
    ok: reasons.length === 0,
    requiredReportCount: paths.length,
    registeredReportCount: paths.filter((reportPath) => Boolean(requiredReportSpec(reportPath))).length,
    reasons
  };
}

export function validateRequiredReport(relativePath, input, {
  minimumTimestampMs,
  nowMs = Date.now(),
  maximumFutureSkewMs = 5 * 60 * 1000,
  expectedReleaseEvidenceProvenance = null
} = {}) {
  const reportPath = String(relativePath || "");
  const spec = requiredReportSpec(reportPath);
  const reasons = [];
  if (!spec) {
    return {
      sourceOfTruth: REQUIRED_REPORT_VALIDATOR_SOURCE,
      specSourceOfTruth: REQUIRED_REPORT_SPEC_REGISTRY_SOURCE,
      reportPath,
      registered: false,
      accepted: false,
      reportLeakScan: false,
      sensitiveLeakScanPassed: false,
      embeddedReportLeakScanPassed: false,
      reducer: "",
      readyField: "",
      reasons: ["required-report-spec-unregistered"],
      report: null
    };
  }

  const { report, parsed } = parseReportInput(input);
  if (!parsed) {
    reasons.push("required-report-json-invalid");
  }

  let sensitiveLeakScanPassed = false;
  if (parsed) {
    try {
      if (typeof input === "string") {
        assertNoSensitiveReportLeak(input, "raw required child report");
      }
      assertNoSensitiveReportLeak(report, "required child report");
      sensitiveLeakScanPassed = true;
    } catch {
      reasons.push("required-report-sensitive-data-detected");
    }
  }

  if (report.schemaVersion !== spec.schemaVersion) {
    reasons.push("required-report-schema-version-mismatch");
  }
  if (report.verifier !== spec.verifier) {
    reasons.push("required-report-verifier-mismatch");
  }
  if (spec.provenance) {
    try {
      assertReportProvenance(report, spec.provenance);
    } catch (error) {
      reasons.push(error?.code === "observability_report_digest_mismatch"
        ? "required-report-payload-digest-mismatch"
        : "required-report-provenance-mismatch");
    }
  }
  if (spec.requiresFinalization) {
    if (report.reportOwner !== spec.provenance?.producer) {
      reasons.push("required-report-finalization-owner-mismatch");
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(report.checkpointDigest || ""))) {
      reasons.push("required-report-checkpoint-digest-invalid");
    }
    if (!Array.isArray(report.requirements) || report.requirements.length === 0 || report.requirements.some((item) => !String(item || "").trim())) {
      reasons.push("required-report-requirements-invalid");
    }
    const privacy = asRecord(report.privacyFinalization);
    if (
      privacy.finalizer !== "meshrix-core-observability" ||
      privacy.redactionApplied !== true ||
      privacy.privacyScanPassed !== true ||
      privacy.atomicPublication !== true
    ) {
      reasons.push("required-report-privacy-finalization-invalid");
    }
    const budgets = asRecord(report.resourceBudgets);
    if (["maxReportBytes", "maxScanDepth", "maxScanItems"].some((field) =>
      !Number.isSafeInteger(budgets[field]) || budgets[field] <= 0
    )) {
      reasons.push("required-report-resource-budgets-invalid");
    }
  }
  if (expectedReleaseEvidenceProvenance) {
    const embedded = asRecord(report.releaseEvidenceProvenance);
    for (const field of ["schemaVersion", "producer", "commandId"]) {
      if (
        !String(embedded[field] || "").trim() ||
        embedded[field] !== expectedReleaseEvidenceProvenance[field]
      ) {
        reasons.push(`required-report-release-provenance-mismatch:${field}`);
      }
    }
    if (parseTimestamp(embedded.recordedAt) === null) {
      reasons.push("required-report-release-provenance-timestamp-invalid");
    } else {
      const provenanceTimestamp = parseTimestamp(embedded.recordedAt);
      const minimum = normalizedTimestamp(minimumTimestampMs);
      const maximum = normalizedTimestamp(nowMs);
      if (minimum !== null && provenanceTimestamp < minimum) {
        reasons.push("required-report-release-provenance-timestamp-stale");
      }
      if (
        maximum !== null &&
        provenanceTimestamp > maximum + Math.max(0, Number(maximumFutureSkewMs) || 0)
      ) {
        reasons.push("required-report-release-provenance-timestamp-in-future");
      }
    }
    if (
      !String(embedded.reportPayloadDigest || "").trim() ||
      embedded.reportPayloadDigest !== reportPayloadDigest(Object.fromEntries(
        Object.entries(report).filter(([key]) => key !== "releaseEvidenceProvenance")
      ))
    ) {
      reasons.push("required-report-release-provenance-payload-digest-mismatch");
    }
  }

  const embeddedLeakValue = spec.reportLeakScanField
    ? valueAtPath(report, spec.reportLeakScanField)
    : undefined;
  const embeddedReportLeakScanPassed = spec.reportLeakScanField ? embeddedLeakValue === true : true;
  if (spec.reportLeakScanField && !embeddedReportLeakScanPassed) {
    reasons.push("required-report-leak-scan-not-passed");
  }
  const alternateLeakValue = !spec.reportLeakScanField
    ? undefined
    : spec.reportLeakScanField === "summary.reportLeakScan"
      ? report.reportLeakScan
      : valueAtPath(report, "summary.reportLeakScan");
  if (
    typeof alternateLeakValue === "boolean" &&
    typeof embeddedLeakValue === "boolean" &&
    alternateLeakValue !== embeddedLeakValue
  ) {
    reasons.push("required-report-leak-scan-conflict");
  }

  const embeddedTimestamp = parseTimestamp(valueAtPath(report, spec.timestampField));
  if (embeddedTimestamp === null) {
    reasons.push("required-report-timestamp-missing-or-invalid");
  } else {
    const minimum = normalizedTimestamp(minimumTimestampMs);
    if (minimum !== null && embeddedTimestamp < minimum) {
      reasons.push("required-report-timestamp-stale");
    }
    const maximum = normalizedTimestamp(nowMs);
    if (maximum !== null && embeddedTimestamp > maximum + Math.max(0, Number(maximumFutureSkewMs) || 0)) {
      reasons.push("required-report-timestamp-in-future");
    }
  }

  const readySignals = spec.readyFields
    .map((field) => ({ field, value: valueAtPath(report, field) }))
    .filter(({ value }) => value !== undefined);
  for (const signal of readySignals) {
    if (typeof signal.value !== "boolean") {
      reasons.push(`required-report-ready-field-invalid:${signal.field}`);
    }
  }
  const booleanReadySignals = readySignals.filter(({ value }) => typeof value === "boolean");
  if (
    booleanReadySignals.some(({ value }) => value === true) &&
    booleanReadySignals.some(({ value }) => value === false)
  ) {
    reasons.push("required-report-ready-field-conflict");
  }

  const reportLeakScan = sensitiveLeakScanPassed && embeddedReportLeakScanPassed;
  const accepted = reasons.length === 0;
  return {
    sourceOfTruth: REQUIRED_REPORT_VALIDATOR_SOURCE,
    specSourceOfTruth: REQUIRED_REPORT_SPEC_REGISTRY_SOURCE,
    reportPath,
    registered: true,
    accepted,
    reportLeakScan,
    sensitiveLeakScanPassed,
    embeddedReportLeakScanPassed,
    reducer: spec.reducer,
    readyField: booleanReadySignals[0]?.field || "",
    reasons: [...new Set(reasons)],
    report: accepted ? report : null
  };
}
