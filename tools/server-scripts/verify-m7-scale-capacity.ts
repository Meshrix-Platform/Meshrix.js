#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_SCALE_DISCIPLINE } from "../../packages/foundation/src/scale/m7-scale-discipline.ts";
import {
  createAcceptedReport,
  createBlockedReport,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-scale-report.ts";
import { spawnFreshChild } from "./lib/m7-scale-verification.ts";

const repoRoot: any = resolveRepoRoot();
const reportPath: any = M7_SCALE_DISCIPLINE.reports.capacity.path;
const childEntry: any = M7_SCALE_DISCIPLINE.reports.capacity.childEntry;

async function main() : Promise<any> {
  const childResult: any = await spawnFreshChild(childEntry);
  if (childResult.exitCode !== 0 || childResult.childReport?.accepted !== true) {
    const report: any = createBlockedReport({
      kind: "capacity",
      reasonCode: "capacity_verification_failed",
      message: "Scale capacity child verification did not pass in a fresh process.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const report: any = createAcceptedReport({
    kind: "capacity",
    summary: {
      childExitCode: childResult.exitCode,
      childPid: childResult.childPid,
      releaseReady: childResult.childReport.capacityReport?.verificationPassed === true,
      replayPassed: childResult.childReport.capacityReport?.replayPassed === true,
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-scale-capacity] accepted=true releaseReady=true");
}

const invokedDirectly: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (error?: any) : Promise<any> => {
    const report: any = createBlockedReport({
      kind: "capacity",
      reasonCode: "capacity_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeReportAtomically(repoRoot, reportPath, report).catch(() : any => undefined);
    console.error(`[m7-scale-capacity] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7ScaleCapacity };
