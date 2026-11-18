#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_REGIONAL_DR_DISCIPLINE } from "../../packages/foundation/src/scale/m7-regional-dr-discipline.ts";
import {
  createAcceptedReport,
  createBlockedReport,
  loadDeclaredEnvironmentReceipt,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-regional-dr-report.ts";

const repoRoot: any = resolveRepoRoot();
const reportPath: any = M7_REGIONAL_DR_DISCIPLINE.reports.memory.path;

async function main() : Promise<any> {
  const environment: any = await loadDeclaredEnvironmentReceipt(repoRoot);
  if (!environment.accepted) {
    const report: any = createBlockedReport({
      kind: "memory",
      reasonCode: environment.reasonCode,
      message: environment.message,
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    console.error(`[m7-regional-dr-memory] blocked reasonCode=${environment.reasonCode}`);
    process.exitCode = 1;
    return;
  }

  const report: any = createAcceptedReport({
    kind: "memory",
    summary: {
      environmentClassification: environment.receipt.classification,
      environmentReceipt: environment.receiptPath,
      memoryLeakFree: false,
      note: "Declared-environment memory gate requires operator-provisioned regional-DR service processes.",
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-regional-dr-memory] accepted=false memory gate not yet bound to declared endpoints");
  process.exitCode = 1;
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
    console.error(`[m7-regional-dr-memory] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7RegionalDrMemory };
