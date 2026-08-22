import { failNativeOrbDeployment } from "../contract.ts";
import { orbText, probeOrigin } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  let probe: any = await probeOrigin(context.parsed.publicOrigin);
  for (let attempt: any = 0; attempt < 30 && (!probe.healthOk || !probe.consoleOk); attempt += 1) {
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1000));
    probe = await probeOrigin(context.parsed.publicOrigin);
  }
  if (!probe.healthOk || !probe.consoleOk) {
    failNativeOrbDeployment("native_orb_verification_failed", "Native Meshrix.js instance did not become healthy.");
  }
  const activeWorkingDirectory: any = orbText(context.parsed.machine, [
    "systemctl", "--user", "show", context.unit, "-p", "WorkingDirectory", "--value",
  ], { timeout: 15_000 });
  if (activeWorkingDirectory !== context.originalWorkingDirectory) {
    failNativeOrbDeployment("native_orb_candidate_activation_mismatch", "Native service did not activate the current candidate.");
  }
  context.probe = probe;
  return Object.freeze({ id: "verify", status: "completed" });
}
