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
} from "../../../tools/server-scripts/lib/upstream-service-publishing-evidence.mjs";
import { createReleaseEvidenceReadiness } from "../../../tools/server-scripts/lib/release-evidence-readiness.mjs";
import { requiredReportSpec } from "../../../tools/server-scripts/lib/required-report-validator.mjs";

const sourceRevision = `sha256:${"a".repeat(64)}`;
function validReport() {
  const observations = structuredClone(UPSTREAM_SERVICE_PUBLISHING_OBSERVATION_EVENTS);
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

function mutation(base, mutate) {
  const next = structuredClone(base);
  mutate(next);
  return next;
}

describe("upstream service publishing evidence reducer", () => {
  it("accepts and independently reduces the canonical server report", () => {
    const report = validReport();
    expect(validateUpstreamServicePublishingReport(report, { expectedSourceRevision: sourceRevision }))
      .toEqual({ verificationPassed: true });
    expect(reduceUpstreamServicePublishingReport(report, { expectedSourceRevision: sourceRevision }))
      .toEqual({ verificationPassed: true });
    expect(report).not.toHaveProperty("releaseReady");
  });

  it("registers the positive server report as the canonical acceptance input", () => {
    const reportPath = "build/reports/upstream-service-publishing.json";
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

  it("fails the acceptance reduction when detailed publishing facts are mutated", () => {
    const reportPath = "build/reports/upstream-service-publishing.json";
    const report = structuredClone(validReport());
    report.counters.writes += 1;
    expect(createReleaseEvidenceReadiness(reportPath, report)).toMatchObject({
      releaseReady: false,
      coverageReady: false,
      liveStatus: "failed"
    });
  });

  it("rejects caller-supplied derived summaries instead of repairing them", () => {
    const report = validReport();
    expect(() => finalizeUpstreamServicePublishingReport({
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
    ["unknown schema", (report) => { report.schemaVersion = "unknown"; }],
    ["missing assertion", (report) => { report.assertions.pop(); }],
    ["duplicate assertion", (report) => { report.assertions[1] = structuredClone(report.assertions[0]); }],
    ["failed assertion", (report) => { report.assertions[0].passed = false; }],
    ["forged summary", (report) => { report.summary.passedCount -= 1; }],
    ["forged counter", (report) => { report.counters.writes += 1; }],
    ["negative counter", (report) => { report.scenarios[0].counters.writes = -1; }],
    ["broken revision", (report) => { report.revisionEdges[0].to = report.revisionEdges[0].from; }],
    ["duplicate revision scenario", (report) => { report.revisionEdges[1].scenario = report.revisionEdges[0].scenario; }],
    ["stale source", (report) => { report.sourceRevision = `sha256:${"b".repeat(64)}`; }],
    ["unknown top field", (report) => { report.clientEvidence = {}; }],
    ["unknown nested field", (report) => { report.assertions[0].detail = "not allowed"; }],
    ["client-owned dependency", (report) => { report.clientReceipt = "not allowed"; }],
    ["prohibited local data", (report) => { report.runtimePath = "/private/example"; }],
    ["duration over budget", (report) => { report.resourceBudgets.durationMs = 300_001; }],
    ["payload digest mismatch", (report) => { report.generatedAt = new Date(Date.now() - 1_000).toISOString(); }]
  ])("rejects %s", (_label, mutate) => {
    const report = mutation(validReport(), mutate);
    expect(() => validateUpstreamServicePublishingReport(report, { expectedSourceRevision: sourceRevision }))
      .toThrow();
  });
});
