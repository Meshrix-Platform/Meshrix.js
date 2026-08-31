#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNativeOrbBootstrapArgs } from "./lib/native-orb-bootstrap/contract.ts";
import { bootstrapNativeOrb } from "./lib/native-orb-bootstrap/runner.ts";

export { NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS } from "./lib/native-orb-bootstrap/catalog.ts";
export { parseNativeOrbBootstrapArgs } from "./lib/native-orb-bootstrap/contract.ts";
export {
  bootstrapNativeOrb,
  loadNativeOrbBootstrapStageScript,
  runNativeOrbBootstrapStageScripts,
} from "./lib/native-orb-bootstrap/runner.ts";
export {
  assertBootstrapCleanupState,
  assertRuntimeEngineCompatible,
  BOOTSTRAP_SECRET_PROVISION_SCRIPT,
  BOOTSTRAP_REQUIRED_PACKAGES,
  buildBootstrapRuntimeConfig,
  buildBootstrapSystemdUnit,
  createPrivateBootstrapStagingDirectory,
  deriveBootstrapLayout,
  loadPrivateBootstrapCredentialBytes,
  validateCandidateRuntimeLock,
} from "./lib/native-orb-bootstrap/support.ts";
export {
  assertBootstrapUnitResumeState,
  parseBootstrapTargetFacts,
} from "./lib/native-orb-bootstrap/stages/target.ts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed: any;
  try {
    parsed = parseNativeOrbBootstrapArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "native_orb_bootstrap_argument_invalid" })}\n`);
    process.exitCode = 1;
  }
  if (parsed) {
    bootstrapNativeOrb(parsed).then((result?: any) : any => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error?: any) : any => {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "native_orb_bootstrap_failed" })}\n`);
      process.exitCode = 1;
    });
  }
}
