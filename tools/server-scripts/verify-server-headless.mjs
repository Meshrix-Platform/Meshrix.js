#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  npmScript,
  runRegressionCommandGroup
} from "./lib/server-regression-command-runner.mjs";

export const SERVER_HEADLESS_VERIFY_COMMANDS = Object.freeze([
  npmScript("public-boundary", "server:verify:public-boundary"),
  npmScript("strategy-management", "server:verify:strategy-management"),
  npmScript("agent-gateway", "server:verify:agent-gateway"),
  npmScript("model-routing", "server:verify:model-routing")
]);

export async function main(argv = process.argv.slice(2)) {
  return runRegressionCommandGroup({
    argv,
    commands: SERVER_HEADLESS_VERIFY_COMMANDS,
    groupId: "server-verify-headless",
    reportPath: "build/reports/server-headless-verification.json",
    verifier: "tools/server-scripts/verify-server-headless.mjs"
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
