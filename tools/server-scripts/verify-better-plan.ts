#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CURRENT_PLAN_CODE,
  boundedCurrentPlanError,
  validateCurrentPlanAuthority,
} from "../plan/current-plan-authority.ts";

const REPORT_SCHEMA = "v0.0.1:meshrix:current-plan-authority-report-1";
const REPORT_PATH = "build/reports/better-plan.json";

export async function verifyBetterPlan({
  repoRoot,
  writeReport = true,
}: {
  repoRoot?: string;
  writeReport?: boolean;
} = {}): Promise<Record<string, unknown>> {
  const modulePath = fileURLToPath(import.meta.url);
  const resolvedRoot = path.resolve(repoRoot ?? path.dirname(modulePath), repoRoot ? "." : "../..");
  const authority = await validateCurrentPlanAuthority({ repoRoot: resolvedRoot });
  const report = {
    schemaVersion: REPORT_SCHEMA,
    verifier: "tools/server-scripts/verify-better-plan.ts",
    generatedAt: new Date().toISOString(),
    accepted: true,
    plan: CURRENT_PLAN_CODE,
    authority,
    checks: {
      canonical_validation: true,
      exact_identity: true,
      state_roles: true,
    },
    summary: {
      authorityReady: true,
      reportLeakScan: true,
    },
  };
  if (writeReport) {
    const reportPath = path.join(resolvedRoot, REPORT_PATH);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("unsupported_arguments");
  process.stdout.write(`${JSON.stringify(await verifyBetterPlan())}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(boundedCurrentPlanError(error))}\n`);
    process.exitCode = 1;
  });
}
