#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolCatalog } from "../../packages/capabilities/src/operation-permission-core/catalog.ts";
import { SERVER_API_OPERATIONS } from "../../packages/contracts/src/operations/operation-registry.ts";
import { releaseEvidenceReady } from "./lib/release-evidence-readiness.ts";
import {
  assertNoSensitiveReportLeak,
  assertReportProvenance,
  computeVerifierSourceRevision,
  finalizeAndPublishSensitiveReport
} from "./lib/sensitive-report-scan.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH: any = "build/reports/enterprise-observability-coverage.json";
const TAG_GOVERNED_E2E_REPORT: any = "build/reports/operation-permission-tag-governed-e2e.json";
const AUDIT_REDACTION_REPORT: any = "build/reports/enterprise-audit-retention-redaction.json";
const OBSERVABILITY_SEMANTICS_REPORT: any = "build/reports/observability-semantics.json";
const VERIFIER: any = "tools/server-scripts/verify-enterprise-observability-coverage.ts";
const COMMAND_ID: any = "enterprise-observability-coverage";
const REPORT_SCHEMA_VERSION: any = "v0.0.1:observability:enterprise-coverage-report-1";
const PLAN_FILE: any = "docs/plans/end-to-end-release/enterprise-single-node/Plan.md";
const REQUIREMENTS: readonly any[] = Object.freeze(["REQ-REL-003", "REQ-REL-009", "REQ-REL-010", "REQ-REL-011", "REQ-REL-024", "REQ-REL-025", "REQ-USP-013"]);
const SOURCE_FILES: readonly any[] = Object.freeze([
  "packages/capabilities/src/operation-permission-core/catalog.ts",
  "packages/contracts/src/operations/operation-registry.ts",
  "packages/foundation/src/observability/sensitive-report-scan.ts",
  VERIFIER
]);

const REQUIRED_METRIC_OPERATIONS: readonly any[] = Object.freeze([
  "operation_permission.metrics_summary",
  "operation_permission.metrics_export",
  "operation_permission.metrics_health",
  "operation_permission.metrics_prometheus",
  "observability.trace.get"
]);

const REQUIRED_DIMENSION_PREFIXES: readonly any[] = Object.freeze([
  ["gateway", "gateway."],
  ["workspace-files", "workspace.file."],
  ["operation-permission", "operation_permission."],
  ["storage", "storage."],
  ["jobs", "jobs."]
]);
const REQUIRED_REAL_METRIC_DIMENSIONS: readonly any[] = Object.freeze([
  "gateway",
  "workspace-files",
  "operation-permission"
]);

function repoPath(...parts: any[]) : any {
  return path.join(repoRoot, ...parts);
}

async function readJson(relativePath?: any) : Promise<any> {
  return JSON.parse(await fs.readFile(repoPath(relativePath), "utf8"));
}

function operationMap(operations: any = []) : any {
  return new Map<any, any>(operations.map((operation?: any) : any => [operation.id, operation]));
}

function latestTagGovernedMetricCoverage(report: Record<string, any> = {}) : any {
  const auditTest: any = (report.tests || []).find((item?: any) : any => String(item.name || "").includes("audit metrics and cleanup"));
  return auditTest?.evidence?.metricToolCoverage || {};
}

function latestTagGovernedMetricStatuses(report: Record<string, any> = {}) : any {
  const auditTest: any = (report.tests || []).find((item?: any) : any => String(item.name || "").includes("audit metrics and cleanup"));
  return auditTest?.evidence?.metricStatuses || {};
}

async function main() : Promise<any> {
  const completeOperations: any = SERVER_API_OPERATIONS;
  const operations: any = operationMap(completeOperations);
  const catalog: any = createToolCatalog({ operations: completeOperations });
  const tagGoverned: any = await readJson(TAG_GOVERNED_E2E_REPORT);
  const auditRedaction: any = await readJson(AUDIT_REDACTION_REPORT);
  const semantics: any = await readJson(OBSERVABILITY_SEMANTICS_REPORT);
  const metricCoverage: any = latestTagGovernedMetricCoverage(tagGoverned);
  const metricStatuses: any = latestTagGovernedMetricStatuses(tagGoverned);

  const endpointCoverage: any = Object.fromEntries(REQUIRED_METRIC_OPERATIONS.map((operationId?: any) : any => {
    const operation: any = operations.get(operationId);
    return [operationId, {
      registered: Boolean(operation),
      http: Boolean(operation?.http?.path),
      rpc: Boolean(operation?.rpc?.method),
      scope: operation?.requiredScopes || []
    }];
  }));

  const dimensionCoverage: any = Object.fromEntries(REQUIRED_DIMENSION_PREFIXES.map(([name, prefix]: any[]) : any => {
    const tools: any = catalog.tools.filter((tool?: any) : any => String(tool.operationId || "").startsWith(prefix));
    const metricTools: any = Object.keys(metricCoverage).filter((toolId?: any) : any => {
      const tool: any = catalog.tools.find((item?: any) : any => item.id === toolId);
      return String(tool?.operationId || "").startsWith(prefix);
    });
    const operationPermissionMetricStatusEvidence: any = name === "operation-permission" &&
      Number(metricStatuses.ok || 0) > 0 &&
      Number(metricStatuses.denied || 0) > 0 &&
      Number(metricStatuses.pendingApproval || 0) > 0;
    return [name, {
      catalogToolCount: tools.length,
      realMetricToolCount: metricTools.length + (operationPermissionMetricStatusEvidence ? 1 : 0),
      catalogEvidence: tools.slice(0, 8).map((tool?: any) : any => tool.id)
    }];
  }));

  const missingEndpointCoverage: any = (Object.entries(endpointCoverage) as [string, any][])
    .filter(([, value]: any[]) : any => !value.registered || !value.http || !value.rpc)
    .map(([operationId]: any[]) : any => operationId);
  const missingDimensionCoverage: any = (Object.entries(dimensionCoverage) as [string, any][])
    .filter(([, value]: any[]) : any => value.catalogToolCount <= 0)
    .map(([name]: any[]) : any => name);
  const missingRealMetricFamilies: any = REQUIRED_REAL_METRIC_DIMENSIONS
    .filter((name?: any) : any => Number(dimensionCoverage[name]?.realMetricToolCount || 0) <= 0);

  const traceEvidence: Record<string, any> = {
    auditTraceDrilldown: (auditRedaction.tests || []).some((item?: any) : any =>
      Number(item.evidence?.traceSpanCount || 0) > 0
    ),
    operationPermissionTraceMetrics: Object.keys(metricCoverage).length > 0,
    semanticReleaseGate: releaseEvidenceReady(OBSERVABILITY_SEMANTICS_REPORT, semantics)
  };

  const missingTraceEvidence: any = (Object.entries(traceEvidence) as [string, any][])
    .filter(([, value]: any[]) : any => value !== true)
    .map(([key]: any[]) : any => key);

  const readyForReleaseReduction: any = missingEndpointCoverage.length === 0 &&
    missingDimensionCoverage.length === 0 &&
    missingRealMetricFamilies.length === 0 &&
    missingTraceEvidence.length === 0 &&
    releaseEvidenceReady(TAG_GOVERNED_E2E_REPORT, tagGoverned) &&
    releaseEvidenceReady(AUDIT_REDACTION_REPORT, auditRedaction);

  const report: Record<string, any> = {
    schemaVersion: "v0.0.1:observability:enterprise-coverage-report-1",
    generatedAt: new Date().toISOString(),
    verifier: VERIFIER,
    sourceOfTruth: {
      operations: "packages/contracts/src/operations/operation-registry.ts",
      operationPermissionCatalog: "packages/capabilities/src/operation-permission-core/catalog.ts",
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
  const revision: any = await computeVerifierSourceRevision(repoRoot, SOURCE_FILES);
  const provenance: Record<string, any> = {
    producer: "meshrix-core-observability",
    commandId: COMMAND_ID,
    sourceRevision: revision
  };
  const finalizedReport: any = await finalizeAndPublishSensitiveReport(report, {
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
      ...missingEndpointCoverage.map((value?: any) : any => `missing_endpoint:${value}`),
      ...missingDimensionCoverage.map((value?: any) : any => `missing_dimension:${value}`),
      ...missingRealMetricFamilies.map((value?: any) : any => `missing_real_metric:${value}`),
      ...missingTraceEvidence.map((value?: any) : any => `missing_trace:${value}`)
    ].slice(0, 30)) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }

  console.log(`[enterprise-observability-coverage] report=${REPORT_PATH}`);
  console.log("[enterprise-observability-coverage] readyForReleaseReduction=true");
}

await main();
