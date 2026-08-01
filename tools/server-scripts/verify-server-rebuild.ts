#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  nodeScript,
  npmScript,
  runRegressionCommandGroup
} from "./lib/server-regression-command-runner.ts";

export const SERVER_REBUILD_VERIFY_COMMANDS: readonly any[] = Object.freeze([
  nodeScript("job-work-queue", "tools/server-scripts/verify-job-work-queue.ts"),
  nodeScript("work-queue-conformance", "tools/server-scripts/verify-work-queue-conformance.ts"),
  nodeScript("tag-management", "tools/server-scripts/verify-tag-management.ts"),
  npmScript("operation-permission-universal-tag-policy", "verify:operation-permission-universal-tag-policy")
]);

export async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  return runRegressionCommandGroup({
    argv,
    commands: SERVER_REBUILD_VERIFY_COMMANDS,
    groupId: "server-verify-rebuild",
    reportPath: "build/reports/server-rebuild-verification.json",
    verifier: "tools/server-scripts/verify-server-rebuild.ts"
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode: any = await main();
  process.exit(exitCode);
}
