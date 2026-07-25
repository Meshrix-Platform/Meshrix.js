#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_SCALE_DISCIPLINE } from "../../packages/foundation/src/scale/m7-scale-discipline.mjs";
import {
  createAcceptedReport,
  createBlockedReport,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-scale-report.mjs";
import { spawnFreshChild } from "./lib/m7-scale-verification.mjs";

const repoRoot = resolveRepoRoot();
const reportPath = M7_SCALE_DISCIPLINE.reports.memory.path;
const childEntry = M7_SCALE_DISCIPLINE.reports.memory.childEntry;

async function main() {
  const childResult = await spawnFreshChild(childEntry);
  if (childResult.exitCode !== 0 || childResult.childReport?.accepted !== true) {
    const report = createBlockedReport({
      kind: "memory",
      reasonCode: "memory_verification_failed",
      message: "Scale memory child verification did not pass in a fresh process.",
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    process.exitCode = 1;
    return;
  }

  const report = createAcceptedReport({
    kind: "memory",
    summary: {
      childExitCode: childResult.exitCode,
      childPid: childResult.childPid,
      rssIncreaseBytes: childResult.childReport.summary?.rssIncreaseBytes ?? null,
      rssBudgetBytes: childResult.childReport.summary?.rssBudgetBytes ?? null,
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-scale-memory] accepted=true");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (error) => {
    const report = createBlockedReport({
      kind: "memory",
      reasonCode: "memory_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeReportAtomically(repoRoot, reportPath, report).catch(() => undefined);
    console.error(`[m7-scale-memory] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7ScaleMemory };
