#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  nodeScript,
  npmScript,
  runRegressionCommandGroup
} from "./lib/server-regression-command-runner.mjs";

export const SERVER_OPS_VERIFY_COMMANDS = Object.freeze([
  nodeScript("backup-restore", "tools/server-scripts/verify-backup-restore.mjs"),
  nodeScript("storage-production-restore-drill", "tools/server-scripts/verify-storage-production-restore-drill.mjs"),
  nodeScript("job-work-queue", "tools/server-scripts/verify-job-work-queue.mjs"),
  nodeScript("work-queue-conformance", "tools/server-scripts/verify-work-queue-conformance.mjs"),
  npmScript("deployment-index", "server:verify:deployment-index")
]);

export async function main(argv = process.argv.slice(2)) {
  return runRegressionCommandGroup({
    argv,
    commands: SERVER_OPS_VERIFY_COMMANDS,
    groupId: "server-verify-ops",
    reportPath: "build/reports/server-ops-verification.json",
    verifier: "tools/server-scripts/verify-server-ops.mjs"
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
