#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_HA_DISCIPLINE } from "../../packages/foundation/src/scale/m7-ha-discipline.ts";
import {
  createAcceptedReport,
  createBlockedReport,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-ha-report.ts";
import { spawnFreshChild } from "./lib/m7-ha-verification.ts";

const repoRoot: any = resolveRepoRoot();
const reportPath: any = M7_HA_DISCIPLINE.reports.fault.path;
const childEntry: any = M7_HA_DISCIPLINE.reports.fault.childEntry;

async function main() : Promise<any> {
  const childResult: any = await spawnFreshChild(childEntry);
  if (childResult.exitCode !== 0 || childResult.childReport?.accepted !== true) {
    const report: any = createBlockedReport({
      kind: "fault",
      reasonCode: "fault_verification_failed",
      message: "HA fault child verification did not pass in a fresh process.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const report: any = createAcceptedReport({
    kind: "fault",
    summary: {
      childExitCode: childResult.exitCode,
      childPid: childResult.childPid,
      circuitOpened: childResult.childReport.summary?.circuitOpened === true,
      circuitRecovered: childResult.childReport.summary?.circuitRecovered === true,
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-ha-fault] accepted=true circuitRecovered=true");
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
    console.error(`[m7-ha-fault] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7HaFault };
