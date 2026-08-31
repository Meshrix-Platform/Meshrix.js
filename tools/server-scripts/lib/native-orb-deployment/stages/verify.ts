import { failNativeOrbDeployment } from "../contract.ts";
import { orbText, probeNativeOrbOrigin } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  let probe: any = await probeNativeOrbOrigin(context.parsed.publicOrigin, context.privateLoginBytes);
  for (let attempt: any = 0; attempt < 30 && (
    !probe.healthOk || !probe.consoleOk || !probe.authenticationOk || !probe.governedOperationOk
  ); attempt += 1) {
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1000));
    probe = await probeNativeOrbOrigin(context.parsed.publicOrigin, context.privateLoginBytes);
  }
  if (!probe.healthOk || !probe.consoleOk || !probe.authenticationOk || !probe.governedOperationOk) {
    failNativeOrbDeployment("native_orb_verification_failed", "Native Meshrix.js instance did not become healthy.");
  }
  const activeWorkingDirectory: any = orbText(context.parsed.machine, [
    "systemctl", "--user", "show", context.unit, "-p", "WorkingDirectory", "--value",
  ], {});
  if (activeWorkingDirectory !== context.releaseDirectory) {
    failNativeOrbDeployment("native_orb_candidate_activation_mismatch", "Native service did not activate the current candidate.");
  }
  const serviceActive: any = orbText(context.parsed.machine, [
    "systemctl", "--user", "is-active", context.unit,
  ], { allowFailure: true }) === "active";
  if (!serviceActive) {
    failNativeOrbDeployment("native_orb_service_inactive", "Native service is not active after verification.");
  }
  context.probe = Object.freeze({ ...probe, candidateActive: true, serviceActive: true });
  return Object.freeze({ id: "verify", status: "completed" });
}
