#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.mjs";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.mjs";
import { releaseEvidenceReady } from "./lib/release-evidence-readiness.mjs";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport
} from "./lib/sensitive-report-scan.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = "build/reports/enterprise-observability-coverage.json";
const TAG_GOVERNED_E2E_REPORT = "build/reports/operation-permission-tag-governed-e2e.json";
const AUDIT_REDACTION_REPORT = "build/reports/enterprise-audit-retention-redaction.json";
const OBSERVABILITY_SEMANTICS_REPORT = "build/reports/observability-semantics.json";
const VERIFIER = "tools/server-scripts/verify-enterprise-observability-coverage.mjs";
const COMMAND_ID = "enterprise-observability-coverage";
const REPORT_SCHEMA_VERSION = "v0.0.1:observability:enterprise-coverage-report-1";
const PLAN_FILE = "docs/plans/end-to-end-release/platform-foundation/runtime-observability-convergence/Plan.md";
const REQUIREMENTS = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES = Object.freeze([
  "packages/capabilities/src/operation-permission-core/catalog.mjs",
  "packages/contracts/src/operations/operation-registry.mjs",
  "packages/foundation/src/observability/sensitive-report-scan.mjs",
  VERIFIER
]);

const REQUIRED_METRIC_OPERATIONS = Object.freeze([
  "operation_permission.metrics_summary",
  "operation_permission.metrics_export",
  "operation_permission.metrics_health",
  "operation_permission.metrics_prometheus",
  "observability.trace.get"
]);

const REQUIRED_DIMENSION_PREFIXES = Object.freeze([
  ["gateway", "gateway."],
  ["workspace-files", "workspace.file."],
  ["operation-permission", "operation_permission."],
  ["storage", "storage."],
  ["jobs", "jobs."]
]);
const REQUIRED_REAL_METRIC_DIMENSIONS = Object.freeze([
  "gateway",
  "workspace-files",
  "operation-permission"
]);

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

function operationMap(operations = []) {
  return new Map(operations.map((operation) => [operation.id, operation]));
}

function latestTagGovernedMetricCoverage(report = {}) {
  const auditTest = (report.tests || []).find((item) => String(item.name || "").includes("audit metrics and cleanup"));
  return auditTest?.evidence?.metricToolCoverage || {};
}

function latestTagGovernedMetricStatuses(report = {}) {
  const auditTest = (report.tests || []).find((item) => String(item.name || "").includes("audit metrics and cleanup"));
  return auditTest?.evidence?.metricStatuses || {};
}

async function main() {
  const completeOperations = SERVER_API_OPERATIONS;
  const operations = operationMap(completeOperations);
  const catalog = createToolCatalog({ operations: completeOperations });
  const tagGoverned = await readJson(TAG_GOVERNED_E2E_REPORT);
  const auditRedaction = await readJson(AUDIT_REDACTION_REPORT);
  const semantics = await readJson(OBSERVABILITY_SEMANTICS_REPORT);
  const metricCoverage = latestTagGovernedMetricCoverage(tagGoverned);
  const metricStatuses = latestTagGovernedMetricStatuses(tagGoverned);

  const endpointCoverage = Object.fromEntries(REQUIRED_METRIC_OPERATIONS.map((operationId) => {
    const operation = operations.get(operationId);
    return [operationId, {
      registered: Boolean(operation),
      http: Boolean(operation?.http?.path),
      rpc: Boolean(operation?.rpc?.method),
      scope: operation?.requiredScopes || []
    }];
  }));

  const dimensionCoverage = Object.fromEntries(REQUIRED_DIMENSION_PREFIXES.map(([name, prefix]) => {
    const tools = catalog.tools.filter((tool) => String(tool.operationId || "").startsWith(prefix));
    const metricTools = Object.keys(metricCoverage).filter((toolId) => {
      const tool = catalog.tools.find((item) => item.id === toolId);
      return String(tool?.operationId || "").startsWith(prefix);
    });
    const operationPermissionMetricStatusEvidence = name === "operation-permission" &&
      Number(metricStatuses.ok || 0) > 0 &&
      Number(metricStatuses.denied || 0) > 0 &&
      Number(metricStatuses.pendingApproval || 0) > 0;
    return [name, {
      catalogToolCount: tools.length,
      realMetricToolCount: metricTools.length + (operationPermissionMetricStatusEvidence ? 1 : 0),
      catalogEvidence: tools.slice(0, 8).map((tool) => tool.id)
    }];
  }));

  const missingEndpointCoverage = Object.entries(endpointCoverage)
    .filter(([, value]) => !value.registered || !value.http || !value.rpc)
    .map(([operationId]) => operationId);
  const missingDimensionCoverage = Object.entries(dimensionCoverage)
    .filter(([, value]) => value.catalogToolCount <= 0)
    .map(([name]) => name);
  const missingRealMetricFamilies = REQUIRED_REAL_METRIC_DIMENSIONS
    .filter((name) => Number(dimensionCoverage[name]?.realMetricToolCount || 0) <= 0);

  const traceEvidence = {
    auditTraceDrilldown: (auditRedaction.tests || []).some((item) =>
      Number(item.evidence?.traceSpanCount || 0) > 0
    ),
    operationPermissionTraceMetrics: Object.keys(metricCoverage).length > 0,
    semanticReleaseGate: releaseEvidenceReady(OBSERVABILITY_SEMANTICS_REPORT, semantics)
  };

  const missingTraceEvidence = Object.entries(traceEvidence)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);

  const readyForReleaseReduction = missingEndpointCoverage.length === 0 &&
    missingDimensionCoverage.length === 0 &&
    missingRealMetricFamilies.length === 0 &&
    missingTraceEvidence.length === 0 &&
    releaseEvidenceReady(TAG_GOVERNED_E2E_REPORT, tagGoverned) &&
    releaseEvidenceReady(AUDIT_REDACTION_REPORT, auditRedaction);

  const report = {
    schemaVersion: "v0.0.1:observability:enterprise-coverage-report-1",
    generatedAt: new Date().toISOString(),
    verifier: VERIFIER,
    sourceOfTruth: {
      operations: "packages/contracts/src/operations/operation-registry.mjs",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.mjs",
      tagGovernedE2eReport: TAG_GOVERNED_E2E_REPORT,
      auditRetentionRedactionReport: AUDIT_REDACTION_REPORT,
      observabilitySemanticsReport: OBSERVABILITY_SEMANTICS_REPORT
    },
    algorithm: {
      endpointCoverage: "Require Operation Permission metrics summary/export/health/prometheus and trace drilldown operations to be registered with HTTP and RPC surfaces.",
      dimensionCoverage: "Require catalog dimensions for gateway, workspace files, Operation Permission, storage, and jobs, plus real E2E metric evidence for the governed gateway, workspace, and Operation Permission execution flow.",
      traceCoverage: "Require audit trace drilldown evidence plus release-level OTel semantic coverage.",
      leakScan: "Reject local paths, bearer values, secret-looking tokens, runtime ids, prompt bodies, and private payload content in the report."
    },
    summary: {
      endpointCount: Object.keys(endpointCoverage).length,
      missingEndpointCount: missingEndpointCoverage.length,
      missingDimensionCount: missingDimensionCoverage.length,
      missingRealMetricFamilyCount: missingRealMetricFamilies.length,
      missingTraceEvidenceCount: missingTraceEvidence.length,
      readyForReleaseReduction,
      reportLeakScan: true
    },
    endpointCoverage,
    dimensionCoverage,
    traceEvidence,
    destructiveChecks: {
      missingEndpointCoverage,
      missingDimensionCoverage,
      missingRealMetricFamilies,
      missingTraceEvidence,
      metricLabelAndReportLeakScan: true
    }
  };
  const revision = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
  const provenance = {
    producer: "licomesh-core-observability",
    commandId: COMMAND_ID,
    sourceRevision: revision
  };
  const finalizedReport = await finalizeAndPublishSensitiveReport(report, {
    filePath: repoPath(REPORT_PATH),
    schemaVersion: REPORT_SCHEMA_VERSION,
    verifier: VERIFIER,
    provenance,
    checkpointDigest: await computeVerifierSourceRevision(repoRoot, [PLAN_FILE]),
    requirements: REQUIREMENTS
  });
  assertNoSensitiveReportLeak(finalizedReport, "enterprise observability coverage report");
  assertReportProvenance(finalizedReport, provenance);

  if (!readyForReleaseReduction) {
    console.error(`[enterprise-observability-coverage] report=${REPORT_PATH}`);
    for (const item of [
      ...missingEndpointCoverage.map((value) => `missing_endpoint:${value}`),
      ...missingDimensionCoverage.map((value) => `missing_dimension:${value}`),
      ...missingRealMetricFamilies.map((value) => `missing_real_metric:${value}`),
      ...missingTraceEvidence.map((value) => `missing_trace:${value}`)
    ].slice(0, 30)) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log(`[enterprise-observability-coverage] report=${REPORT_PATH}`);
  console.log("[enterprise-observability-coverage] readyForReleaseReduction=true");
}

await main();
