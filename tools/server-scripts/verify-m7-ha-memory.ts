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
const reportPath: any = M7_HA_DISCIPLINE.reports.memory.path;
const childEntry: any = M7_HA_DISCIPLINE.reports.memory.childEntry;

async function main() : Promise<any> {
  const childResult: any = await spawnFreshChild(childEntry);
  if (childResult.exitCode !== 0 || childResult.childReport?.accepted !== true) {
    const report: any = createBlockedReport({
      kind: "memory",
      reasonCode: "memory_verification_failed",
      message: "HA memory child verification did not pass in a fresh process.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const report: any = createAcceptedReport({
    kind: "memory",
    summary: {
      childExitCode: childResult.exitCode,
      childPid: childResult.childPid,
      memoryLeakFree: true,
      rssIncreaseBytes: childResult.childReport.summary?.rssIncreaseBytes ?? null,
      rssBudgetBytes: childResult.childReport.summary?.rssBudgetBytes ?? null,
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-ha-memory] accepted=true memoryLeakFree=true");
}

const invokedDirectly: any = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (error?: any) : Promise<any> => {
    const report: any = createBlockedReport({
      kind: "memory",
      reasonCode: "memory_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeReportAtomically(repoRoot, reportPath, report).catch(() : any => undefined);
    console.error(`[m7-ha-memory] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7HaMemory };
