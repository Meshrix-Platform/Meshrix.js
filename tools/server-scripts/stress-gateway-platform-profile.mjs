#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAggregateReleaseEvidenceReadiness,
  createReleaseEvidenceReadiness
} from "./lib/release-evidence-readiness.mjs";
import {
  createReportFreshnessEvidence,
  readJsonReportWithStats
} from "./lib/release-evidence-freshness.mjs";
import {
  UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH
} from "./lib/upstream-fixture-transit-evidence.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath = path.join(repoRoot, "build", "reports", "gateway-platform-profile.json");
const reportNotBeforeMs = Number(process.env.LICO_RELEASE_EVIDENCE_NOT_BEFORE_MS || 0);
const REQUIRED_PROFILE_REPORTS = Object.freeze([
  "build/reports/mcp-gateway-load.json",
  UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH,
  "build/reports/path-abstraction-audit.json"
]);

function redactText(value = "") {
  return String(value || "")
    .split(repoRoot).join("[redacted-path]")
    .split(os.homedir()).join("[redacted-path]")
    .replace(/(?:\/Users\/|\/private\/|\/var\/folders\/)[^\s"'`]+/gu, "[redacted-path]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(?:ghp|github_pat|sk|ock)_[A-Za-z0-9._-]{8,}\b/gu, "[redacted-secret]");
}

const evidence = {};
for (const relativePath of REQUIRED_PROFILE_REPORTS) {
  try {
    const { report, stats } = await readJsonReportWithStats(repoRoot, relativePath);
    const freshness = createReportFreshnessEvidence(relativePath, report, stats, {
      notBeforeMs: reportNotBeforeMs
    });
    const readiness = createReleaseEvidenceReadiness(relativePath, report);
    evidence[relativePath] = {
      releaseReady: readiness.releaseReady === true,
      blocked: readiness.liveStatus === "blocked",
      liveStatus: readiness.liveStatus || "",
      sourceOfTruth: readiness.sourceOfTruth || "",
      reducerSourceOfTruth: readiness.reducerSourceOfTruth || readiness.sourceOfTruth || "",
      readinessReasons: readiness.reasons || [],
      freshness,
      reportLeakScan: report.summary?.reportLeakScan === true || report.reportLeakScan === true
    };
  } catch (error) {
    evidence[relativePath] = {
      releaseReady: false,
      blocked: false,
      liveStatus: "missing",
      reportLeakScan: false,
      error: redactText(error?.message || error)
    };
  }
}

const missingEvidence = Object.entries(evidence).flatMap(([relativePath, item]) => {
  const findings = [];
  if (item.freshness?.fresh !== true) findings.push(`${relativePath}:report-stale`);
  if (item.releaseReady !== true) findings.push(`${relativePath}:${item.blocked ? "blocked" : "not-ready"}`);
  if (item.reportLeakScan !== true) findings.push(`${relativePath}:report-leak-scan-not-passed`);
  return findings;
});
const commands = Object.entries(evidence).map(([relativePath, item]) => ({
  id: `consume:${relativePath}`,
  report: relativePath,
  status: item.releaseReady === true && item.freshness?.fresh === true ? "passed" : "failed",
  consumedCanonicalReport: true
}));
const failedCommands = commands.filter((command) => command.status !== "passed");
const reportLeakScanReady = Object.values(evidence).every((item) => item.reportLeakScan === true);
const aggregateReadiness = createAggregateReleaseEvidenceReadiness({
  allCommandsExecuted: commands.length === REQUIRED_PROFILE_REPORTS.length,
  failedCommandCount: failedCommands.length,
  failedCommands: failedCommands.map((command) => command.id),
  missingEvidenceCount: missingEvidence.length,
  missingEvidence,
  reportLeakScan: reportLeakScanReady
});
const report = {
  schemaVersion: "v0.0.1:gateway:platform-profile-report-1",
  generatedAt: new Date().toISOString(),
  verifier: "tools/server-scripts/stress-gateway-platform-profile.mjs",
  algorithm: {
    commandExecutionMode: "platform-acceptance-existing-evidence-reduction",
    evidenceOwnership: "Consume reports produced by canonical platform acceptance command owners."
  },
  commands,
  evidence,
  summary: {
    releaseReady: aggregateReadiness.releaseReady,
    reportLeakScan: reportLeakScanReady,
    commandCount: commands.length,
    failedCommandCount: failedCommands.length,
    failedCommands: failedCommands.map((command) => command.id),
    missingEvidenceCount: missingEvidence.length,
    missingEvidence,
    releaseReadinessSourceOfTruth: aggregateReadiness.sourceOfTruth,
    releaseReadinessReasons: aggregateReadiness.reasons,
    upstreamFixtureTransitStatus: evidence[UPSTREAM_FIXTURE_TRANSIT_REPORT_PATH]?.liveStatus || ""
  }
};

if (JSON.stringify(report).includes(repoRoot) || JSON.stringify(report).includes(os.homedir())) {
  throw new Error("Gateway platform profile report leaked a local path.");
}
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[gateway-platform-profile] releaseReady=${report.summary.releaseReady} report=build/reports/gateway-platform-profile.json`);
if (!report.summary.releaseReady) {
  process.exitCode = 1;
}
