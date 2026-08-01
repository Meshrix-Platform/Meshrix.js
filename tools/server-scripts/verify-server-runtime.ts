#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  npmScript,
  runRegressionCommandGroup
} from "./lib/server-regression-command-runner.ts";

export const SERVER_VERIFY_COMMANDS: readonly any[] = Object.freeze([
  npmScript("script-registry", "server:verify:script-registry"),
  npmScript("registry", "verify:registry"),
  npmScript("public-boundary", "server:verify:public-boundary"),
  npmScript("security-hardening", "server:verify:security-hardening"),
  npmScript("strategy-management", "server:verify:strategy-management"),
  npmScript("agent-gateway", "server:verify:agent-gateway"),
  npmScript("model-routing", "server:verify:model-routing"),
  npmScript("agent-management", "server:verify:agent-management"),
  npmScript("maintenance-agent", "server:verify:maintenance-agent"),
  npmScript("deployment-flow", "server:verify:deployment-flow"),
  npmScript("deployment-index", "server:verify:deployment-index")
]);

export async function main(argv: any = process.argv.slice(2)) : Promise<any> {
  return runRegressionCommandGroup({
    argv,
    commands: SERVER_VERIFY_COMMANDS,
    groupId: "server-verify",
    reportPath: "build/reports/server-runtime-verification.json",
    schemaVersion: "v0.0.1:meshrix:server-runtime-verification-report-1",
    verifier: "tools/server-scripts/verify-server-runtime.ts",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode: any = await main();
  process.exit(exitCode);
}
