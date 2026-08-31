import { bootstrapOrbText, probeBootstrapOrigin } from "../support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  let probe: any = null;
  for (let attempt: any = 0; attempt < 30; attempt += 1) {
    try { probe = await probeBootstrapOrigin(context.parsed.publicOrigin, context.ownerCredentialBytes); } catch { probe = null; }
    if (probe?.health === "healthy" && probe?.console === "available" && probe?.authentication === "authenticated" && probe?.governedRead === "authorized") break;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 1000));
  }
  const machine: any = context.parsed.machine;
  const serviceActive: any = bootstrapOrbText(machine, ["systemctl", "--user", "is-active", "meshrix-js.service"], { allowFailure: true, timeout: 15_000 }) === "active";
  const serviceEnabled: any = bootstrapOrbText(machine, ["systemctl", "--user", "is-enabled", "meshrix-js.service"], { allowFailure: true, timeout: 15_000 }) === "enabled";
  const activeDirectory: any = bootstrapOrbText(machine, ["systemctl", "--user", "show", "meshrix-js.service", "-p", "WorkingDirectory", "--value"], { allowFailure: true, timeout: 15_000 });
  const activeRevision: any = bootstrapOrbText(machine, ["cat", context.layout.sourceMarkerPath], { allowFailure: true, timeout: 15_000 });
  const candidateActive: any = activeDirectory === context.layout.currentDirectory && activeRevision === context.sourceRevision;
  if (!probe || probe.health !== "healthy" || probe.console !== "available" || probe.authentication !== "authenticated" ||
      probe.governedRead !== "authorized" || !serviceActive || !serviceEnabled || !candidateActive) {
    failNativeOrbBootstrap("native_orb_bootstrap_verification_failed", "Native Core bootstrap verification failed.");
  }
  context.probe = Object.freeze({ ...probe, serviceActive, serviceEnabled, candidateActive });
  return Object.freeze({ id: "verify", status: "completed" });
}
