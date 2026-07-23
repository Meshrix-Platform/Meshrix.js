#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_REGIONAL_DR_DISCIPLINE } from "../../packages/foundation/src/scale/m7-regional-dr-discipline.mjs";
import {
  createAcceptedReport,
  createBlockedReport,
  readJson,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-regional-dr-report.mjs";

const repoRoot = resolveRepoRoot();
const reportPath = M7_REGIONAL_DR_DISCIPLINE.reports.fault.path;
const drillVerifier = path.join(repoRoot, "tools/server-scripts/verify-storage-production-restore-drill.mjs");
const drillReportPath = "build/reports/storage-production-restore-drill/latest.json";

async function main() {
  const child = spawnSync(process.execPath, [drillVerifier], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    env: process.env,
  });
  if (child.status !== 0) {
    const report = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_verification_failed",
      message: "Storage production restore drill did not pass in the fresh fault process.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const drillReport = await readJson(path.join(repoRoot, drillReportPath));
  const restoreReady = drillReport?.summary?.restoreDrillReady === true;
  if (!restoreReady) {
    const report = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_profile_not_ready",
      message: "Regional-DR fault profile requires a passing storage restore drill.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const report = createAcceptedReport({
    kind: "fault",
    summary: {
      restoreDrillReady: true,
      upstreamReport: drillReportPath,
      childExitCode: child.status,
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-regional-dr-fault] accepted=true restoreDrillReady=true");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (error) => {
    const report = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeReportAtomically(repoRoot, reportPath, report).catch(() => undefined);
    console.error(`[m7-regional-dr-fault] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7RegionalDrFault };
