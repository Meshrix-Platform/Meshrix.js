import {
  BOOTSTRAP_SECRET_PROVISION_SCRIPT,
  buildBootstrapRuntimeConfig,
  buildBootstrapSystemdUnit,
} from "../support.ts";
import { runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const layout: any = context.layout;
  runOrb({ machine: context.parsed.machine, args: ["install", "-d", "-m", "0700", layout.dataDirectory, layout.configRoot, layout.secretRoot], timeout: 30_000 });
  const secretsReady: any = runOrb({
    machine: context.parsed.machine,
    args: [context.nodeExecutable, "-e", BOOTSTRAP_SECRET_PROVISION_SCRIPT, layout.masterKeyPath, layout.proofSignerPath],
    allowFailure: true,
    timeout: 30_000,
  }).status === 0;
  if (!secretsReady) failNativeOrbBootstrap("native_orb_bootstrap_secret_custody_unsafe", "Production secret custody is unsafe or incomplete.");
  Object.assign(context, {
    runtimeConfigContents: buildBootstrapRuntimeConfig(context.parsed.publicOrigin),
    unitContents: buildBootstrapSystemdUnit(layout, context.nodeExecutable),
    secretsReady: true,
  });
  return Object.freeze({ id: "configure", status: "completed" });
}
