#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { M7_REGIONAL_DR_DISCIPLINE } from "../../packages/foundation/src/scale/m7-regional-dr-discipline.mjs";
import {
  createAcceptedReport,
  createBlockedReport,
  loadDeclaredEnvironmentReceipt,
  resolveRepoRoot,
  writeReportAtomically,
} from "./lib/m7-regional-dr-report.mjs";

const repoRoot = resolveRepoRoot();
const reportPath = M7_REGIONAL_DR_DISCIPLINE.reports.capacity.path;

async function main() {
  const environment = await loadDeclaredEnvironmentReceipt(repoRoot);
  if (!environment.accepted) {
    const report = createBlockedReport({
      kind: "capacity",
      reasonCode: environment.reasonCode,
      message: environment.message,
    });
    await writeReportAtomically(repoRoot, reportPath, report);
    console.error(`[m7-regional-dr-capacity] blocked reasonCode=${environment.reasonCode}`);
    process.exitCode = 1;
    return;
  }

  const report = createAcceptedReport({
    kind: "capacity",
    summary: {
      environmentClassification: environment.receipt.classification,
      environmentReceipt: environment.receiptPath,
      capacityCertified: false,
      note: "Declared-environment capacity execution requires operator-provisioned regional-DR endpoints.",
    },
  });
  await writeReportAtomically(repoRoot, reportPath, report);
  console.log("[m7-regional-dr-capacity] accepted=false capacity driver not yet bound to declared endpoints");
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (error) => {
    const report = createBlockedReport({
      kind: "capacity",
      reasonCode: "capacity_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await writeReportAtomically(repoRoot, reportPath, report).catch(() => undefined);
    console.error(`[m7-regional-dr-capacity] failed reasonCode=${report.summary.reasonCode}`);
    process.exitCode = 1;
  });
}

export { main as verifyM7RegionalDrCapacity };
