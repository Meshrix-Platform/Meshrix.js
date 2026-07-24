#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PRIVATE_DEPLOYMENT_REQUIRED_REPORTS
} from "./lib/platform-acceptance-command-catalog.mjs";
import {
  PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH
} from "./lib/private-deployment-open-platform-e2e-catalog.mjs";
import {
  createReleaseEvidenceReadiness
} from "./lib/release-evidence-readiness.mjs";
import {
  createReportFreshnessEvidence,
  readJsonReportWithStats
} from "./lib/release-evidence-freshness.mjs";
import { liveReadinessExitCode } from "./lib/live-readiness-exit-code.mjs";
import {
  SENSITIVE_REPORT_PATTERNS,
  redactReportText
} from "./lib/sensitive-report-scan.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REPORT_PATH = PRIVATE_DEPLOYMENT_OPEN_PLATFORM_E2E_REPORT_PATH;
const dynamicRedactionNeedles = new Set([repoRoot, os.homedir()].filter(Boolean));

function redactText(value = "") {
  return redactReportText(value, { dynamicNeedles: dynamicRedactionNeedles });
}

function assertNoLeak(value, label) {
  const text = redactText(JSON.stringify(value));
  for (const [kind, pattern] of SENSITIVE_REPORT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`${label} contains sensitive local or runtime data: ${kind}`);
    }
  }
}

function reportNativeLeakScan(report = {}) {
  return report.summary?.reportLeakScan === true || report.reportLeakScan === true;
}

async function loadRequiredReports(root, minimumTimestampMs) {
  const reports = {};
  const freshnessByPath = {};
  for (const reportPath of PRIVATE_DEPLOYMENT_REQUIRED_REPORTS) {
    const { report, stats } = await readJsonReportWithStats(root, reportPath);
    assertNoLeak(report, reportPath);
    reports[reportPath] = report;
    freshnessByPath[reportPath] = createReportFreshnessEvidence(reportPath, report, stats, {
      notBeforeMs: minimumTimestampMs
    });
  }
  return { reports, freshnessByPath };
}

export async function reduceExistingReports({
  root = repoRoot,
  startedAtMs = Number(process.env.MESHRIX_ACCEPTANCE_STARTED_AT_MS || Date.now()),
  setExitCode = true,
  log = true
} = {}) {
  const startedAt = new Date(startedAtMs);
  const missingEvidence = [];
  let reports = {};
  let freshnessByPath = {};
  let readinessByPath = {};

  try {
    ({ reports, freshnessByPath } = await loadRequiredReports(root, startedAtMs));
    readinessByPath = Object.fromEntries(
      Object.entries(reports).map(([reportPath, report]) => [
        reportPath,
        createReleaseEvidenceReadiness(reportPath, report, {
          minimumTimestampMs: startedAtMs
        })
      ])
    );
    for (const [reportPath, freshness] of Object.entries(freshnessByPath)) {
      if (freshness.fresh !== true) missingEvidence.push(`report-stale:${reportPath}`);
    }
    for (const [reportPath, readiness] of Object.entries(readinessByPath)) {
      if (readiness.releaseReady !== true) missingEvidence.push(`report-not-ready:${reportPath}`);
    }
  } catch (error) {
    missingEvidence.push(`report-load:${redactText(error?.message || error)}`);
  }

  const finishedAt = new Date();
  const releaseReady = missingEvidence.length === 0 &&
    Object.keys(reports).length === PRIVATE_DEPLOYMENT_REQUIRED_REPORTS.length;
  const reportLeakScan = Object.keys(reports).length === PRIVATE_DEPLOYMENT_REQUIRED_REPORTS.length;
  const report = {
    schemaVersion: "v0.0.1:deployment:private-open-platform-e2e-report-1",
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    verifier: "tools/server-scripts/verify-private-deployment-open-platform-e2e.mjs",
    status: releaseReady ? "accepted" : "blocked",
    algorithm: {
      commandExecutionMode: "platform-acceptance-existing-evidence-reduction",
      evidenceReduction: "Reduce only reports produced by canonical platform-acceptance command owners."
    },
    reportFreshnessEvidence: freshnessByPath,
    reportEvidence: Object.fromEntries(
      Object.entries(readinessByPath).map(([reportPath, readiness]) => [
        reportPath,
        {
          validationPassed: readiness.requiredReportValidationPassed === true,
          releaseReady: readiness.releaseReady === true,
          reportLeakScan: readiness.reportLeakScan === true || reportNativeLeakScan(reports[reportPath]),
          reasons: readiness.reasons || []
        }
      ])
    ),
    summary: {
      commandCount: 0,
      failedCommandCount: 0,
      deploymentFailedCommandCount: 0,
      missingEvidenceCount: missingEvidence.length,
      deploymentMissingEvidenceCount: missingEvidence.length,
      missingEvidence,
      requiredReportCount: PRIVATE_DEPLOYMENT_REQUIRED_REPORTS.length,
      deploymentE2eReady: releaseReady,
      deploymentCoverageReady: releaseReady,
      coverageReady: releaseReady,
      releaseReady,
      reportLeakScan
    }
  };
  assertNoLeak(report, "private deployment evidence reduction report");
  const outputPath = path.join(root, ...REPORT_PATH.split("/"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (log) {
    console.log(
      `[private-open-platform-e2e] reduction releaseReady=${releaseReady} missingEvidence=${missingEvidence.length} report=${REPORT_PATH}`
    );
  }
  if (setExitCode) {
    process.exitCode = liveReadinessExitCode({
      releaseReady: report.summary.releaseReady === true,
      liveStatus: report.status === "blocked" ? "blocked" : "failed"
    });
  }
  return report;
}

async function main() {
  await reduceExistingReports();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[private-open-platform-e2e] failed: ${redactText(error?.message || error)}`);
    process.exitCode = 1;
  });
}
