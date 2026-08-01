#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoLeak } from "./lib/report-evidence-safety.ts";
import {
  DEFAULT_REGISTRY_PATH,
  loadReleaseAuthorityBaselineRegistry,
  validateReleaseAuthorityBaselineFindings
} from "../verifiers/registry-release-authority-baseline.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportPath: any = path.join(repoRoot, "build", "reports", "release-authority-baseline.json");

const { registryPath, data } = await loadReleaseAuthorityBaselineRegistry({ rootDir: repoRoot });
const { findings, coverage, inventory } = await validateReleaseAuthorityBaselineFindings(data, {
  rootDir: repoRoot,
  registryPath
});

const releaseReady: any = findings.length === 0;
const report: Record<string, any> = {
  schemaVersion: "v0.0.1:release:authority-baseline-report-1",
  verifier: "tools/server-scripts/verify-release-authority-baseline.ts",
  generatedAt: new Date().toISOString(),
  sourceOfTruth: DEFAULT_REGISTRY_PATH,
  summary: {
    releaseReady,
    reportLeakScan: true,
    findingCount: findings.length,
    commandCount: coverage?.commands?.length || 0,
    reportCount: coverage?.reports?.length || 0,
    capabilityCount: coverage?.capabilities?.length || 0,
    checkpointCount: coverage?.checkpoints?.length || 0,
    reducerInputCount: coverage?.reducerInputs?.length || 0,
    requiredReportSpecCount: coverage?.requiredReportSpecs?.length || 0,
    generatedProjectionCount: coverage?.generatedProjections?.length || 0,
    sourceAuthorityCount: coverage?.sourceAuthorities?.length || 0,
    retainedInventoryCount: inventory?.retainedPositiveForwardingIds?.length || 0,
    removeLaterInventoryCount: inventory?.removeLaterIds?.length || 0
  },
  coverage,
  inventory,
  findings
};

assertNoLeak(JSON.stringify(report));
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (!releaseReady) {
  console.error(`release-authority-baseline: ${findings.length} finding(s)`);
  for (const finding of findings.slice(0, 20)) {
    console.error(`- ${finding.kind}: ${finding.detail}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `release-authority-baseline: ok commands=${report.summary.commandCount} reports=${report.summary.reportCount} capabilities=${report.summary.capabilityCount} authorities=${report.summary.sourceAuthorityCount}`
  );
}
