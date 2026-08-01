#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_REGIONAL_DR_DISCIPLINE } from "../../packages/foundation/src/scale/m7-regional-dr-discipline.ts";
import {
  createAcceptedReport,
  createBlockedReport,
  readJson,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-regional-dr-report.ts";
import { createStorageProductionRestoreReadiness } from "./lib/storage-production-restore-evidence.ts";

const repoRoot: any = resolveRepoRoot();
const reportPath: any = M7_REGIONAL_DR_DISCIPLINE.reports.fault.path;
const drillVerifier: any = path.join(repoRoot, "tools/server-scripts/verify-storage-production-restore-drill.ts");
const drillReportPath: any = "build/reports/storage-production-restore-drill/latest.json";

async function main() : Promise<any> {
  const child: any = spawnSync(process.execPath, [drillVerifier], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    env: process.env,
  });
  if (child.status !== 0) {
    const report: any = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_verification_failed",
      message: "Storage production restore drill did not pass in the fresh fault process.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const drillReport: any = await readJson(path.join(repoRoot, drillReportPath));
  const restoreReadiness: any = createStorageProductionRestoreReadiness(drillReport);
  if (restoreReadiness.releaseReady !== true) {
    const report: any = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_profile_not_ready",
      message: "Regional-DR fault profile requires a passing storage restore drill.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const report: any = createAcceptedReport({
    kind: "fault",
    summary: {
      restoreDrillReady: true,
      upstreamReport: drillReportPath,
      upstreamReadinessSource: restoreReadiness.sourceOfTruth,
      childExitCode: child.status,
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-regional-dr-fault] accepted=true restoreDrillReady=true");
}

const invokedDirectly: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (error?: any) : Promise<any> => {
    const report: any = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeReportAtomically(repoRoot, reportPath, report).catch(() : any => undefined);
    console.error(`[m7-regional-dr-fault] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7RegionalDrFault };
