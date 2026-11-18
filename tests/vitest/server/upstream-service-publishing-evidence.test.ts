import { describe, expect, it } from "vitest";

import {
  UPSTREAM_SERVICE_PUBLISHING_ASSERTIONS,
  UPSTREAM_SERVICE_PUBLISHING_BOUNDARIES,
  UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID,
  UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION,
  UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS,
  UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION,
  UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS,
  UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
  finalizeUpstreamServicePublishingReport,
  reduceUpstreamServicePublishingReport,
  validateUpstreamServicePublishingReport
} from "../../../tools/server-scripts/lib/upstream-service-publishing-evidence.ts";
import { createReleaseEvidenceReadiness } from "../../../tools/server-scripts/lib/release-evidence-readiness.ts";
import { requiredReportSpec } from "../../../tools/server-scripts/lib/required-report-validator.ts";

const sourceRevision: any = `sha256:${"a".repeat(64)}`;
function validReport() : any {
  const observations: any = structuredClone(UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS);
  return finalizeUpstreamServicePublishingReport({
    schemaVersion: UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION,
    verifier: UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
    generatedAt: new Date().toISOString(),
    producer: UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
    commandId: UPSTREAM_SERVICE_PUBLISHING_COMMAND_ID,
    sourceRevision,
    requirements: [...UPSTREAM_SERVICE_PUBLISHING_REQUIREMENTS],
    deploymentMode: "temporary-isolated",
    observationSchemaVersion: UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_SCHEMA_VERSION,
    observations,
    resourceBudgets: { durationMs: 10, maxDurationMs: 300_000, reportBytes: 0, maxReportBytes: 512 * 1024 }
  });
}

function mutation(base?: any, mutate?: any) : any {
  const next: any = structuredClone(base);
  mutate(next);
  return next;
}

describe("upstream service publishing evidence reducer", () : any => {
  it("accepts and independently reduces the canonical server report", () : any => {
    const report: any = validReport();
    expect(validateUpstreamServicePublishingReport(report, { expectedSourceRevision: sourceRevision }))
      .toEqual({ verificationPassed: true });
    expect(reduceUpstreamServicePublishingReport(report, { expectedSourceRevision: sourceRevision }))
      .toEqual({ verificationPassed: true });
    expect(report).not.toHaveProperty("releaseReady");
  });

  it("registers the positive server report as the canonical acceptance input", () : any => {
    const reportPath: any = "build/reports/upstream-service-publishing.json";
    expect(requiredReportSpec(reportPath)).toMatchObject({
      schemaVersion: UPSTREAM_SERVICE_PUBLISHING_REPORT_SCHEMA_VERSION,
      verifier: UPSTREAM_SERVICE_PUBLISHING_VERIFIER,
      readyFields: []
    });
    expect(createReleaseEvidenceReadiness(reportPath, validReport())).toMatchObject({
      releaseReady: true,
      coverageReady: true,
      liveStatus: "passed",
      requiredReportValidationPassed: true
    });
  });

  it("fails the acceptance reduction when detailed publishing facts are mutated", () : any => {
    const reportPath: any = "build/reports/upstream-service-publishing.json";
    const report: any = structuredClone(validReport());
    report.counters.writes += 1;
    expect(createReleaseEvidenceReadiness(reportPath, report)).toMatchObject({
      releaseReady: false,
      coverageReady: false,
      liveStatus: "failed"
    });
  });

  it("rejects caller-supplied derived summaries instead of repairing them", () : any => {
    const report: any = validReport();
    expect(() : any => finalizeUpstreamServicePublishingReport({
      schemaVersion: report.schemaVersion,
      verifier: report.verifier,
      generatedAt: report.generatedAt,
      producer: report.producer,
      commandId: report.commandId,
      sourceRevision: report.sourceRevision,
      requirements: report.requirements,
      deploymentMode: report.deploymentMode,
      observationSchemaVersion: report.observationSchemaVersion,
      observations: report.observations,
      resourceBudgets: report.resourceBudgets,
      summary: { ...report.summary, verificationPassed: false }
    })).toThrow();
  });

  it.each([
    ["unknown schema", (report?: any) : any => { report.schemaVersion = "unknown"; }],
    ["missing assertion", (report?: any) : any => { report.assertions.pop(); }],
    ["duplicate assertion", (report?: any) : any => { report.assertions[1] = structuredClone(report.assertions[0]); }],
    ["failed assertion", (report?: any) : any => { report.assertions[0].passed = false; }],
    ["forged summary", (report?: any) : any => { report.summary.passedCount -= 1; }],
    ["forged counter", (report?: any) : any => { report.counters.writes += 1; }],
    ["negative counter", (report?: any) : any => { report.scenarios[0].counters.writes = -1; }],
    ["broken revision", (report?: any) : any => { report.revisionEdges[0].to = report.revisionEdges[0].from; }],
    ["duplicate revision scenario", (report?: any) : any => { report.revisionEdges[1].scenario = report.revisionEdges[0].scenario; }],
    ["stale source", (report?: any) : any => { report.sourceRevision = `sha256:${"b".repeat(64)}`; }],
    ["unknown top field", (report?: any) : any => { report.clientEvidence = {}; }],
    ["unknown nested field", (report?: any) : any => { report.assertions[0].detail = "not allowed"; }],
    ["client-owned dependency", (report?: any) : any => { report.clientReceipt = "not allowed"; }],
    ["prohibited local data", (report?: any) : any => { report.runtimePath = "/private/example"; }],
    ["duration over budget", (report?: any) : any => { report.resourceBudgets.durationMs = 300_001; }],
    ["payload digest mismatch", (report?: any) : any => { report.generatedAt = new Date(Date.now() - 1_000).toISOString(); }]
  ])("rejects %s", (_label?: any, mutate?: any) : any => {
    const report: any = mutation(validReport(), mutate);
    expect(() : any => validateUpstreamServicePublishingReport(report, { expectedSourceRevision: sourceRevision }))
      .toThrow();
  });
});
