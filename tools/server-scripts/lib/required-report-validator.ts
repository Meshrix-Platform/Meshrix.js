import {
  assertNoSensitiveReportLeak,
  assertReportProvenance
} from "./sensitive-report-scan.ts";
import {
  reportPayloadDigest
} from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";

export const REQUIRED_REPORT_VALIDATOR_SOURCE: any =
  "tools/server-scripts/lib/required-report-validator.ts#validateRequiredReport";
export const REQUIRED_REPORT_SPEC_REGISTRY_SOURCE: any =
  "tools/server-scripts/lib/required-report-validator.ts#REQUIRED_REPORT_SPECS";

export const REQUIRED_REPORT_REDUCERS: Readonly<Record<string, any>> = Object.freeze({
  DEFAULT: "tools/server-scripts/lib/release-evidence-readiness.ts#createDefaultReleaseEvidenceReadiness",
  REPO_ORGANIZATION: "tools/server-scripts/lib/release-evidence-readiness.ts#createRepoOrganizationReadiness",
  CAPABILITY_ACCEPTANCE: "tools/server-scripts/lib/release-evidence-readiness.ts#createCapabilityAcceptanceReadiness",
  SCRIPT_REGISTRY: "tools/server-scripts/lib/release-evidence-readiness.ts#createScriptRegistryReadiness",
  PRODUCTION_GATES: "tools/server-scripts/lib/release-evidence-readiness.ts#createProductionReadinessGatesReadiness",
  UPSTREAM_GATEWAY_E2E: "tools/server-scripts/lib/release-evidence-readiness.ts#createUpstreamGatewayE2eReadiness",
  UPSTREAM_MCP_GATEWAY: "tools/server-scripts/lib/upstream-mcp-gateway-evidence.ts#createUpstreamMcpGatewayReadiness",
  UPSTREAM_SERVICE_PUBLISHING: "tools/server-scripts/lib/upstream-service-publishing-evidence.ts#createUpstreamServicePublishingReadiness",
  GATEWAY_PLATFORM_PROFILE: "tools/server-scripts/lib/release-evidence-readiness.ts#createGatewayPlatformProfileReadiness",
  UPSTREAM_FIXTURE_TRANSIT: "tools/server-scripts/lib/upstream-fixture-transit-evidence.ts#createUpstreamFixtureTransitReadiness",
  DOWNSTREAM_AGENT_TOOL_LOOP: "tools/server-scripts/lib/downstream-agent-tool-loop-evidence.ts#createDownstreamAgentToolLoopReadiness",
  MCP_PROXY_TRANSPORT: "tools/server-scripts/lib/mcp-proxy-transport-evidence.ts#createMcpProxyTransportReadiness",
  NPM_PACKAGE_INSTALLABILITY: "tools/server-scripts/lib/release-evidence-readiness.ts#createNpmPackageInstallabilityReadiness",
  STORAGE_PRODUCTION_RESTORE: "tools/server-scripts/lib/storage-production-restore-evidence.ts#createStorageProductionRestoreReadiness"
});

const DEFAULT_READY_FIELDS: readonly any[] = Object.freeze([
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
}: Record<string, any>) : any {
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

const SPEC_LIST: any[] = [
  defineSpec({ path: "build/reports/approval-governance.json", schemaVersion: "v0.0.1:authorization:approval-governance-report-1", verifier: "tools/server-scripts/verify-approval-governance.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/capability-acceptance-machines.json", schemaVersion: "v0.0.1:acceptance:capability-machines-report-7", verifier: "tools/server-scripts/verify-capability-acceptance-machines.ts", readyFields: ["readyForReleaseReduction", "summary.readyForReleaseReduction"], reducer: REQUIRED_REPORT_REDUCERS.CAPABILITY_ACCEPTANCE }),
  defineSpec({ path: "build/reports/composition-source-package.json", schemaVersion: "v0.0.1:release:composition-source-package-report-1", verifier: "tools/server-scripts/verify-composition-source-package.ts", readyFields: ["summary.compositionSourcePackageAcceptanceReady"] }),
  defineSpec({ path: "build/reports/console-admin-browser-visual.json", schemaVersion: "v0.0.1:console:admin-browser-visual-report-2", verifier: "tools/server-scripts/verify-console-admin-browser-visual.ts" }),
  defineSpec({ path: "build/reports/console-administration-coverage.json", schemaVersion: "v0.0.1:console:administration-coverage-report-1", verifier: "tools/server-scripts/verify-console-administration-coverage.ts" }),
  defineSpec({ path: "build/reports/console-gateway-mcp-workflows.json", schemaVersion: "v0.0.1:console:gateway-mcp-workflows-report-1", verifier: "tools/server-scripts/verify-console-gateway-mcp-workflows.ts" }),
  defineSpec({ path: "build/reports/console-redundancy.json", schemaVersion: "v0.0.1:console:redundancy-report-1", verifier: "tools/server-scripts/verify-console-redundancy.ts" }),
  defineSpec({ path: "build/reports/core-platform-documentation-convergence.json", schemaVersion: "v0.0.1:platform:documentation-convergence-report-1", verifier: "tools/server-scripts/verify-core-platform-documentation-convergence.ts" }),
  defineSpec({ path: "build/reports/core-platform-gap-audit.json", schemaVersion: "v0.0.1:platform:gap-audit-report-1", verifier: "tools/verifiers/core-platform-gap-audit.ts", readyFields: ["summary.structuralCoverageReady"] }),
  defineSpec({ path: "build/reports/core-platform-surface-convergence.json", schemaVersion: "v0.0.1:platform:surface-convergence-report-2", verifier: "tools/server-scripts/verify-core-platform-surface-convergence.ts", readyFields: ["summary.structuralCoverageReady"] }),
  defineSpec({ path: "build/reports/deployment-container-flow.json", schemaVersion: "v0.0.1:deployment:container-flow-report-1", verifier: "tools/server-scripts/verify-deployment-container-flow.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/downstream-agent-tool-loop.json", schemaVersion: "v0.0.1:downstream-gateway:agent-tool-loop-report-1", verifier: "tools/server-scripts/verify-downstream-agent-tool-loop.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.DOWNSTREAM_AGENT_TOOL_LOOP }),
  defineSpec({ path: "build/reports/downstream-mcp-completeness-audit.json", schemaVersion: "v0.0.1:mcp:downstream-completeness-audit-1", verifier: "tools/verifiers/downstream-mcp-completeness-audit.ts" }),
  defineSpec({ path: "build/reports/enterprise-audit-retention-redaction.json", schemaVersion: "v0.0.1:observability:audit-retention-redaction-report-1", verifier: "tools/server-scripts/verify-enterprise-audit-retention-redaction.ts", timestampField: "finishedAt", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "enterprise-audit-retention-redaction" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/enterprise-authorization-enforcement.json", schemaVersion: "v0.0.1:authorization:enterprise-enforcement-report-1", verifier: "tools/server-scripts/verify-enterprise-authorization-enforcement.ts" }),
  defineSpec({ path: "build/reports/enterprise-governance-coverage.json", schemaVersion: "v0.0.1:authorization:enterprise-governance-coverage-report-1", verifier: "tools/server-scripts/verify-authorization-governance.ts" }),
  defineSpec({ path: "build/reports/enterprise-observability-coverage.json", schemaVersion: "v0.0.1:observability:enterprise-coverage-report-1", verifier: "tools/server-scripts/verify-enterprise-observability-coverage.ts", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "enterprise-observability-coverage" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/gateway-platform-profile.json", schemaVersion: "v0.0.1:gateway:platform-profile-report-1", verifier: "tools/server-scripts/stress-gateway-platform-profile.ts", reducer: REQUIRED_REPORT_REDUCERS.GATEWAY_PLATFORM_PROFILE }),
  defineSpec({ path: "build/reports/integration-task-supervisor.json", schemaVersion: "v0.0.1:platform:integration-task-supervisor-report-1", verifier: "tools/server-scripts/verify-integration-task-supervisor.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/job-work-queue.json", schemaVersion: "v0.0.1:workflow:job-work-queue-report-1", verifier: "tools/server-scripts/verify-job-work-queue.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/job-work-queue-ceiling-conformance.json", schemaVersion: "v0.0.1:workflow:job-work-queue-ceiling-conformance-report-1", verifier: "tools/server-scripts/verify-job-work-queue-ceiling-conformance.ts", timestampField: "finishedAt", readyFields: ["summary.verificationPassed"], provenance: { producer: "meshrix-core-job-work-queue-ceiling-conformance", commandId: "job-work-queue-ceiling-conformance" } }),
  defineSpec({ path: "build/reports/local-info-hygiene.json", schemaVersion: "v0.0.1:repository:local-info-hygiene-report-0.0.2", verifier: "tools/config-scanner.ts" }),
  defineSpec({ path: "build/reports/gateway-boundary-final.json", schemaVersion: "v0.0.1:gateway-boundary-final:report-1", verifier: "tools/server-scripts/gateway-boundary-final.ts" }),
  defineSpec({ path: "build/reports/maintenance-plugin-config-only.json", schemaVersion: "v0.0.1:maintenance-plugin:config-only-report-1", verifier: "tools/server-scripts/verify-agent-self-maintenance-runtime.ts" }),
  defineSpec({ path: "build/reports/maintenance-plugin-one-way-meshrix-control.json", schemaVersion: "v0.0.1:maintenance-plugin:one-way-meshrix-control-report-1", verifier: "tools/server-scripts/verify-agent-self-maintenance-runtime.ts" }),
  defineSpec({ path: "build/reports/maintenance-plugin-direct-model-gateway.json", schemaVersion: "v0.0.1:maintenance-plugin:direct-model-gateway-report-1", verifier: "tools/server-scripts/verify-agent-self-maintenance-runtime.ts" }),
  defineSpec({ path: "build/reports/maintenance-plugin-backend-unreachable.json", schemaVersion: "v0.0.1:maintenance-plugin:backend-unreachable-report-1", verifier: "tools/server-scripts/verify-agent-self-maintenance-runtime.ts" }),
  defineSpec({ path: "build/reports/mcp-installer-convergence.json", schemaVersion: "v0.0.1:mcp:installer-convergence-report-1", verifier: "tools/server-scripts/verify-mcp-installer-convergence.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/mcp-gateway-load.json", schemaVersion: "v0.0.1:mcp:gateway-load-report-1", verifier: "tools/server-scripts/stress-mcp-gateway.ts" }),
  defineSpec({ path: "build/reports/node-runtime-supply-chain.json", schemaVersion: "v0.0.1:mcp:node-runtime-supply-chain-report-2", verifier: "tools/server-scripts/verify-node-runtime-supply-chain.ts" }),
  defineSpec({ path: "build/reports/npm-package-installability.json", schemaVersion: "v0.0.1:release:npm-package-installability-report-1", verifier: "tools/server-scripts/verify-npm-package-installability.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.NPM_PACKAGE_INSTALLABILITY }),
  defineSpec({ path: "build/reports/mcp-proxy-transport.json", schemaVersion: "v0.0.1:mcp:proxy-transport-report-1", verifier: "tools/server-scripts/verify-mcp-proxy-transport.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.MCP_PROXY_TRANSPORT }),
  defineSpec({ path: "build/reports/mcp-release-portable-assembly.json", schemaVersion: "v0.0.1:mcp:release-portable-assembly-report-1", verifier: "tools/server-scripts/verify-mcp-release-portable-assembly.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/mcp-release-target-scope.json", schemaVersion: "v0.0.1:mcp:release-target-scope-report-1", verifier: "tools/server-scripts/verify-mcp-release-target-scope.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/observability-runtime-acceptance.json", schemaVersion: "v0.0.1:observability:runtime-acceptance-report-2", verifier: "tools/server-scripts/verify-observability-runtime-acceptance.ts", timestampField: "finishedAt", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "observability-runtime" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/observability-semantics.json", schemaVersion: "v0.0.1:observability:semantics-0.2.0", verifier: "tools/server-scripts/verify-observability-semantics.ts", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "observability-semantics" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/operation-permission-protocol-consistency.json", schemaVersion: "v0.0.1:operation-permission:protocol-consistency-report-1", verifier: "tools/server-scripts/verify-operation-permission-protocol-consistency.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/operation-permission-domain-model.json", schemaVersion: "v0.0.1:operation-permission:domain-model-audit-1", verifier: "tools/server-scripts/verify-operation-permission-domain-model.ts", reportLeakScanField: "currentChecks.reportLeakScan", readyFields: ["releaseReady"] }),
  defineSpec({ path: "build/reports/operation-permission-tag-governed-e2e.json", schemaVersion: "v0.0.1:operation-permission:tag-governed-e2e-report-1", verifier: "tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/path-abstraction-audit.json", schemaVersion: "v0.0.1:platform:path-abstraction-audit-report-1", verifier: "tools/server-scripts/verify-path-abstraction-audit.ts", readyFields: ["summary.pathAbstractionAcceptanceReady"] }),
  defineSpec({ path: "build/reports/controlled-execution-sandbox.json", schemaVersion: "v0.0.1:execution-sandbox:acceptance-report-1", verifier: "tools/server-scripts/verify-controlled-execution-sandbox.ts", readyFields: ["sandboxAcceptanceReady"] }),
  defineSpec({ path: "build/reports/execution-sandbox-oci-conformance.json", schemaVersion: "v0.0.1:execution-sandbox:oci-conformance-report-1", verifier: "tools/server-scripts/verify-execution-sandbox-oci-conformance.ts", readyFields: ["productionBackendConformance"] }),
  defineSpec({ path: "build/reports/opaque-sandbox-custody.json", schemaVersion: "v0.0.1:execution-sandbox:opaque-custody-acceptance-report-1", verifier: "tools/server-scripts/verify-opaque-sandbox-custody.ts", readyFields: ["custodyAcceptanceReady"] }),
  defineSpec({ path: "build/reports/execution-launcher-boundary.json", schemaVersion: "v0.0.1:execution-sandbox:launcher-boundary-report-1", verifier: "tools/verifiers/execution-launcher-boundary.ts", readyFields: ["boundaryClosed"] }),
  defineSpec({ path: "build/reports/controlled-execution-convergence-final.json", schemaVersion: "v0.0.1:execution-sandbox:controlled-execution-convergence-final-report-2", verifier: "tools/server-scripts/verify-controlled-execution-convergence.ts", readyFields: ["summary.controlledExecutionConvergenceReady"] }),
  defineSpec({ path: "build/reports/plugin-runtime.json", schemaVersion: "v0.0.1:plugin:runtime-verification-report-3", verifier: "tools/server-scripts/verify-plugin-runtime.ts", readyFields: ["pluginRuntimeAcceptanceReady", "summary.pluginRuntimeAcceptanceReady"] }),
  defineSpec({ path: "build/reports/private-deployment-internal-platform-e2e.json", schemaVersion: "v0.0.1:deployment:private-internal-platform-e2e-report-1", verifier: "tools/server-scripts/verify-private-deployment-internal-platform-e2e.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/production-readiness-gates.json", schemaVersion: "v0.0.1:release:production-readiness-gates-report-1", verifier: "tools/server-scripts/production-readiness-gate.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.PRODUCTION_GATES }),
  defineSpec({ path: "build/reports/protocol-boundary.json", schemaVersion: "v0.0.1:architecture:protocol-boundary-report-1", verifier: "tools/server-scripts/verify-protocol-boundary.ts" }),
  defineSpec({ path: "build/reports/repo-organization.json", schemaVersion: "v0.0.1:repository:organization-report-4", verifier: "tools/server-scripts/verify-repo-organization.ts", reducer: REQUIRED_REPORT_REDUCERS.REPO_ORGANIZATION }),
  defineSpec({ path: "build/reports/script-registry.json", schemaVersion: "v0.0.1:registry:script-catalog-0.2.0", verifier: "tests/verify-script-registry.ts", readyFields: [], reducer: REQUIRED_REPORT_REDUCERS.SCRIPT_REGISTRY }),
  defineSpec({ path: "build/reports/security-alert-lifecycle.json", schemaVersion: "v0.0.1:security:alert-lifecycle-report-1", verifier: "tools/server-scripts/verify-security-alert-lifecycle.ts", readyFields: ["summary.readyForReleaseReduction"], provenance: { producer: "meshrix-core-observability", commandId: "security-alert-lifecycle" }, requiresFinalization: true }),
  defineSpec({ path: "build/reports/state-machines/latest.json", schemaVersion: "v0.0.1:state-machine:verification-report-1", verifier: "tools/server-scripts/verify-state-machines.ts" }),
  defineSpec({ path: "build/reports/storage-production-restore-drill/latest.json", schemaVersion: "v0.0.1:storage:production-restore-drill-report-1", verifier: "tools/server-scripts/verify-storage-production-restore-drill.ts", reportLeakScanField: null, readyFields: [], reducer: REQUIRED_REPORT_REDUCERS.STORAGE_PRODUCTION_RESTORE }),
  defineSpec({ path: "build/reports/strategy-management.json", schemaVersion: "v0.0.1:strategy-management:verification-report-1", verifier: "tools/server-scripts/verify-strategy-management.ts", readyFields: ["summary.verificationPassed"] }),
  defineSpec({ path: "build/reports/upstream-fixture-transit.json", schemaVersion: "v0.0.1:upstream-gateway:fixture-transit-report-1", verifier: "tools/server-scripts/verify-upstream-fixture-transit.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_FIXTURE_TRANSIT }),
  defineSpec({ path: "build/reports/upstream-gateway-e2e.json", schemaVersion: "v0.0.1:upstream-gateway:e2e-report-1", verifier: "tools/server-scripts/verify-upstream-gateway-e2e.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_GATEWAY_E2E }),
  defineSpec({ path: "build/reports/upstream-mcp-gateway-e2e.json", schemaVersion: "v0.0.1:upstream-gateway:mcp-e2e-report-1", verifier: "tools/server-scripts/verify-upstream-mcp-gateway-e2e.ts", timestampField: "finishedAt", reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_MCP_GATEWAY }),
  defineSpec({ path: "build/reports/upstream-service-publishing.json", schemaVersion: "v0.0.1:upstream-service-publishing:server-report-3", verifier: "tools/server-scripts/verify-upstream-service-publishing.ts", readyFields: [], reducer: REQUIRED_REPORT_REDUCERS.UPSTREAM_SERVICE_PUBLISHING }),
  defineSpec({ path: "build/reports/work-queue/latest.json", schemaVersion: "v0.0.1:workflow:work-queue-conformance-report-1", verifier: "tools/server-scripts/verify-work-queue-conformance.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/work-queue-process-restart.json", schemaVersion: "v0.0.1:workflow:work-queue-process-restart-report-1", verifier: "tools/server-scripts/verify-work-queue-process-restart.ts", timestampField: "finishedAt" }),
  defineSpec({ path: "build/reports/upload-workspace-materialization.json", schemaVersion: "v0.0.1:jobs:upload-workspace-materialization-report-1", verifier: "tools/server-scripts/verify-upload-workspace-materialization.ts", timestampField: "finishedAt", readyFields: ["summary.verificationPassed"], provenance: { producer: "meshrix-core-upload-workspace-materialization", commandId: "upload-workspace-materialization" } }),
  defineSpec({ path: "build/test-reports/latest.json", schemaVersion: "v0.0.1:schema:definition-1", verifier: "tests/run.ts", timestampField: "finishedAt" })
];

export const REQUIRED_REPORT_SPECS: any = Object.freeze(Object.fromEntries(
  SPEC_LIST.map((spec?: any) : any => [spec.path, spec])
));

function asRecord(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function valueAtPath(record?: any, fieldPath?: any) : any {
  return String(fieldPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((value?: any, key?: any) : any => asRecord(value)[key], record);
}

function parseTimestamp(value?: any) : any {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp: any = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedTimestamp(value?: any) : any {
  if (value instanceof Date) return value.getTime();
  const number: any = Number(value);
  return Number.isFinite(number) ? number : null;
}

const EXPLICIT_NOT_READY_STATES: any = new Set<any>(["blocked", "missing", "stale"]);

function explicitStateBlockers(record?: any, prefix?: any, reasons?: any) : any {
  for (const field of ["status", "liveStatus", "currentState", "evidenceStatus", "productionEvidenceStatus"]) {
    const value: any = String(record[field] || "").trim().toLowerCase();
    if (EXPLICIT_NOT_READY_STATES.has(value)) {
      reasons.push(`required-report-explicit-not-ready:${prefix}${field}:${value}`);
    }
  }
  if (record.acceptedAsProductionEvidence === false) {
    reasons.push(`required-report-production-evidence-rejected:${prefix}acceptedAsProductionEvidence`);
  }
  if (record.blocked === true) {
    reasons.push(`required-report-explicit-not-ready:${prefix}blocked:true`);
  }
}

function collectDependencyBlockers(value?: any, prefix?: any, reasons?: any) : any {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item?: any, index?: any) : any => collectDependencyBlockers(item, `${prefix}${index}.`, reasons));
    return;
  }
  const record: any = asRecord(value);
  explicitStateBlockers(record, prefix, reasons);
  for (const [key, child] of (Object.entries(record) as [string, any][])) {
    if (child && typeof child === "object") {
      collectDependencyBlockers(child, `${prefix}${key}.`, reasons);
    }
  }
}

export function requiredReportTruthBlockers(input: Record<string, any> = {}) : any {
  const report: any = asRecord(input);
  const reasons: any[] = [];
  explicitStateBlockers(report, "", reasons);
  explicitStateBlockers(asRecord(report.summary), "summary.", reasons);
  for (const [key, value] of (Object.entries(report) as [string, any][])) {
    if (/dependenc(?:y|ies)$/iu.test(key)) {
      collectDependencyBlockers(value, `${key}.`, reasons);
    }
  }
  return [...new Set<any>(reasons)];
}

function parseReportInput(input?: any) : any {
  if (typeof input !== "string") {
    return { report: asRecord(input), parsed: Boolean(input && typeof input === "object" && !Array.isArray(input)) };
  }
  try {
    const report: any = JSON.parse(input);
    return { report: asRecord(report), parsed: Boolean(report && typeof report === "object" && !Array.isArray(report)) };
  } catch {
    return { report: {}, parsed: false };
  }
}

export function requiredReportSpec(relativePath: any = "") : any {
  return REQUIRED_REPORT_SPECS[String(relativePath || "")] || null;
}

export function validateRequiredReportSpecCoverage(requiredPaths: any = [], {
  aggregateReportPath = ""
}: Record<string, any> = {}) : any {
  const paths: any = Array.isArray(requiredPaths) ? requiredPaths.map(String) : [];
  const reasons: any[] = [];
  const seen: any = new Set<any>();
  const registeredReducers: any = new Set<any>((Object.values(REQUIRED_REPORT_REDUCERS) as any[]));
  for (const reportPath of paths) {
    if (!reportPath) {
      reasons.push("required-report-path-empty");
      continue;
    }
    if (seen.has(reportPath)) {
      reasons.push(`required-report-path-duplicate:${reportPath}`);
    }
    seen.add(reportPath);
    const spec: any = requiredReportSpec(reportPath);
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
    registeredReportCount: paths.filter((reportPath?: any) : any => Boolean(requiredReportSpec(reportPath))).length,
    reasons
  };
}

export function validateRequiredReport(relativePath?: any, input?: any, {
  minimumTimestampMs,
  nowMs = Date.now(),
  maximumFutureSkewMs = 5 * 60 * 1000,
  expectedReleaseEvidenceProvenance = null
}: Record<string, any> = {}) : any {
  const reportPath: any = String(relativePath || "");
  const spec: any = requiredReportSpec(reportPath);
  const reasons: any[] = [];
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

  let sensitiveLeakScanPassed: any = false;
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
    } catch (error: any) {
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
    if (!Array.isArray(report.requirements) || report.requirements.length === 0 || report.requirements.some((item?: any) : any => !String(item || "").trim())) {
      reasons.push("required-report-requirements-invalid");
    }
    const privacy: any = asRecord(report.privacyFinalization);
    if (
      privacy.finalizer !== "meshrix-core-observability" ||
      privacy.redactionApplied !== true ||
      privacy.privacyScanPassed !== true ||
      privacy.atomicPublication !== true
    ) {
      reasons.push("required-report-privacy-finalization-invalid");
    }
    const budgets: any = asRecord(report.resourceBudgets);
    if (["maxReportBytes", "maxScanDepth", "maxScanItems"].some((field?: any) : any =>
      !Number.isSafeInteger(budgets[field]) || budgets[field] <= 0
    )) {
      reasons.push("required-report-resource-budgets-invalid");
    }
  }
  if (expectedReleaseEvidenceProvenance) {
    const embedded: any = asRecord(report.releaseEvidenceProvenance);
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
      const provenanceTimestamp: any = parseTimestamp(embedded.recordedAt);
      const minimum: any = normalizedTimestamp(minimumTimestampMs);
      const maximum: any = normalizedTimestamp(nowMs);
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
        (Object.entries(report) as [string, any][]).filter(([key]: any[]) : any => key !== "releaseEvidenceProvenance")
      ))
    ) {
      reasons.push("required-report-release-provenance-payload-digest-mismatch");
    }
  }

  const embeddedLeakValue: any = spec.reportLeakScanField
    ? valueAtPath(report, spec.reportLeakScanField)
    : undefined;
  const embeddedReportLeakScanPassed: any = spec.reportLeakScanField ? embeddedLeakValue === true : true;
  if (spec.reportLeakScanField && !embeddedReportLeakScanPassed) {
    reasons.push("required-report-leak-scan-not-passed");
  }
  const alternateLeakValue: any = !spec.reportLeakScanField
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

  const embeddedTimestamp: any = parseTimestamp(valueAtPath(report, spec.timestampField));
  if (embeddedTimestamp === null) {
    reasons.push("required-report-timestamp-missing-or-invalid");
  } else {
    const minimum: any = normalizedTimestamp(minimumTimestampMs);
    if (minimum !== null && embeddedTimestamp < minimum) {
      reasons.push("required-report-timestamp-stale");
    }
    const maximum: any = normalizedTimestamp(nowMs);
    if (maximum !== null && embeddedTimestamp > maximum + Math.max(0, Number(maximumFutureSkewMs) || 0)) {
      reasons.push("required-report-timestamp-in-future");
    }
  }

  const readySignals: any = spec.readyFields
    .map((field?: any) : any => ({ field, value: valueAtPath(report, field) }))
    .filter(({ value }: Record<string, any>) : any => value !== undefined);
  for (const signal of readySignals) {
    if (typeof signal.value !== "boolean") {
      reasons.push(`required-report-ready-field-invalid:${signal.field}`);
    }
  }
  const booleanReadySignals: any = readySignals.filter(({ value }: Record<string, any>) : any => typeof value === "boolean");
  if (booleanReadySignals.some(({ value }: Record<string, any>) : any => value === true)) {
    reasons.push(...requiredReportTruthBlockers(report));
  }
  if (
    booleanReadySignals.some(({ value }: Record<string, any>) : any => value === true) &&
    booleanReadySignals.some(({ value }: Record<string, any>) : any => value === false)
  ) {
    reasons.push("required-report-ready-field-conflict");
  }

  const reportLeakScan: any = sensitiveLeakScanPassed && embeddedReportLeakScanPassed;
  const accepted: any = reasons.length === 0;
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
    reasons: [...new Set<any>(reasons)],
    report: accepted ? report : null
  };
}
