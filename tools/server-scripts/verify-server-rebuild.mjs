#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  nodeScript,
  npmScript,
  runRegressionCommandGroup
} from "./lib/server-regression-command-runner.mjs";

export const SERVER_REBUILD_VERIFY_COMMANDS = Object.freeze([
  nodeScript("job-work-queue", "tools/server-scripts/verify-job-work-queue.mjs"),
  nodeScript("work-queue-conformance", "tools/server-scripts/verify-work-queue-conformance.mjs"),
  nodeScript("tag-management", "tools/server-scripts/verify-tag-management.mjs"),
  npmScript("operation-permission-universal-tag-policy", "verify:operation-permission-universal-tag-policy")
]);

export async function main(argv = process.argv.slice(2)) {
  return runRegressionCommandGroup({
    argv,
    commands: SERVER_REBUILD_VERIFY_COMMANDS,
    groupId: "server-verify-rebuild",
    reportPath: "build/reports/server-rebuild-verification.json",
    verifier: "tools/server-scripts/verify-server-rebuild.mjs"
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
