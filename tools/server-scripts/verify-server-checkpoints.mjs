#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  nodeScript,
  runRegressionCommandGroup
} from "./lib/server-regression-command-runner.mjs";

export const SERVER_CHECKPOINTS_VERIFY_COMMANDS = Object.freeze([
  nodeScript("workspace-file-ops", "tools/server-scripts/verify-workspace-file-ops.mjs"),
  nodeScript("workspace-checkpoint-protocol", "tools/server-scripts/verify-workspace-checkpoint-protocol.mjs")
]);

export async function main(argv = process.argv.slice(2)) {
  return runRegressionCommandGroup({
    argv,
    commands: SERVER_CHECKPOINTS_VERIFY_COMMANDS,
    groupId: "server-verify-checkpoints",
    reportPath: "build/reports/server-checkpoints-verification.json",
    verifier: "tools/server-scripts/verify-server-checkpoints.mjs"
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
