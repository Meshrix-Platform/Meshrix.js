#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deployNativeOrbCandidate } from "./lib/native-orb-deployment/runner.ts";
import { parseNativeOrbDeploymentArgs } from "./lib/native-orb-deployment/contract.ts";

export { NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS } from "./lib/native-orb-deployment/catalog.ts";
export { parseNativeOrbDeploymentArgs } from "./lib/native-orb-deployment/contract.ts";
export {
  deployNativeOrbCandidate,
  loadNativeOrbDeploymentStageScript,
  runNativeOrbDeploymentStageScripts,
} from "./lib/native-orb-deployment/runner.ts";
export { resolveServiceNodeExecutable } from "./lib/native-orb-deployment/support.ts";

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let parsed: any;
  try {
    parsed = parseNativeOrbDeploymentArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "native_orb_argument_invalid" })}\n`);
    process.exitCode = 1;
  }
  if (parsed) {
    deployNativeOrbCandidate(parsed).then((result?: any) : any => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error?: any) : any => {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "native_orb_deployment_failed" })}\n`);
      process.exitCode = 1;
    });
  }
}
